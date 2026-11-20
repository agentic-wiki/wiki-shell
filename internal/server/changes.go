package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/agentic-wiki/wiki-shell/internal/git"
	"github.com/agentic-wiki/wiki/index"
	"github.com/agentic-wiki/wiki/parse"
)

// The changes view's API (the changes-view ADR's slice 2): every uncommitted
// change in the bundle, its diff, a discard of a file or one hunk of it, and a
// commit of the files the user saw, each guarded by the version they saw.
//
//	GET  /api/changes          the changed files
//	GET  /api/changes/{path}   one file's diff, by block for a page, by line otherwise
//	POST /api/changes/discard  a file, or one hunk of it
//	POST /api/commit           the ticked files, each at its shown version
//	POST /api/git/push         push the branch

// maxMessage bounds a commit message.
const maxMessage = 64 << 10

// changeView is one file of `GET /api/changes`.
type changeView struct {
	Path    string      `json:"path"`
	From    string      `json:"from,omitempty"`
	Change  string      `json:"change"`
	Version string      `json:"version"`
	Kind    string      `json:"kind"`
	Title   string      `json:"title,omitempty"`
	Added   *int        `json:"added,omitempty"`
	Removed *int        `json:"removed,omitempty"`
	Size    int64       `json:"size,omitempty"`
	Mode    *modeChange `json:"mode,omitempty"`
}

// modeChange is a file's git mode at HEAD and now, when they differ: an
// execute bit set or cleared, or a file that became a symlink or stopped
// being one. A new file has no From, and shows only a mode other than 100644.
type modeChange struct {
	From string `json:"from,omitempty"`
	To   string `json:"to"`
}

// modeOf is the mode `git add` would give a file now: a symlink is 120000;
// with core.fileMode on, the owner's execute bit decides; with it off, HEAD's
// mode stays (100644 for a file HEAD hasn't).
func modeOf(c git.FileChange, fi fs.FileInfo) string {
	switch {
	case fi.Mode()&fs.ModeSymlink != 0:
		return "120000"
	case c.ExecBit && fi.Mode()&0o100 != 0, !c.ExecBit && c.HeadMode == "100755":
		return "100755"
	}
	return "100644"
}

// changedMode is what the list says about a file's mode: nil when it is as
// HEAD has it, or a new file's 100644.
func changedMode(ch changed) *modeChange {
	if ch.mode == "" || ch.mode == ch.HeadMode || ch.HeadMode == "" && ch.mode == "100644" {
		return nil
	}
	return &modeChange{From: ch.HeadMode, To: ch.mode}
}

// changed is one changed file as read now: its kind, and its version and
// bytes from a single read (a symlink's bytes are its target text).
type changed struct {
	git.FileChange
	kind    string // page | text | binary | dot | link
	version string // "" for a deleted file or a dot path
	content string
	mode    string       // as `git add` would give it: 100644, 100755 or 120000
	large   bool         // over git.MaxDiffSize: its bytes aren't kept
	size    int64        // a large file's size
	entry   *index.Entry // a page the index has: its title
}

