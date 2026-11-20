package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agentic-wiki/wiki-shell/ui"
	"github.com/agentic-wiki/wiki/index"
	"github.com/agentic-wiki/wiki/parse"
)

// call sends a request as the app does and returns the status and body.
func call(t *testing.T, srv *Server, method, path string, body any) (int, []byte) {
	t.Helper()
	var r *bytes.Reader
	switch b := body.(type) {
	case nil:
		r = bytes.NewReader(nil)
	case string:
		r = bytes.NewReader([]byte(b))
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		r = bytes.NewReader(raw)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, browserRequest(srv, method, path, r))
	return rec.Code, rec.Body.Bytes()
}

// pageView is what the app holds of a page: its version and blocks.
type pageView struct {
	Version string        `json:"version"`
	Blocks  []parse.Block `json:"blocks"`
}

func readPage(t *testing.T, srv *Server, path string) pageView {
	t.Helper()
	code, body := call(t, srv, http.MethodGet, "/api/entry"+path, nil)
	var p pageView
	if code != http.StatusOK || json.Unmarshal(body, &p) != nil {
		t.Fatalf("GET /api/entry%s: %d %s", path, code, body)
	}
	return p
}

func hashesOf(bs []parse.Block) []string {
	out := make([]string, len(bs))
	for i, b := range bs {
		out[i] = b.Hash
	}
	return out
}

func fileAt(t *testing.T, srv *Server, path string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(srv.store.Dir, filepath.FromSlash(strings.TrimPrefix(path, "/"))))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// GET /api/entry carries the page's version and its blocks, from the same read.
func TestEntryCarriesVersionAndBlocks(t *testing.T) {
	srv := newTestServer(t)
	p := readPage(t, srv, "/notes/a.md")
	raw := fileAt(t, srv, "/notes/a.md")
	if p.Version != index.FileVersion([]byte(raw)) || len(p.Blocks) != 4 || p.Blocks[2].Text != "- [ ] open" || p.Blocks[2].Kind != "item" {
		t.Errorf("version %q, blocks %+v", p.Version, p.Blocks)
	}
}

// Saving ticks a checkbox by replacing its item block: only that block changes,
// and the answer carries the new version and the operations from the base.
func TestSaveReplacesABlock(t *testing.T) {
	srv := newTestServer(t)
	p := readPage(t, srv, "/notes/a.md")
	before := fileAt(t, srv, "/notes/a.md")
	code, body := call(t, srv, http.MethodPut, "/api/blocks/notes/a.md", map[string]any{
		"base": p.Version, "baseBlocks": hashesOf(p.Blocks),
		"ops": []map[string]any{{"op": "replace", "at": 2, "hash": p.Blocks[2].Hash, "text": "- [x] open"}},
	})
	var got struct {
		Version   string            `json:"version"`
		Ops       []json.RawMessage `json:"ops"`
		Conflicts []parse.Conflict  `json:"conflicts"`
		Rewritten bool              `json:"rewritten"`
	}
	if code != http.StatusOK || json.Unmarshal(body, &got) != nil {
		t.Fatalf("%d %s", code, body)
	}
	want := strings.Replace(before, "- [ ] open", "- [x] open", 1)
	if fileAt(t, srv, "/notes/a.md") != want || got.Version != index.FileVersion([]byte(want)) || len(got.Ops) != 1 || len(got.Conflicts) != 0 {
		t.Errorf("file %q, answer %s", fileAt(t, srv, "/notes/a.md"), body)
	}
	if !strings.Contains(string(got.Ops[0]), `"op":"replace"`) || !strings.Contains(string(got.Ops[0]), `"blocks":[`) {
		t.Errorf("op %s", got.Ops[0])
	}
	// The index is rebuilt: the next read sees the new version.
	if readPage(t, srv, "/notes/a.md").Version != got.Version {
		t.Error("the entry still reads the old version")
	}
}

