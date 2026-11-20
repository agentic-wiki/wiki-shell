package server

import (
	"container/list"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/agentic-wiki/wiki/bundle"
	"github.com/agentic-wiki/wiki/index"
	"github.com/agentic-wiki/wiki/parse"
)

// The editing API (the editor ADR's slice 2): a page is written block by block
// through `wiki`'s guarded writes, so an outside edit made meanwhile is merged,
// never overwritten.
//
//	GET  /api/blocks/{path}?since=  what changed since a version, by block
//	PUT  /api/blocks/{path}         save operations against a base version
//	PUT  /api/fields/{path}         set frontmatter fields, guarded per key
//	POST /api/entries               create a page, never over a file

// maxSave bounds a save's request body.
const maxSave = 2 << 20

// History limits: the last block lists kept per page, and the pages kept.
const (
	historyPerPage = 8
	historyPages   = 64
)

// history keeps the last block lists (hashes and kinds) the server served for
// each page, so `GET /api/blocks?since=` can answer with what changed instead
// of the whole page. Bounded per page and over all pages, least recently used
// first out; a version no longer kept gets the whole list.
type history struct {
	mu    sync.Mutex
	pages map[string]*list.Element
	order *list.List // most recent at the front; values are *pageHistory
}

type pageHistory struct {
	path     string
	versions []keptVersion // oldest first
}

type keptVersion struct {
	version string
	blocks  []parse.Block // hash and kind only
}

func newHistory() *history {
	return &history{pages: map[string]*list.Element{}, order: list.New()}
}

// record keeps a page's block list at a version.
func (h *history) record(path, version string, blocks []parse.Block) {
	kept := make([]parse.Block, len(blocks))
	for i, b := range blocks {
		kept[i] = parse.Block{Kind: b.Kind, Hash: b.Hash}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	el, ok := h.pages[path]
	if !ok {
		el = h.order.PushFront(&pageHistory{path: path})
		h.pages[path] = el
		if h.order.Len() > historyPages {
			oldest := h.order.Back()
			h.order.Remove(oldest)
			delete(h.pages, oldest.Value.(*pageHistory).path)
		}
	}
	h.order.MoveToFront(el)
	p := el.Value.(*pageHistory)
	for _, v := range p.versions {
		if v.version == version {
			return
		}
	}
	p.versions = append(p.versions, keptVersion{version, kept})
	if len(p.versions) > historyPerPage {
		p.versions = p.versions[len(p.versions)-historyPerPage:]
	}
}

// at returns a page's block list at a version, if it is still kept.
func (h *history) at(path, version string) ([]parse.Block, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	el, ok := h.pages[path]
	if !ok {
		return nil, false
	}
	h.order.MoveToFront(el)
	for _, v := range el.Value.(*pageHistory).versions {
		if v.version == version {
			return v.blocks, true
		}
	}
	return nil, false
}

// page is an entry as one read of its file gives it: its version, and its
// blocks. A page over parse.MaxBlocks is tooBig: it isn't kept in the history
// or diffed (a page that size would cost tens of megabytes per kept version
// and seconds per diff), its blocks aren't sent, and it opens read-only.
// editable is only the flag sent to the client.
type page struct {
	raw, version string
	blocks       []parse.Block
	tooBig       bool
	editable     bool
}

// readPage reads an entry once, and keeps the page's blocks in the history so
// a later `since` can be answered with what changed, on a read-only bind too.
func (s *Server) readPage(e *index.Entry) (page, error) {
	raw, err := e.Raw()
	if err != nil {
		return page{}, err
	}
	p := page{raw: raw, version: index.FileVersion([]byte(raw)), blocks: parse.Blocks(parse.Body(raw))}
	if len(p.blocks) > parse.MaxBlocks {
		p.blocks, p.tooBig = []parse.Block{}, true
		return p, nil
	}
	p.editable = s.editable()
	s.history.record(e.Path, p.version, p.blocks)
	return p, nil
}

// rebuilt brings the index up to date after a write that landed. A failed
// rebuild doesn't undo the write, so it is logged rather than answered as a
// failure: the watcher rebuilds again on the next change.
func (s *Server) rebuilt() {
	if err := s.RebuildAndNotify(); err != nil {
		log.Printf("rebuild after a write failed, the watcher will retry: %v", err)
	}
}

// entryAt resolves the request's {path} to an entry of the current index. A
// path is only ever a lookup key, so `..` or a dot path names nothing: `wiki`
// never indexes a dot path or a file outside the bundle.
func (s *Server) entryAt(r *http.Request) (*index.Entry, error) {
	return s.store.View().Index.Resolve("/" + strings.TrimPrefix(r.PathValue("path"), "/"))
}

// writeStatus is the status of a failed write: 422 for what `wiki` refused,
// 404 for a page gone from disk, 500 for anything else.
func writeStatus(err error) int {
	var pathErr *fs.PathError
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return http.StatusNotFound
	case errors.As(err, &pathErr):
		return http.StatusInternalServerError
	}
	return http.StatusUnprocessableEntity
}