// readChange reads a changed file once: its kind, mode and version, and its
// bytes up to git.MaxDiffSize. A larger file is streamed through the hash and
// never held. With copyTo, the bytes read also go there: the commit's copy of
// exactly what was checked. A dot path is never read, and a symlink is never
// followed.
func (s *Server) readChange(c git.FileChange, copyTo io.Writer) (changed, error) {
	ch := changed{FileChange: c}
	switch {
	case c.Dot:
		ch.kind = "dot"
		return ch, nil
	case !s.inBundle(c.Path):
		return ch, errors.New("the path leaves the bundle")
	}
	abs := filepath.Join(s.store.Dir, filepath.FromSlash(c.Path))
	fi, err := os.Lstat(abs)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		ch.kind = "text"
		if c.Binary {
			ch.kind = "binary"
		} else if strings.HasSuffix(c.Path, ".md") {
			ch.kind = "page"
		}
		return ch, nil
	case err != nil:
		return ch, err
	case fi.Mode()&fs.ModeSymlink != 0:
		target, err := os.Readlink(abs)
		if err != nil {
			return ch, err
		}
		ch.kind, ch.content, ch.mode = "link", target, modeOf(c, fi)
		ch.version = index.FileVersion([]byte(target))
		return ch, nil
	case !fi.Mode().IsRegular():
		return ch, errors.New("not a file")
	}

	f, fi, err := openRegular(abs)
	if err != nil {
		return ch, err
	}
	defer f.Close()
	ch.mode = modeOf(c, fi)
	var r io.Reader = f
	if copyTo != nil {
		r = io.TeeReader(f, copyTo)
	}
	// The first bytes: all of a small file, enough of a large one to tell
	// binary from text.
	limit := int64(git.MaxDiffSize + 1)
	if fi.Size() > git.MaxDiffSize {
		limit = 8000
	}
	head, err := io.ReadAll(io.LimitReader(r, limit))
	if err != nil {
		return ch, err
	}
	h := sha256.New()
	h.Write(head)
	ch.large = fi.Size() > git.MaxDiffSize || len(head) > git.MaxDiffSize
	if ch.large {
		if ch.size, err = io.Copy(h, r); err != nil {
			return ch, err
		}
		ch.size += int64(len(head))
	} else {
		ch.content = string(head)
	}
	ch.version = hex.EncodeToString(h.Sum(nil)[:16]) // index.FileVersion, streamed

	// A page by its path alone, so the kind, and with it the hunks, is the
	// same before and after the watcher indexes a new file.
	switch {
	case strings.HasSuffix(c.Path, ".md"):
		ch.kind = "page"
		ch.entry, _ = s.store.View().Index.Resolve("/" + c.Path) // its title, once indexed
	case c.Binary || bytes.IndexByte(head[:min(len(head), 8000)], 0) >= 0:
		ch.kind = "binary"
	default:
		ch.kind = "text"
	}
	return ch, nil
}

// openRegular opens a file for reading only if it is a regular file, checked
// on the open file itself, so nothing swapped in after an Lstat is read.
func openRegular(abs string) (*os.File, fs.FileInfo, error) {
	f, err := os.OpenFile(abs, os.O_RDONLY|openFlags, 0)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err == nil && !fi.Mode().IsRegular() {
		err = errors.New("not a regular file")
	}
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, fi, nil
}

// inBundle is the editor ADR's H-1 rule for a bundle path git listed: no `..`
// or empty segment, and its folder inside the bundle's real root.
func (s *Server) inBundle(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	root, err := filepath.EvalSymlinks(s.store.Dir)
	if err != nil {
		return false
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(filepath.Join(s.store.Dir, filepath.FromSlash(rel))))
	if err != nil {
		// A folder that no longer exists holds a deleted file; nothing is read there.
		return errors.Is(err, fs.ErrNotExist)
	}
	return dir == root || strings.HasPrefix(dir, root+string(filepath.Separator))
}

// changeList lists the bundle's changes by path. On a network bind, dot
// paths aren't listed at all.
func (s *Server) changeList(r *http.Request) (bool, map[string]git.FileChange, []git.FileChange, error) {
	repo, files, err := git.Changes(r.Context(), s.store.Dir, s.shadow)
	if err != nil {
		return repo, nil, nil, err
	}
	byPath := map[string]git.FileChange{}
	list := files[:0]
	for _, f := range files {
		if f.Dot && s.networked() {
			continue
		}
		byPath[f.Path] = f
		list = append(list, f)
	}
	return repo, byPath, list, nil
}

// listCache is what one listing keeps for the next, so a refetch costs
// little when agents have changed hundreds of pages: each page's counts, by
// path, HEAD blob and version, and each large file as read, by its stat. A
// listing keeps only what it used, so the cache never outgrows the changes.
// It feeds the list alone: a discard or a commit always reads the file again.
type listCache struct {
	mu     sync.Mutex
	counts map[countKey]counted
	large  map[statKey]changed
}

type countKey struct{ path, headBlob, version string }

type counted struct {
	added, removed int
	ok             bool // false over the block cap: no counts
}

type statKey struct {
	path  string
	size  int64
	mtime int64
	mode  fs.FileMode
}