// A save on a stale base merges with the outside change, and a block both
// changed comes back as a conflict: a 200 that is a partial save.
func TestSaveOnAStaleBase(t *testing.T) {
	srv := newTestServer(t)
	p := readPage(t, srv, "/notes/a.md")
	path := filepath.Join(srv.store.Dir, "notes", "a.md")
	agent := strings.Replace(fileAt(t, srv, "/notes/a.md"), "- [x] done", "- [x] done, by an agent", 1)
	os.WriteFile(path, []byte(agent), 0o644)

	code, body := call(t, srv, http.MethodPut, "/api/blocks/notes/a.md", map[string]any{
		"base": p.Version, "baseBlocks": hashesOf(p.Blocks),
		"ops": []map[string]any{
			{"op": "replace", "at": 2, "hash": p.Blocks[2].Hash, "text": "- [x] open"},
			{"op": "replace", "at": 3, "hash": p.Blocks[3].Hash, "text": "- [ ] done"},
		},
	})
	var got struct {
		Conflicts []parse.Conflict `json:"conflicts"`
	}
	if code != http.StatusOK || json.Unmarshal(body, &got) != nil {
		t.Fatalf("%d %s", code, body)
	}
	if want := strings.Replace(agent, "- [ ] open", "- [x] open", 1); fileAt(t, srv, "/notes/a.md") != want {
		t.Errorf("file:\n%s\nwant:\n%s", fileAt(t, srv, "/notes/a.md"), want)
	}
	if len(got.Conflicts) != 1 || got.Conflicts[0].At != 3 || got.Conflicts[0].Case != "both-changed" {
		t.Errorf("conflicts %s", body)
	}
}

func TestSaveStatuses(t *testing.T) {
	srv := newTestServer(t)
	p := readPage(t, srv, "/notes/a.md")
	for _, c := range []struct {
		name string
		path string
		body any
		want int
	}{
		{"malformed", "/api/blocks/notes/a.md", "{not json", http.StatusBadRequest},
		{"over 2 MiB", "/api/blocks/notes/a.md", `{"base":"` + strings.Repeat("x", maxSave) + `"}`, http.StatusBadRequest},
		{"no entry", "/api/blocks/notes/gone.md", map[string]any{"base": "", "baseBlocks": []string{}, "ops": []any{}}, http.StatusNotFound},
		{"a dot path", "/api/blocks/.git/config", map[string]any{"base": "", "baseBlocks": []string{}, "ops": []any{}}, http.StatusNotFound},
		{"a wrong anchor", "/api/blocks/notes/a.md", map[string]any{"base": p.Version, "baseBlocks": hashesOf(p.Blocks),
			"ops": []map[string]any{{"op": "delete", "at": 2, "hash": p.Blocks[1].Hash}}}, http.StatusUnprocessableEntity},
		{"baseBlocks not the page's", "/api/blocks/notes/a.md", map[string]any{"base": p.Version, "baseBlocks": []string{"x"}, "ops": []any{}}, http.StatusUnprocessableEntity},
	} {
		before := fileAt(t, srv, "/notes/a.md")
		if code, body := call(t, srv, http.MethodPut, c.path, c.body); code != c.want {
			t.Errorf("%s: %d %s, want %d", c.name, code, body, c.want)
		}
		if fileAt(t, srv, "/notes/a.md") != before {
			t.Errorf("%s: the page changed", c.name)
		}
	}
}

// GET /api/blocks?since= answers with what changed since a version it served,
// with nothing when nothing did, and with the whole list for a version it no
// longer keeps. A read-only network bind answers the same way, so readers see
// outside changes too.
func TestBlocksSince(t *testing.T) {
	for mode, srv := range bothModes(t) {
		p := readPage(t, srv, "/notes/a.md")
		type answer struct {
			Version string            `json:"version"`
			Ops     []json.RawMessage `json:"ops"`
			Blocks  []parse.Block     `json:"blocks"`
		}
		since := func(v string) (answer, string) {
			code, body := call(t, srv, http.MethodGet, "/api/blocks/notes/a.md?since="+v, nil)
			var a answer
			if code != http.StatusOK || json.Unmarshal(body, &a) != nil {
				t.Fatalf("%s: %d %s", mode, code, body)
			}
			return a, string(body)
		}
		if a, body := since(p.Version); a.Version != p.Version || a.Ops == nil || len(a.Ops) != 0 || a.Blocks != nil {
			t.Errorf("%s: nothing changed: %s", mode, body)
		}
		os.WriteFile(filepath.Join(srv.store.Dir, "notes", "a.md"), []byte(strings.Replace(fileAt(t, srv, "/notes/a.md"), "- [ ] open", "- [x] open", 1)), 0o644)
		srv.RebuildAndNotify()
		if a, body := since(p.Version); len(a.Ops) != 1 || !strings.Contains(string(a.Ops[0]), `"at":2`) {
			t.Errorf("%s: one block changed: %s", mode, body)
		}
		if a, body := since("unknown"); a.Ops != nil || len(a.Blocks) != 4 {
			t.Errorf("%s: an unknown version: %s", mode, body)
		}
		if code, _ := call(t, srv, http.MethodGet, "/api/blocks/notes/gone.md?since=x", nil); code != http.StatusNotFound {
			t.Errorf("%s: no entry: %d", mode, code)
		}
	}
}

