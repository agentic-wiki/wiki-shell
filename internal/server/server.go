// Package server exposes a bundle's index over HTTP as JSON.
//
// Only /api is reserved at the root; every other path belongs to the UI and is
// carried verbatim, bundle paths included.
package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/agentic-wiki/wiki-shell/internal/config"
	"github.com/agentic-wiki/wiki-shell/internal/git"
	"github.com/agentic-wiki/wiki-shell/internal/store"
	"github.com/agentic-wiki/wiki/index"
)

type Server struct {
	store  *store.Store
	events *broker
	ui     fs.FS
	mux    *http.ServeMux
	id     string
	// token is this run's API token on a network bind: 32 random bytes as 64
	// lowercase hex characters, created once at start. It is what the terminal
	// prints in the fragment and what every /api call must carry in a header.
	// Never logged. Empty on a loopback bind, which needs no token.
	token string
	// rawSecret is the value of the cookie that opens `/raw` on a network bind:
	// a second secret, separate from the token, because a cookie reaches every
	// service on this host (see rawCookie). Empty on loopback.
	rawSecret string
	// linkHost is the host the printed URL names: the spelling the listener was
	// asked to bind, so the URL agrees with what the user typed, or this
	// machine's name when the bind was to every interface (see linkHost).
	linkHost string
	// port is the port actually bound: it is what the printed URL names, and what
	// a restart changes. The Host allowlist does not compare it — rebinding turns
	// on the name, not the port — so `vite dev`, whose Host is the dev server's
	// port, is still answered.
	port int
	// hosts are the host spellings a loopback server answers to: the loopback
	// ones plus bindHost, which is how a bind to 127.0.0.53 can still answer its
	// own URL. Unused on a network bind, which has no Host check.
	hosts []string
	// announcing keeps rebuilding and announcing together, so overlapping
	// rebuilds are reported in order and each version exactly once.
	announcing sync.Mutex
	// acting serialises the git actions. They mutate one worktree, and two of
	// them at once is a rebase running under a commit.
	acting sync.Mutex
	// editing serialises page writes (blocks, fields, a new page): each reads,
	// merges and writes a file, so two at once would lose one. A handler that
	// needs both takes acting first.
	editing sync.Mutex
	// lists is what one listing of the changes keeps for the next.
	lists listCache
	// history keeps recent block lists, for `GET /api/blocks?since=`.
	history *history
	// shadow is the changes view's shadow index and objects, in the user's
	// cache folder, deleted by Close.
	shadow *git.Shadow
	// edit lets a network bind write (--edit). Loopback always may.
	edit bool
}

// New builds the server. ui is the built frontend, or nil to serve the API only
// (the development shape, where Vite serves the app and proxies /api here).
//
// bindHost is the host the listener was asked to bind and port the port it got;
// together they are what the terminal prints. A loopback bindHost gets the Host
// check and no token; any other one gets a token and no Host check.
func New(s *store.Store, ui fs.FS, bindHost string, port int) *Server {
	srv := &Server{
		store:    s,
		events:   newBroker(),
		history:  newHistory(),
		shadow:   git.NewShadow(""),
		ui:       ui,
		mux:      http.NewServeMux(),
		id:       bundleID(s.View().Index.Bundle.Dir),
		linkHost: linkHost(bindHost, os.Hostname, net.InterfaceAddrs),
		port:     port,
	}
	if loopback(bindHost) {
		srv.hosts = hostAllowlist(bindHost)
	} else {
		srv.token = newSecret()
		srv.rawSecret = newSecret()
	}
	for _, rt := range srv.routes() {
		srv.mux.HandleFunc(rt.pattern, rt.handler)
	}
	return srv
}

// route is one endpoint: its method and path pattern, and its handler.
type route struct {
	pattern string
	handler http.HandlerFunc
}