func (s *Server) handleChanges(w http.ResponseWriter, r *http.Request) {
	repo, _, files, err := s.changeList(r)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
		return
	}
	s.lists.mu.Lock()
	defer s.lists.mu.Unlock()
	counts, large := map[countKey]counted{}, map[statKey]changed{}

	var read []changed
	var missing []string // HEAD blobs of the pages to count
	for _, f := range files {
		ch, err := s.listRead(f, large)
		if err != nil {
			continue // gone between the list and the read: the next refetch has it
		}
		read = append(read, ch)
		if ch.kind == "page" && !ch.large && !ch.Filtered {
			k := countKey{ch.Path, ch.HeadBlob, ch.version}
			if c, ok := s.lists.counts[k]; ok {
				counts[k] = c
			} else if ch.HeadBlob != "" {
				missing = append(missing, ch.HeadBlob)
			}
		}
	}
	heads, err := git.Blobs(r.Context(), s.store.Dir, missing)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
		return
	}

	views := []changeView{}
	for _, ch := range read {
		v := changeView{Path: "/" + ch.Path, Change: ch.Change, Version: ch.version, Kind: ch.kind, Mode: changedMode(ch)}
		if ch.From != "" {
			v.From = "/" + ch.From
		}
		switch {
		case ch.kind == "dot":
		case ch.large:
			v.Size = ch.size
		case ch.Filtered: // no diff: git-lfs's clean filter would run
		case ch.kind == "page":
			if ch.entry != nil {
				v.Title = ch.entry.Title()
			}
			k := countKey{ch.Path, ch.HeadBlob, ch.version}
			c, ok := counts[k]
			if !ok {
				d, fits := diffPage(heads[ch.HeadBlob], ch)
				c.added, c.removed = d.counts()
				c.ok = fits
				counts[k] = c
			}
			if c.ok {
				v.Added, v.Removed = &c.added, &c.removed
			}
		case ch.kind == "text" || ch.kind == "link":
			v.Added, v.Removed = &ch.Added, &ch.Removed
		}
		views = append(views, v)
	}
	s.lists.counts, s.lists.large = counts, large
	if !repo {
		writeJSON(w, http.StatusOK, map[string]any{"repo": false, "files": views, "outside": 0})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"repo": true, "files": views, "outside": git.Outside(s.store.Dir)})
}

// listRead is readChange for the list: a large file whose stat hasn't changed
// since the last listing isn't hashed again. Its stat goes into keep. Called
// with s.lists.mu held.
func (s *Server) listRead(c git.FileChange, keep map[statKey]changed) (changed, error) {
	if !c.Dot {
		fi, err := os.Lstat(filepath.Join(s.store.Dir, filepath.FromSlash(c.Path)))
		if err == nil && fi.Mode().IsRegular() && fi.Size() > git.MaxDiffSize {
			k := statKey{c.Path, fi.Size(), fi.ModTime().UnixNano(), fi.Mode()}
			ch, ok := s.lists.large[k]
			if ok {
				ch.FileChange, ch.mode = c, modeOf(c, fi)
			} else if ch, err = s.readChange(c, nil); err != nil {
				return ch, err
			}
			if ch.large {
				keep[k] = ch
			}
			return ch, nil
		}
	}
	return s.readChange(c, nil)
}

// fieldDiff is one changed frontmatter field: a string, a list, or null when
// absent on that side.
type fieldDiff struct {
	Key  string `json:"key"`
	From any    `json:"from"`
	To   any    `json:"to"`
}

// hunk is one discardable change of a file's diff. Its index in the list is
// what a discard names.
type hunk struct {
	Kind string `json:"kind"`          // field | blocks | move | lines
	Key  string `json:"key,omitempty"` // field
	Ops  []int  `json:"ops,omitempty"` // blocks, move: indices into blocks.ops
	At   *int   `json:"at,omitempty"`  // lines: the n-th `@@` hunk of raw
}

// pageDiffView is the block and field diff of a page: HEAD's blocks, the
// operations from them to now, and the changed fields.
type pageDiffView struct {
	Blocks struct {
		Ops  []parse.Op    `json:"ops"`
		Head []parse.Block `json:"head"`
	} `json:"blocks"`
	Fields []fieldDiff `json:"fields"`
	// Header says the header's bytes differ from HEAD's, even where no field's
	// value does (a key moved, a comment): the layout-only row.
	Header bool `json:"header,omitempty"`
}