// The history is bounded: the last 8 versions of a page, over the 64 pages
// most recently served.
func TestHistoryIsBounded(t *testing.T) {
	h := newHistory()
	for i := 0; i < historyPerPage+1; i++ {
		h.record("/a.md", fmt.Sprint(i), nil)
	}
	if _, ok := h.at("/a.md", "0"); ok {
		t.Error("a ninth version kept the first")
	}
	if _, ok := h.at("/a.md", "1"); !ok {
		t.Error("the second version is gone too soon")
	}
	for i := 0; i < historyPages; i++ {
		h.record(fmt.Sprintf("/p%d.md", i), "v", nil)
	}
	if _, ok := h.at("/a.md", "8"); ok {
		t.Error("the least recently used page outlived 64 others")
	}
	if _, ok := h.at("/p0.md", "v"); !ok {
		t.Error("a recent page is gone")
	}
}

// Fields are set when they still hold what the client read; a key changed on
// disk comes back with its value there.
func TestFields(t *testing.T) {
	srv := newTestServer(t)
	path := filepath.Join(srv.store.Dir, "notes", "a.md")
	os.WriteFile(path, []byte(strings.Replace(fileAt(t, srv, "/notes/a.md"), "title: The first note", "title: Renamed outside", 1)), 0o644)
	code, body := call(t, srv, http.MethodPut, "/api/fields/notes/a.md", map[string]any{
		"set": map[string]any{"title": "Mine", "status": "done", "tags": []string{"ui"}},
		"old": map[string]any{"title": "The first note", "status": nil, "tags": []string{"ui", "api"}},
	})
	var got struct {
		Version   string                `json:"version"`
		Conflicts []index.FieldConflict `json:"conflicts"`
	}
	if code != http.StatusOK || json.Unmarshal(body, &got) != nil {
		t.Fatalf("%d %s", code, body)
	}
	file := fileAt(t, srv, "/notes/a.md")
	if !strings.Contains(file, "title: Renamed outside") || !strings.Contains(file, "status: done") || !strings.Contains(file, "tags: [ui]") {
		t.Errorf("file:\n%s", file)
	}
	if len(got.Conflicts) != 1 || got.Conflicts[0].Key != "title" || got.Conflicts[0].Theirs != "Renamed outside" || got.Version != index.FileVersion([]byte(file)) {
		t.Errorf("answer %s", body)
	}
	// A folder's index.md has no header, by definition: a field can't be set.
	os.WriteFile(filepath.Join(srv.store.Dir, "notes", "index.md"), []byte("# Notes\n"), 0o644)
	srv.RebuildAndNotify()
	for name, c := range map[string]struct {
		path string
		body any
		want int
	}{
		"a number":               {"/api/fields/notes/a.md", map[string]any{"set": map[string]any{"n": 3}}, http.StatusUnprocessableEntity},
		"no header":              {"/api/fields/notes/index.md", map[string]any{"set": map[string]any{"x": "y"}}, http.StatusUnprocessableEntity},
		"no entry":               {"/api/fields/notes/gone.md", map[string]any{"set": map[string]any{"x": "y"}}, http.StatusNotFound},
		"malformed":              {"/api/fields/notes/a.md", "[", http.StatusBadRequest},
		"nothing sent":           {"/api/fields/notes/a.md", map[string]any{}, http.StatusUnprocessableEntity},
		"a key wiki can't write": {"/api/fields/notes/a.md", map[string]any{"set": map[string]any{"_x": "y"}}, http.StatusUnprocessableEntity},
	} {
		if code, body := call(t, srv, http.MethodPut, c.path, c.body); code != c.want {
			t.Errorf("%s: %d %s, want %d", name, code, body, c.want)
		}
	}
}