// routes is every endpoint, in one list, so a test can walk them all (every
// GET is read-only). A wildcard has to be the final segment, so a verb leads
// the path rather than trailing it.
func (s *Server) routes() []route {
	return []route{
		{"GET /api/bundle", s.handleBundle},
		{"GET /api/entry/{path...}", s.handleEntry},
		{"GET /api/tree", s.handleTree},
		{"GET /api/board/{id}", s.handleBoard},
		{"GET /api/graph/{id}", s.handleGraph},
		{"GET /api/draft/{kind}/{path...}", s.handleDraft},
		{"GET /api/events", s.handleEvents},
		{"GET /api/blocks/{path...}", s.handleBlocks},
		{"GET /api/table/{path...}", s.handleTable},
		{"PUT /api/blocks/{path...}", s.handleSave},
		{"PUT /api/fields/{path...}", s.handleFields},
		{"POST /api/entries", s.handleCreate},
		{"PUT /api/card/{id}/{path...}", s.handleCard},
		{"POST /api/board", s.handleDeclareBoard},
		{"POST /api/graph", s.handleDeclareGraph},
		{"PUT /api/graph/{id}", s.handleGraphSettings},
		{"POST /api/refresh", s.handleRefresh},
		// Git, which is optional: a bundle is a folder and need not be a
		// repository. The status says so, and the actions are absent rather
		// than broken.
		{"GET /api/git", s.handleGitStatus},
		{"POST /api/git/fetch", s.handleGitFetch},
		{"POST /api/git/pull", s.handleGitPull},
		{"POST /api/git/push", s.handleGitPush},
		// The changes view: what isn't committed, its diffs, discard and commit.
		{"GET /api/changes", s.handleChanges},
		{"GET /api/changes/{path...}", s.handleChange},
		{"POST /api/changes/discard", s.handleDiscard},
		{"POST /api/commit", s.handleCommit},
		{"POST /api/git/branch", s.handleGitBranch},
		{"PUT /api/board/{id}", s.handleBoardSettings},
		// Files the bundle links to but does not index. Outside /api because
		// it is not JSON: an <img src> and a new tab both want the file itself.
		{"GET /raw/{path...}", s.handleRaw},
		// Everything not under /api belongs to the app.
		{"GET /", s.serveUI},
	}
}

// BundleInfo is what a client needs to know about the bundle itself, as opposed
// to any entry in it.
type BundleInfo struct {
	// ID scopes whatever the browser remembers about this bundle. One person
	// serving five knowledge bases from the same browser would otherwise carry a
	// view preference from one into another, where the folder it names may not
	// exist. Sent rather than derived so a bundle's identity has one definition
	// and the client never has to care how it is computed.
	ID string `json:"id"`
	// Label is the bundle's folder made readable, by the rule that names
	// everything else. Sent rather than sliced off Dir in the browser, so the
	// name at the top of the page agrees with the tree underneath it.
	Label   string   `json:"label"`
	Dir     string   `json:"dir"`
	Spec    string   `json:"spec"`
	Entries int      `json:"entries"`
	Tools   []string `json:"tools"`   // [tool.*] tables present in wiki.toml
	Version uint64   `json:"version"` // matches the SSE stream; compare to know you are stale
	// Editable says whether this server takes writes: always on loopback, and
	// on a network address only when started with --edit.
	Editable bool `json:"editable"`
	// Boards are the boards declared in `[[board]]`, with their defaults
	// filled in. Only the ones with an id, since an id is what a board is
	// addressed by and listing one without an address offers a dead link.
	Boards []BoardInfo `json:"boards,omitempty"`
	// Graphs are the graphs declared, named. There is no built-in one, so this
	// is every graph there is.
	Graphs []GraphInfo `json:"graphs,omitempty"`
	// Tags is every tag in the bundle, in the order they first appear: entries
	// walked by path, each one's tags as written. A tag's colour is its
	// position in this list, so one tag is one colour on every surface — and the
	// list is the server's, so no client has to agree with another about it.
	Tags []string `json:"tags"`
	// Types are the types wiki.toml declares, in its order, for an editor to
	// offer: empty when types are free-form.
	Types []string `json:"types"`
}