// diffView is `GET /api/changes/{path}`.
type diffView struct {
	Version string `json:"version"`
	Raw     string `json:"raw,omitempty"`
	*pageDiffView
	Hunks []hunk `json:"hunks"`
}

// pageDiff is a page's diff from HEAD to now, by block and by field.
type pageDiff struct {
	headRaw           string
	headBody, nowBody string
	head, now         []parse.Block
	ops               []parse.Op
	fields            []fieldDiff
}

// diffPage diffs a page against HEAD's bytes (its old path's, for a rename).
// ok is false for a page over the block cap, which is diffed by line only.
func diffPage(headRaw string, ch changed) (pageDiff, bool) {
	d := pageDiff{headRaw: headRaw, headBody: parse.Body(headRaw), nowBody: parse.Body(ch.content)}
	d.head, d.now = parse.Blocks(d.headBody), parse.Blocks(d.nowBody)
	if len(d.head) > parse.MaxBlocks || len(d.now) > parse.MaxBlocks {
		return pageDiff{}, false
	}
	d.ops = parse.DiffBlocks(d.head, d.now)
	if d.ops == nil {
		d.ops = []parse.Op{}
	}
	headFields, _ := parse.Frontmatter(headRaw)
	nowFields, _ := parse.Frontmatter(ch.content)
	keys := map[string]bool{}
	for k := range headFields {
		keys[k] = true
	}
	for k := range nowFields {
		keys[k] = true
	}
	d.fields = []fieldDiff{}
	for _, k := range slices.Sorted(maps.Keys(keys)) {
		if !reflect.DeepEqual(headFields[k], nowFields[k]) {
			d.fields = append(d.fields, fieldDiff{Key: k, From: headFields[k], To: nowFields[k]})
		}
	}
	return d, true
}

// counts is the blocks added and removed, as the list shows them.
func (d pageDiff) counts() (added, removed int) {
	for _, o := range d.ops {
		switch o.Op {
		case "insert":
			added += len(o.Blocks)
		case "delete":
			removed++
		case "replace":
			added, removed = added+len(o.Blocks), removed+1
		case "move":
			added, removed = added+1, removed+1
		}
	}
	return added, removed
}

// hunks numbers a page's discardable changes, the one numbering a discard
// uses: fields first, in order; then block hunks in op order, each a maximal
// run of operations with no unchanged HEAD block between them; a move is a
// hunk of its own. A deleted page has none: it is discarded whole.
func (d pageDiff) hunks(exists bool) []hunk {
	list := []hunk{}
	if !exists {
		return list
	}
	for _, f := range d.fields {
		list = append(list, hunk{Kind: "field", Key: f.Key})
	}
	moved := map[int]bool{}
	for _, o := range d.ops {
		if o.Op == "move" {
			moved[o.At] = true
		}
	}
	// span is the HEAD blocks an operation covers: one block for a replace or
	// delete; none for an insert, which sits between After and After+1.
	span := func(o parse.Op) (lo, hi int) {
		if o.Op == "insert" {
			return o.After + 1, o.After
		}
		return o.At, o.At
	}
	last := -1 // index in list of the open block hunk
	prevHi := 0
	for i, o := range d.ops {
		if o.Op == "move" {
			list = append(list, hunk{Kind: "move", Ops: []int{i}})
			continue
		}
		lo, hi := span(o)
		joined := last >= 0
		for k := prevHi + 1; joined && k < lo; k++ {
			joined = moved[k] // an unchanged block between them ends the run
		}
		if joined {
			list[last].Ops = append(list[last].Ops, i)
		} else {
			list = append(list, hunk{Kind: "blocks", Ops: []int{i}})
			last = len(list) - 1
		}
		prevHi = hi
	}
	return list
}