// A field write that would give a page a type wiki.toml doesn't declare is
// refused with the reason (wiki's own rule, Bundle.KnownType). Free-form
// types take any type. Removing a type isn't judged here: the bundle's root
// index.md, say, carries none.
func TestFieldsKeepTheDeclaredTypes(t *testing.T) {
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml": "spec = \"0.1\"\ntypes = [\"note\", \"task\"]\n",
		"index.md":  "---\nokf_version: \"0.1\"\ntype: note\n---\nhome\n",
		"a.md":      "---\ntype: note\n---\nbody\n",
	})
	for name, c := range map[string]struct {
		body map[string]any
		want int
		says string
	}{
		"an undeclared type": {map[string]any{"set": map[string]any{"type": "memo"}, "old": map[string]any{"type": "note"}}, http.StatusUnprocessableEntity, "type `memo` isn't one wiki.toml declares (note, task)"},
		"a declared type":    {map[string]any{"set": map[string]any{"type": "task"}, "old": map[string]any{"type": "note"}}, http.StatusOK, ""},
	} {
		code, body := call(t, srv, http.MethodPut, "/api/fields/a.md", c.body)
		if code != c.want || !strings.Contains(string(body), c.says) {
			t.Errorf("%s: %d %s, want %d %q", name, code, body, c.want, c.says)
		}
	}
	if code, body := call(t, srv, http.MethodPut, "/api/fields/index.md", map[string]any{"unset": []string{"type"}, "old": map[string]any{"type": "note"}}); code != http.StatusOK {
		t.Errorf("removing type from index.md: %d %s", code, body)
	}
	free, _ := bundleServer(t, map[string]string{"wiki.toml": "spec = \"0.1\"\n", "index.md": "---\nokf_version: \"0.1\"\n---\nhome\n", "a.md": "---\ntype: note\n---\nbody\n"})
	if code, body := call(t, free, http.MethodPut, "/api/fields/a.md", map[string]any{"set": map[string]any{"type": "memo"}, "old": map[string]any{"type": "note"}}); code != http.StatusOK {
		t.Errorf("free-form types: %d %s", code, body)
	}
}

func TestCreate(t *testing.T) {
	srv := newTestServer(t)
	content := "---\ntype: note\n---\n# New\n"
	code, body := call(t, srv, http.MethodPost, "/api/entries", map[string]string{"path": "/notes/new.md", "content": content})
	var got map[string]string
	if code != http.StatusCreated || json.Unmarshal(body, &got) != nil || got["version"] != index.FileVersion([]byte(content)) {
		t.Fatalf("%d %s", code, body)
	}
	if readPage(t, srv, "/notes/new.md").Version != got["version"] {
		t.Error("the new page isn't in the index")
	}
	for name, c := range map[string]struct {
		body any
		want int
	}{
		"over a file": {map[string]string{"path": "/notes/a.md", "content": "x"}, http.StatusConflict},
		"a dot path":  {map[string]string{"path": "/.git/x.md", "content": "x"}, http.StatusUnprocessableEntity},
		"not .md":     {map[string]string{"path": "/x.txt", "content": "x"}, http.StatusUnprocessableEntity},
		"climbing":    {map[string]string{"path": "/../x.md", "content": "x"}, http.StatusUnprocessableEntity},
		"malformed":   {"{", http.StatusBadRequest},
	} {
		if code, body := call(t, srv, http.MethodPost, "/api/entries", c.body); code != c.want {
			t.Errorf("%s: %d %s, want %d", name, code, body, c.want)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(srv.store.Dir), "x.md")); err == nil {
		t.Error("a page was made outside the bundle")
	}
}