// BoardInfo is a declared board and how many cards it holds, so a list of
// boards can say which is which without fetching each one.
type BoardInfo struct {
	config.Board
	// Cards counts the entries the board's filter admits — every card, the
	// no-status column included — computed the way the board itself is.
	Cards int `json:"cards"`
}

// GraphInfo is a declared graph and how many entries it is over. Neighbours are
// not counted: they are on a graph for context, and the count says what the
// graph is of.
type GraphInfo struct {
	config.Graph
	Entries int `json:"entries"`
}

// matching counts the entries under a view's folder that its filter admits.
func matching(idx *index.Index, path string, filters []index.PropFilter) int {
	if path == "/" {
		path = "" // the whole bundle, which is what Filter reads an empty prefix as
	}
	return len(idx.Filter(path, filters))
}

// bundleID identifies a bundle by where it lives, which is the only thing
// distinguishing two of them on one machine: a bundle has no identity of its
// own, and inventing one would mean writing it into the folder.
//
// Moving a bundle therefore loses what the browser remembered about it. That is
// the right failure for a view preference. Anything worth keeping across a move
// belongs in wiki.toml, versioned with the files.
func bundleID(dir string) string {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir // unresolvable only if the working directory is gone
	}
	sum := sha256.Sum256([]byte(abs))
	return hex.EncodeToString(sum[:6])
}

func (s *Server) handleBundle(w http.ResponseWriter, r *http.Request) {
	v := s.store.View()
	// Decoded per request rather than held, because it follows the same file the
	// index does: editing wiki.toml rebuilds, and the next request should see
	// the board you just declared. Problems are reported at startup rather than
	// on every fetch; a malformed board is not a reason to fail this response.
	cfg, _ := config.Decode(v.Index.Bundle, v.Index)
	boards := make([]BoardInfo, 0, len(cfg.Board))
	for _, b := range cfg.Board {
		// A board with no id has no address, so listing it would offer a link to
		// `/kanban/` — which resolves to the root board and quietly shows the
		// wrong thing. The startup message says why it is missing.
		if b.ID == "" {
			continue
		}
		boards = append(boards, BoardInfo{named(b, v.Index.Bundle.Dir), matching(v.Index, b.Path, b.Filters)})
	}
	graphs := make([]GraphInfo, 0, len(cfg.Graph))
	for _, g := range cfg.Graph {
		if servable(g) {
			g.Name = viewName(g.Name, g.Path, v.Index.Bundle.Dir)
			graphs = append(graphs, GraphInfo{g, matching(v.Index, g.Path, g.Filters)})
		}
	}
	writeJSON(w, http.StatusOK, BundleInfo{
		ID:       s.id,
		Label:    dirLabel(v.Index.Bundle.Dir),
		Dir:      v.Index.Bundle.Dir,
		Spec:     v.Index.Bundle.Spec,
		Entries:  len(v.Index.Entries),
		Tools:    v.Index.Bundle.Tools(),
		Version:  v.Version,
		Editable: s.editable(),
		Boards:   boards,
		Graphs:   graphs,
		Tags:     tagsInOrder(v.Index),
		Types:    append([]string{}, v.Index.Bundle.Types...),
	})
}

// tagsInOrder is every distinct tag, first appearance first, walking entries in
// path order. Path order rather than the index's walk order, which is not a
// promise: the list is what colours are assigned by, and a colour that moved
// between two requests for no reason would be a bug nobody could reproduce.
func tagsInOrder(idx *index.Index) []string {
	entries := slices.Clone(idx.Entries)
	slices.SortFunc(entries, func(a, b *index.Entry) int { return strings.Compare(a.Path, b.Path) })
	seen := map[string]bool{}
	tags := []string{}
	for _, e := range entries {
		for _, t := range e.FieldList("tags") {
			if !seen[t] {
				seen[t] = true
				tags = append(tags, t)
			}
		}
	}
	return tags
}

type errorBody struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	// The body is built from an index already in memory, so an encode failure
	// means a broken connection: the status line is already sent and there is
	// nothing useful left to say.
	_ = json.NewEncoder(w).Encode(v)
}