// diffOf is a changed file's diff, as `GET /api/changes/{path}` answers it,
// and the page diff behind it.
func (s *Server) diffOf(r *http.Request, ch changed) (diffView, pageDiff, error) {
	v := diffView{Version: ch.version, Hunks: []hunk{}}
	if !ch.large && !ch.Filtered && !ch.Binary && ch.kind != "binary" {
		f := git.File{Path: ch.Path, From: ch.From, Content: ch.content, Mode: ch.mode, Gone: ch.Change == "deleted"}
		raw, err := git.FileDiff(r.Context(), s.store.Dir, s.shadow, f)
		if err != nil {
			return v, pageDiff{}, err
		}
		v.Raw = raw
	}
	if ch.kind == "page" && !ch.large && !ch.Filtered {
		heads, err := git.Blobs(r.Context(), s.store.Dir, []string{ch.HeadBlob})
		if err != nil {
			return v, pageDiff{}, err
		}
		if d, ok := diffPage(heads[ch.HeadBlob], ch); ok {
			v.pageDiffView = &pageDiffView{Fields: d.fields}
			// Only where HEAD has the page to compare with: a modified or
			// renamed one, never a new or deleted one.
			if ch.Change == "modified" || ch.Change == "renamed" {
				v.Header = d.headRaw[:len(d.headRaw)-len(d.headBody)] != ch.content[:len(ch.content)-len(d.nowBody)]
			}
			v.Blocks.Ops, v.Blocks.Head = d.ops, nonNilBlocks(d.head)
			v.Hunks = d.hunks(ch.Change != "deleted")
			return v, d, nil
		}
		return v, pageDiff{}, nil // over the block cap: lines to read, nothing to discard but the file
	}
	// A new or deleted file is discarded whole: a hunk of it would be all of it.
	if ch.kind == "text" && (ch.Change == "modified" || ch.Change == "renamed") {
		_, hunks := git.Hunks(v.Raw)
		for i := range hunks {
			v.Hunks = append(v.Hunks, hunk{Kind: "lines", At: &i})
		}
	}
	return v, pageDiff{}, nil
}

// bundlePath turns an API path ("/notes/a.md") into a bundle path, or "" if it
// can't name a file of the bundle.
func bundlePath(p string) string {
	rel := strings.TrimPrefix(p, "/")
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return ""
		}
	}
	return rel
}

// lookup finds a changed file by its API path: 403 for a dot path, 404 for a
// path that isn't a change.
func (s *Server) lookup(w http.ResponseWriter, r *http.Request, p string) (changed, bool) {
	rel := bundlePath(p)
	switch {
	case rel == "":
		writeJSON(w, http.StatusNotFound, errorBody{"not a changed file"})
		return changed{}, false
	case git.IsDot(rel):
		writeJSON(w, http.StatusForbidden, errorBody{"files whose name starts with a dot can hold secrets, so they aren't shown or changed here"})
		return changed{}, false
	}
	_, byPath, _, err := s.changeList(r)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
		return changed{}, false
	}
	c, ok := byPath[rel]
	if !ok {
		writeJSON(w, http.StatusNotFound, errorBody{"not a changed file"})
		return changed{}, false
	}
	ch, err := s.readChange(c, nil)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
		return changed{}, false
	}
	return ch, true
}

func (s *Server) handleChange(w http.ResponseWriter, r *http.Request) {
	ch, ok := s.lookup(w, r, r.PathValue("path"))
	if !ok {
		return
	}
	v, _, err := s.diffOf(r, ch)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// discardRequest is `POST /api/changes/discard`: a file at the version shown,
// and the hunk to undo (the whole file without one).
type discardRequest struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	Hunk    *int   `json:"hunk"`
}

func (s *Server) handleDiscard(w http.ResponseWriter, r *http.Request) {
	var req discardRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"malformed request: " + err.Error()})
		return
	}
	// A discard writes the worktree, as a git action does, and a page, as an
	// edit does: both locks, always in this order.
	s.acting.Lock()
	defer s.acting.Unlock()
	s.editing.Lock()
	defer s.editing.Unlock()
	ch, ok := s.lookup(w, r, req.Path)
	if !ok {
		return
	}
	if ch.version != req.Version {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "This file changed after you read it. Nothing was discarded.", "version": ch.version})
		return
	}
	var err error
	if req.Hunk == nil {
		err = s.discardFile(r, ch)
	} else {
		err = s.discardHunk(w, r, ch, *req.Hunk)
	}
	if err == errAnswered {
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
		return
	}
	s.rebuilt()
	if e, err := s.store.View().Index.Resolve("/" + ch.Path); err == nil {
		s.readPage(e) // keeps its blocks for a later `since`
	}
	after, _ := s.readChange(git.FileChange{Path: ch.Path}, nil)
	writeJSON(w, http.StatusOK, map[string]string{"version": after.version})
}