// A dot path is never served: wiki indexes none, a link to one included.
func TestDotPathsAreNotServed(t *testing.T) {
	srv := newTestServer(t)
	os.MkdirAll(filepath.Join(srv.store.Dir, ".git"), 0o755)
	os.WriteFile(filepath.Join(srv.store.Dir, ".git", "config"), []byte("[core]\n"), 0o644)
	os.WriteFile(filepath.Join(srv.store.Dir, ".hidden.md"), []byte("---\ntype: note\n---\nsecret\n"), 0o644)
	if err := os.Symlink("../.git/config", filepath.Join(srv.store.Dir, "notes", "x.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	srv.RebuildAndNotify()
	for _, p := range []string{"/.git/config", "/.hidden.md", "/notes/x.md"} {
		for _, api := range []string{"/api/entry", "/api/blocks"} {
			if code, body := call(t, srv, http.MethodGet, api+p, nil); code != http.StatusNotFound {
				t.Errorf("GET %s%s: %d %s", api, p, code, body)
			}
		}
	}
}

// On a network bind without --edit, every write is refused, one message for
// all, before routing; refresh still re-reads. With --edit, writes go through.
func TestANetworkBindIsReadOnlyWithoutEdit(t *testing.T) {
	srv := newNetworkServer(t)
	var info BundleInfo
	if get(t, srv, "/api/bundle", &info); info.Editable {
		t.Error("editable on a network bind without --edit")
	}
	before := fileAt(t, srv, "/notes/a.md")
	for _, rt := range srv.routes() {
		method, pattern, _ := strings.Cut(rt.pattern, " ")
		if method == http.MethodGet || !strings.HasPrefix(pattern, "/api") {
			continue
		}
		code, body := call(t, srv, method, fill(pattern), "{}")
		want := http.StatusForbidden
		if pattern == "/api/refresh" {
			want = http.StatusOK
		}
		if code != want {
			t.Errorf("%s %s: %d %s, want %d", method, pattern, code, body, want)
		}
		if want == http.StatusForbidden && !strings.Contains(string(body), readOnly) {
			t.Errorf("%s %s: %s", method, pattern, body)
		}
	}
	// A route nobody registered is refused the same way.
	if code, _ := call(t, srv, http.MethodDelete, "/api/anything", nil); code != http.StatusForbidden {
		t.Errorf("an unknown write: %d", code)
	}
	if fileAt(t, srv, "/notes/a.md") != before {
		t.Error("a write went through")
	}
	if srv.EditNotice() == "" {
		t.Error("the terminal says nothing about the read-only bind")
	}

	srv.AllowEdits()
	if get(t, srv, "/api/bundle", &info); !info.Editable {
		t.Error("not editable with --edit")
	}
	p := readPage(t, srv, "/notes/a.md")
	if code, body := call(t, srv, http.MethodPut, "/api/blocks/notes/a.md", map[string]any{"base": p.Version, "baseBlocks": hashesOf(p.Blocks),
		"ops": []map[string]any{{"op": "replace", "at": 2, "hash": p.Blocks[2].Hash, "text": "- [x] open"}}}); code != http.StatusOK {
		t.Errorf("a save with --edit: %d %s", code, body)
	}
	// Loopback is always editable, and its terminal says nothing.
	loop := newTestServer(t)
	if get(t, loop, "/api/bundle", &info); !info.Editable || loop.EditNotice() != "" {
		t.Errorf("loopback: editable %v, notice %q", info.Editable, loop.EditNotice())
	}
}

// fill gives a route pattern's wildcards a value of the test bundle.
func fill(pattern string) string {
	r := strings.NewReplacer("{path...}", "notes/a.md", "{id}", "root", "{kind}", "board")
	return r.Replace(pattern)
}

// Every GET route is read-only: called with real arguments, none changes a
// byte of the bundle.
func TestEveryGETRouteIsReadOnly(t *testing.T) {
	srv := newTestServer(t)
	digest := func() [32]byte {
		h := sha256.New()
		filepath.WalkDir(srv.store.Dir, func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				b, _ := os.ReadFile(p)
				fmt.Fprintf(h, "%s\x00%x\x00", p, sha256.Sum256(b))
			}
			return nil
		})
		var sum [32]byte
		copy(sum[:], h.Sum(nil))
		return sum
	}
	before := digest()
	walked := 0
	for _, rt := range srv.routes() {
		method, pattern, _ := strings.Cut(rt.pattern, " ")
		if method != http.MethodGet {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond) // the event stream stays open
		r := browserRequest(srv, method, fill(pattern), nil).WithContext(ctx)
		srv.ServeHTTP(httptest.NewRecorder(), r)
		cancel()
		walked++
	}
	if walked < 10 {
		t.Fatalf("walked %d GET routes", walked)
	}
	if digest() != before {
		t.Error("a GET route changed the bundle")
	}
}

// Every response carries the CSP, and the built app runs under it: no inline
// script or style in its page.
func TestTheAppRunsUnderTheCSP(t *testing.T) {
	srv := newUIServer(t)
	for _, p := range []string{"/", "/api/bundle"} {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, browserRequest(srv, http.MethodGet, p, nil))
		if got := rec.Header().Get("Content-Security-Policy"); got != csp || !strings.Contains(csp, "script-src 'self'") {
			t.Errorf("%s: CSP %q", p, got)
		}
	}
	assets := ui.Assets()
	if assets == nil {
		t.Skip("the UI isn't built here (ui/dist): run `just ui-build`")
	}
	page, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, inline := range []string{"<script>", "<script type=\"module\">", "<style", " style=", "javascript:"} {
		if strings.Contains(html, inline) {
			t.Errorf("the built page has %q, which the CSP blocks", inline)
		}
	}
}