func (s *Server) handleBlocks(w http.ResponseWriter, r *http.Request) {
	e, err := s.entryAt(r)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
		return
	}
	p, err := s.readPage(e)
	if err != nil {
		writeJSON(w, writeStatus(err), errorBody{err.Error()})
		return
	}
	since := r.URL.Query().Get("since")
	if !p.tooBig {
		if since == p.version {
			writeOps(w, p, []parse.Op{})
			return
		}
		if old, ok := s.history.at(e.Path, since); ok {
			writeOps(w, p, parse.DiffBlocks(old, p.blocks))
			return
		}
	}
	writeJSON(w, http.StatusOK, struct {
		Version  string        `json:"version"`
		Blocks   []parse.Block `json:"blocks"`
		Editable bool          `json:"editable"`
	}{p.version, nonNilBlocks(p.blocks), p.editable})
}

// writeOps answers with operations, an empty list included: a version moved by
// a field write has no block operations, and that is [], never null.
func writeOps(w http.ResponseWriter, p page, ops []parse.Op) {
	if ops == nil {
		ops = []parse.Op{}
	}
	writeJSON(w, http.StatusOK, struct {
		Version  string     `json:"version"`
		Ops      []parse.Op `json:"ops"`
		Editable bool       `json:"editable"`
	}{p.version, ops, p.editable})
}

func nonNilBlocks(bs []parse.Block) []parse.Block {
	if bs == nil {
		return []parse.Block{}
	}
	return bs
}

// saveRequest is `PUT /api/blocks`: operations against a base version, with
// that version's block hashes, so the merge needs no state here.
type saveRequest struct {
	Base       string     `json:"base"`
	BaseBlocks []string   `json:"baseBlocks"`
	Ops        []parse.Op `json:"ops"`
}

func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	var req saveRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSave)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"malformed request: " + err.Error()})
		return
	}
	e, err := s.entryAt(r)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
		return
	}
	s.editing.Lock()
	applied, err := e.ApplyBlocks(req.Base, req.BaseBlocks, req.Ops)
	s.editing.Unlock()
	if err != nil {
		writeJSON(w, writeStatus(err), errorBody{err.Error()})
		return
	}
	s.readPage(e)
	s.rebuilt()
	writeJSON(w, http.StatusOK, struct {
		Version   string           `json:"version"`
		Ops       []parse.Op       `json:"ops"`
		Conflicts []parse.Conflict `json:"conflicts"`
		Rewritten bool             `json:"rewritten"`
	}{applied.Version, applied.Ops, applied.Conflicts, applied.Rewritten})
}

// fieldsRequest is `PUT /api/fields`: fields to set and unset, each guarded by
// the value the client read (null or missing: absent).
type fieldsRequest struct {
	Set   map[string]any `json:"set"`
	Old   map[string]any `json:"old"`
	Unset []string       `json:"unset"`
}

func (s *Server) handleFields(w http.ResponseWriter, r *http.Request) {
	var req fieldsRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"malformed request: " + err.Error()})
		return
	}
	e, err := s.entryAt(r)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
		return
	}
	if reason := typeRefusal(s.store.View().Index.Bundle, req); reason != "" {
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{reason})
		return
	}
	s.editing.Lock()
	applied, err := e.SetFieldsIf(req.Old, req.Set, req.Unset)
	s.editing.Unlock()
	if err != nil {
		writeJSON(w, writeStatus(err), errorBody{err.Error()})
		return
	}
	s.readPage(e)
	s.rebuilt()
	conflicts := applied.Fields
	if conflicts == nil {
		conflicts = []index.FieldConflict{}
	}
	writeJSON(w, http.StatusOK, struct {
		Version   string                `json:"version"`
		Conflicts []index.FieldConflict `json:"conflicts"`
	}{applied.Version, conflicts})
}

// typeRefusal is why a field write would give a page a type wiki.toml's
// declared types don't hold (wiki's own rule, Bundle.KnownType), or "". A
// key wiki can't write is refused by the write itself.
func typeRefusal(b *bundle.Bundle, req fieldsRequest) string {
	if t, ok := req.Set["type"].(string); ok && !b.KnownType(t) {
		return fmt.Sprintf("type `%s` isn't one wiki.toml declares (%s): add it to `types` there, or pick one of those", t, strings.Join(b.Types, ", "))
	}
	return ""
}

// createRequest is `POST /api/entries`: a new page and its whole file.
type createRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSave)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"malformed request: " + err.Error()})
		return
	}
	s.editing.Lock()
	e, err := s.store.View().Index.Create(req.Path, []byte(req.Content))
	s.editing.Unlock()
	switch {
	case errors.Is(err, index.ErrExists):
		writeJSON(w, http.StatusConflict, errorBody{err.Error()})
		return
	case err != nil:
		writeJSON(w, writeStatus(err), errorBody{err.Error()})
		return
	}
	s.readPage(e)
	s.rebuilt()
	writeJSON(w, http.StatusCreated, map[string]string{"version": index.FileVersion([]byte(req.Content))})
}