// errAnswered is a discard that already wrote its answer.
var errAnswered = errors.New("answered")

// discardFile puts a whole file back as HEAD has it: restored if HEAD has it,
// removed if it is new (the link itself, never its target), both for a rename.
func (s *Server) discardFile(r *http.Request, ch changed) error {
	abs := func(rel string) string { return filepath.Join(s.store.Dir, filepath.FromSlash(rel)) }
	switch ch.Change {
	case "new":
		return os.Remove(abs(ch.Path))
	case "renamed":
		if !s.inBundle(ch.From) {
			return errors.New("the old path leaves the bundle")
		}
		if _, err := os.Lstat(abs(ch.From)); !errors.Is(err, fs.ErrNotExist) {
			return errors.New("a file has its old name again: nothing was discarded")
		}
		if err := git.Restore(r.Context(), s.store.Dir, ch.From); err != nil {
			return err
		}
		return os.Remove(abs(ch.Path))
	default:
		return git.Restore(r.Context(), s.store.Dir, ch.Path)
	}
}

// discardHunk undoes hunk n of the file's diff. A text file's goes through
// `git apply --reverse`. A page's new bytes are worked out from the bytes whose
// version was checked, and written with `wiki`'s WriteIf only if the file
// still has that version: all or nothing, and no index entry needed.
func (s *Server) discardHunk(w http.ResponseWriter, r *http.Request, ch changed, n int) error {
	v, d, err := s.diffOf(r, ch)
	if err != nil {
		return err
	}
	if n < 0 || n >= len(v.Hunks) {
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{"no such hunk in this file's diff"})
		return errAnswered
	}
	h := v.Hunks[n]
	if h.Kind == "lines" {
		return git.ReverseHunk(r.Context(), s.store.Dir, v.Raw, *h.At)
	}
	var next string
	if h.Kind == "field" {
		next, err = d.revertField(ch.content, h.Key)
	} else { // blocks, move
		skip := map[int]bool{}
		for _, i := range h.Ops {
			skip[i] = true
		}
		next, err = d.revertBlocks(ch.content, skip)
	}
	if err != nil {
		return err
	}
	err = s.store.View().Index.WriteIf("/"+ch.Path, ch.version, []byte(next))
	if errors.Is(err, index.ErrChanged) {
		now, _ := s.readChange(git.FileChange{Path: ch.Path}, nil)
		writeJSON(w, http.StatusConflict, map[string]string{"error": "This file changed after you read it. Nothing was discarded.", "version": now.version})
		return errAnswered
	}
	return err
}

// revertField is the page with a field back as HEAD has it: HEAD's own
// lines for the key, so any value comes back exactly.
func (d pageDiff) revertField(content, key string) (string, error) {
	return parse.CopyField(content, d.headRaw, key)
}

// revertBlocks is the page with the operations in skip undone: the undo
// merged into the checked body, which is its base, so nothing can conflict.
func (d pageDiff) revertBlocks(content string, skip map[int]bool) (string, error) {
	ops, err := d.revert(skip)
	if err != nil {
		return "", err
	}
	merged, _, conflicts, _, err := parse.MergeBlocks(blockHashes(d.now), ops, d.nowBody)
	switch {
	case err != nil:
		return "", err
	case len(conflicts) > 0:
		return "", errors.New("the hunk couldn't be undone exactly")
	}
	header := content[:len(content)-len(d.nowBody)]
	// As `wiki`'s block write: a header is only ever written by its fields.
	if bare := strings.TrimPrefix(merged, "\ufeff"); header == "" && parse.Body(bare) != bare {
		return "", errors.New("the page would start with a frontmatter fence: discard the whole file")
	}
	return header + merged, nil
}

func blockHashes(bs []parse.Block) []string {
	out := make([]string, len(bs))
	for i, b := range bs {
		out[i] = b.Hash
	}
	return out
}

// sourced is a block of the page with the hunk undone, and where its bytes
// come from: HEAD's body or now's, at its index there.
type sourced struct {
	fromHead bool
	i        int
}