// A field write moves the version and no block: `since` answers [] then,
// never null.
func TestBlocksSinceAFieldWriteIsNoOps(t *testing.T) {
	srv := newTestServer(t)
	p := readPage(t, srv, "/notes/a.md")
	if code, body := call(t, srv, http.MethodPut, "/api/fields/notes/a.md", map[string]any{"set": map[string]any{"status": "done"}}); code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	code, body := call(t, srv, http.MethodGet, "/api/blocks/notes/a.md?since="+p.Version, nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"ops":[]`) || strings.Contains(string(body), p.Version) {
		t.Errorf("%d %s, want the new version and \"ops\":[]", code, body)
	}
}

// A save that landed answers with its result even when the rebuild after it
// fails: the write isn't undone, and the watcher rebuilds again.
func TestASaveThatLandedIsNotReportedAsFailed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs a file this user can't read")
	}
	srv := newTestServer(t)
	p := readPage(t, srv, "/notes/a.md")
	unreadable := filepath.Join(srv.store.Dir, "notes", "locked.md")
	os.WriteFile(unreadable, []byte("x"), 0o000)
	t.Cleanup(func() { os.Chmod(unreadable, 0o644) })
	code, body := call(t, srv, http.MethodPut, "/api/blocks/notes/a.md", map[string]any{"base": p.Version, "baseBlocks": hashesOf(p.Blocks),
		"ops": []map[string]any{{"op": "replace", "at": 2, "hash": p.Blocks[2].Hash, "text": "- [x] open"}}})
	if code != http.StatusOK || !strings.Contains(fileAt(t, srv, "/notes/a.md"), "- [x] open") {
		t.Errorf("%d %s, want 200 for a save that landed", code, body)
	}
}

// A card move takes the page-write lock, so it never interleaves with a block
// or field save of the same page and loses one.
func TestACardMoveWaitsForThePageLock(t *testing.T) {
	srv := newTestServer(t)
	os.WriteFile(filepath.Join(srv.store.Dir, "notes", "t.md"), []byte("---\ntype: task\nstatus: todo\n---\nA task.\n"), 0o644)
	srv.RebuildAndNotify()
	var info BundleInfo
	get(t, srv, "/api/bundle", &info)
	srv.editing.Lock()
	done := make(chan int)
	go func() {
		code, _ := call(t, srv, http.MethodPut, "/api/card/root/notes/t.md", map[string]any{"value": "done", "version": info.Version})
		done <- code
	}()
	select {
	case code := <-done:
		t.Fatalf("the card move finished (%d) while a page write held the lock", code)
	case <-time.After(100 * time.Millisecond):
	}
	srv.editing.Unlock()
	if code := <-done; code != http.StatusOK {
		t.Errorf("the card move: %d", code)
	}
}

// A page over the block cap opens read-only: no blocks sent, nothing kept,
// nothing diffed, and a save refused.
func TestAPageOverTheCapIsReadOnly(t *testing.T) {
	srv := newTestServer(t)
	os.WriteFile(filepath.Join(srv.store.Dir, "big.md"), []byte("---\ntype: note\n---\n"+strings.Repeat("- x\n", parse.MaxBlocks+1)), 0o644)
	srv.RebuildAndNotify()
	var entry struct {
		Version  string        `json:"version"`
		Blocks   []parse.Block `json:"blocks"`
		Editable bool          `json:"editable"`
	}
	if code := get(t, srv, "/api/entry/big.md", &entry); code != http.StatusOK || entry.Editable || len(entry.Blocks) != 0 || entry.Version == "" {
		t.Errorf("%d %+v", code, entry.Editable)
	}
	if _, ok := srv.history.at("/big.md", entry.Version); ok {
		t.Error("the page was kept in the history")
	}
	code, body := call(t, srv, http.MethodGet, "/api/blocks/big.md?since="+entry.Version, nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"editable":false`) || strings.Contains(string(body), `"ops"`) {
		t.Errorf("%d %s", code, body)
	}
	if code, _ := call(t, srv, http.MethodPut, "/api/blocks/big.md", map[string]any{"base": entry.Version, "baseBlocks": []string{}, "ops": []any{}}); code != http.StatusUnprocessableEntity {
		t.Errorf("a save of it: %d, want 422", code)
	}
	if p := readPage(t, srv, "/notes/a.md"); len(p.Blocks) == 0 {
		t.Error("an ordinary page lost its blocks")
	}
}