// revert is the block operations, anchored to now, that undo the operations
// in skip: it replays HEAD's blocks through every other operation, which is
// now with that hunk undone, and diffs now against it. Each inserted or
// replacing text is cut from its source body, so the bytes HEAD had come back
// exactly, gaps included.
func (d pageDiff) revert(skip map[int]bool) ([]parse.Op, error) {
	full, _ := replay(d.head, d.now, d.ops, nil)
	if !slices.Equal(blockHashes(full), blockHashes(d.now)) {
		return nil, errors.New("the page's diff couldn't be replayed")
	}
	target, src := replay(d.head, d.now, d.ops, skip)
	diff := parse.DiffBlocks(d.now, target)
	var ops []parse.Op
	for _, o := range diff {
		switch o.Op {
		case "move": // MergeBlocks takes no move: a delete, and an insert where it now goes
			anchor := ""
			if o.After >= 0 {
				anchor = d.now[o.After].Hash
			}
			text := d.now[o.At].Text
			if j := movedIn(target, d.now, o); j >= 0 {
				text = d.gapBefore(src[j]) + text
			}
			ops = append(ops,
				parse.Op{Op: "delete", At: o.At, Hash: o.Hash},
				parse.Op{Op: "insert", After: o.After, Hash: anchor, Text: text})
		case "insert", "replace":
			j := indexIn(target, o.Blocks)
			o.Text, o.Blocks = d.textOf(src[j:j+len(o.Blocks)]), nil
			if o.Op == "insert" { // MergeBlocks keeps the gap an insert starts with
				o.Text = d.gapBefore(src[j]) + o.Text
			}
			ops = append(ops, o)
		default:
			ops = append(ops, o)
		}
	}
	sort.SliceStable(ops, func(a, b int) bool {
		aAt, aRank := opKey(ops[a])
		bAt, bRank := opKey(ops[b])
		return aAt < bAt || aAt == bAt && aRank < bRank
	})
	return ops, nil
}

func opKey(o parse.Op) (int, int) {
	if o.Op == "insert" {
		return o.After, 1
	}
	return o.At, 0
}

// indexIn is where sub, a subslice DiffBlocks cut from all, starts in it.
func indexIn(all, sub []parse.Block) int {
	for j := range all {
		if &all[j] == &sub[0] {
			return j
		}
	}
	return -1
}

// movedIn is where the block a move (of DiffBlocks(now, target)) puts back
// sits in target: the copy of it right after its new neighbour. -1 if none.
func movedIn(target, now []parse.Block, o parse.Op) int {
	for j, b := range target {
		if b.Hash != now[o.At].Hash {
			continue
		}
		if o.After < 0 && j == 0 || o.After >= 0 && j > 0 && target[j-1].Hash == now[o.After].Hash {
			return j
		}
	}
	return -1
}

// block and body are a sourced block, and the body it was cut from.
func (d pageDiff) block(s sourced) parse.Block {
	if s.fromHead {
		return d.head[s.i]
	}
	return d.now[s.i]
}

func (d pageDiff) body(s sourced) string {
	if s.fromHead {
		return d.headBody
	}
	return d.nowBody
}

// gapBefore is the bytes before a block in its source, back to the block
// before it: "" for the first block.
func (d pageDiff) gapBefore(s sourced) string {
	if s.i == 0 {
		return ""
	}
	return d.body(s)[d.block(sourced{s.fromHead, s.i - 1}).End:d.block(s).Start]
}

// textOf is the Markdown of consecutive blocks, each with the gap it had in
// its source before it (the first one without).
func (d pageDiff) textOf(src []sourced) string {
	var b strings.Builder
	for k, s := range src {
		if k > 0 {
			b.WriteString(d.gapBefore(s))
		}
		b.WriteString(d.block(s).Text)
	}
	return b.String()
}

// replay applies a diff's operations to HEAD's blocks, except those in skip,
// which keep HEAD's blocks. With none skipped it gives now's blocks. Each
// block comes with its source.
func replay(head, now []parse.Block, ops []parse.Op, skip map[int]bool) ([]parse.Block, []sourced) {
	var out []parse.Block
	var src []sourced
	nowIndex := map[int]int{} // a now block's Start, to its index
	for i, b := range now {
		nowIndex[b.Start] = i
	}
	keepHead := func(i int) {
		out, src = append(out, head[i]), append(src, sourced{true, i})
	}
	addNow := func(bs []parse.Block) {
		for _, b := range bs {
			out, src = append(out, b), append(src, sourced{false, nowIndex[b.Start]})
		}
	}
	at := map[int]int{}      // HEAD block, to the replace, delete or move at it
	after := map[int][]int{} // HEAD block (-1 for the start), to the inserts and moves after it, in the order listed
	for i, o := range ops {
		switch o.Op {
		case "insert":
			after[o.After] = append(after[o.After], i)
		case "move":
			at[o.At] = i
			after[o.After] = append(after[o.After], i)
		default:
			at[o.At] = i
		}
	}
	tail := func(h int) {
		for _, i := range after[h] {
			switch {
			case skip[i]:
			case ops[i].Op == "move":
				keepHead(ops[i].At)
			default:
				addNow(ops[i].Blocks)
			}
		}
	}
	tail(-1)
	for h := range head {
		i, changed := at[h]
		switch {
		case !changed || skip[i]:
			keepHead(h)
		case ops[i].Op == "replace":
			addNow(ops[i].Blocks)
		}
		tail(h)
	}
	return out, src
}

// commitRequest is `POST /api/commit`: the ticked files, each with the version
// the user saw. A commit never pushes: that is POST /api/git/push alone.
type commitRequest struct {
	Message string `json:"message"`
	Files   []struct {
		Path    string `json:"path"`
		Version string `json:"version"`
	} `json:"files"`
}

type refusal struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

func (s *Server) handleCommit(w http.ResponseWriter, r *http.Request) {
	var req commitRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxMessage+1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"malformed request: " + err.Error()})
		return
	}
	switch {
	case strings.TrimSpace(req.Message) == "":
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{"a commit needs a message"})
		return
	case len(req.Message) > maxMessage || strings.ContainsRune(req.Message, 0):
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{"the message is over 64 KiB or holds a NUL byte"})
		return
	case len(req.Files) == 0:
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{"no files to commit"})
		return
	}
	for _, f := range req.Files {
		if rel := bundlePath(f.Path); rel == "" || git.IsDot(rel) {
			writeJSON(w, http.StatusUnprocessableEntity, errorBody{f.Path + ": not a file that can be committed here"})
			return
		}
	}

	s.acting.Lock()
	defer s.acting.Unlock()
	_, byPath, _, err := s.changeList(r)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
		return
	}
	committed, refused := []string{}, []refusal{}
	var files []git.File
	for _, f := range req.Files {
		c, ok := byPath[bundlePath(f.Path)]
		if !ok {
			refused = append(refused, refusal{f.Path, "not an uncommitted change"})
			continue
		}
		// The commit takes the copy made while checking: the bytes whose
		// version matched, streamed, however large.
		spool, err := s.shadow.Spool()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
			return
		}
		defer os.Remove(spool.Name())
		ch, err := s.readChange(c, spool)
		spool.Close()
		if err != nil || ch.version != f.Version {
			refused = append(refused, refusal{f.Path, "changed after you read it"})
			continue
		}
		if c.From != "" {
			if _, err := os.Lstat(filepath.Join(s.store.Dir, filepath.FromSlash(c.From))); !errors.Is(err, fs.ErrNotExist) {
				refused = append(refused, refusal{f.Path, "changed after you read it"})
				continue
			}
		}
		file := git.File{Path: c.Path, From: c.From, Mode: ch.mode, Gone: c.Change == "deleted"}
		switch {
		case ch.kind == "link":
			file.Content = ch.content
		case !file.Gone:
			file.Source = spool.Name()
		}
		files = append(files, file)
		committed = append(committed, f.Path)
	}
	answer := map[string]any{"committed": committed, "refused": refused, "commit": ""}
	if len(files) > 0 {
		sha, err := git.CommitFiles(r.Context(), s.store.Dir, s.shadow, req.Message, files)
		switch {
		case errors.Is(err, git.ErrHeadMoved):
			writeJSON(w, http.StatusConflict, errorBody{err.Error()})
			return
		case errors.Is(err, git.ErrNothingToCommit):
			// The files refused still say why, so the user sees both.
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error(), "refused": refused})
			return
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
			return
		}
		answer["commit"] = sha
	}
	answer["status"] = s.gitStatus()
	writeJSON(w, http.StatusOK, answer)
}
