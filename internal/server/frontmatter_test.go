package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/agentic-wiki/wiki/parse"
)

// badHeader is not valid YAML: the wiki library reads it with no fields.
const badHeader = "---\ntitle: a: b\n---\n# Bad\n\nThe body still reads.\n"

// readErr is the library's own text for why content's header can't be read:
// the text the API must carry.
func readErr(t *testing.T, content string) string {
	t.Helper()
	_, _, _, err := parse.ReadFrontmatter(content)
	if err == nil {
		t.Fatalf("the header reads: %q", content)
	}
	return err.Error()
}

// getRaw is a GET's status and raw JSON body, for asserting what is absent.
func getRaw(srv *Server, path string) (int, string) {
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, browserRequest(srv, http.MethodGet, path, nil))
	return rec.Code, rec.Body.String()
}

// An entry whose header can't be read says why, on its page and in the tree.
// Its body still reads. An entry that reads carries no frontmatterError key.
func TestUnreadHeaderInEntryAndTree(t *testing.T) {
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml":     "spec = \"0.1\"\n",
		"notes/bad.md":  badHeader,
		"notes/good.md": "---\ntype: note\n---\n# Good\n",
	})
	want := readErr(t, badHeader)
	if want != "line 2: mapping values are not allowed in this context" {
		t.Fatalf("readErr = %q, want the library's reason without \"yaml: \"", want)
	}

	var e EntryView
	if code := get(t, srv, "/api/entry/notes/bad.md", &e); code != http.StatusOK {
		t.Fatalf("GET bad.md = %d", code)
	}
	if e.FrontmatterError != want || len(e.Frontmatter) != 0 || !strings.Contains(e.Body, "The body still reads.") {
		t.Errorf("bad.md: error %q (want %q), frontmatter %v, body %q", e.FrontmatterError, want, e.Frontmatter, e.Body)
	}
	if _, body := getRaw(srv, "/api/entry/notes/good.md"); strings.Contains(body, "frontmatterError") {
		t.Errorf("good.md carries frontmatterError: %s", body)
	}

	var tree TreeNode
	if code := get(t, srv, "/api/tree", &tree); code != http.StatusOK {
		t.Fatalf("GET /api/tree = %d", code)
	}
	stubs := map[string]EntryStub{}
	for _, c := range tree.Children {
		for _, s := range c.Entries {
			stubs[s.Path] = s
		}
	}
	if got := stubs["/notes/bad.md"].FrontmatterError; got != want {
		t.Errorf("tree: bad.md error %q, want %q", got, want)
	}
	if got := stubs["/notes/good.md"].FrontmatterError; got != "" {
		t.Errorf("tree: good.md error %q", got)
	}
}

// An unread entry under a board's path is listed in unread, by path, label
// and error, and is in no column: not on a board whose `where` it can't match,
// and not in the no-status column of a board over every entry (`where = []`) either. One
// outside the path isn't listed. With none, unread is [] rather than absent.
func TestUnreadEntriesAreListedNotCarded(t *testing.T) {
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml": `spec = "0.1"

[[tool.wikiview.board]]
id    = "tasks"
path  = "/backlog"
where = ["type=task"]

[[tool.wikiview.board]]
id    = "all"
path  = "/backlog"
where = []

[[tool.wikiview.board]]
id   = "notes"
path = "/notes"
`,
		"backlog/a.md":        "---\ntype: task\nstatus: todo\n---\nA\n",
		"backlog/bad-task.md": badHeader,
		"elsewhere/bad.md":    badHeader,
		"notes/n.md":          "---\ntype: note\n---\nN\n",
	})
	want := []Unread{{Path: "/backlog/bad-task.md", Label: titleFromFilename("/backlog/bad-task.md"), Error: readErr(t, badHeader)}}
	for _, id := range []string{"tasks", "all"} {
		b := board(t, srv, "/api/board/"+id)
		if !reflect.DeepEqual(b.Unread, want) {
			t.Errorf("%s: unread %+v, want %+v", id, b.Unread, want)
		}
		for _, c := range b.Columns {
			for _, card := range c.Cards {
				if card.Path == "/backlog/bad-task.md" {
					t.Errorf("%s: the unread entry is a card in column %q", id, c.Value)
				}
			}
		}
	}
	if _, body := getRaw(srv, "/api/board/notes"); !strings.Contains(body, `"unread":[]`) {
		t.Errorf("notes board: want \"unread\":[] in %s", body)
	}
}

// A card move onto a header the library can't edit safely (a flow-map
// header) is refused with a 422 carrying the refusal's text, and the file is
// left exactly as it was.
func TestRefusedCardMoveLeavesTheFile(t *testing.T) {
	const flow = "---\n{type: task, status: todo}\n---\nFlow\n"
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml": `spec = "0.1"

[[tool.wikiview.board]]
id   = "backlog"
path = "/backlog"
`,
		"backlog/flow.md": flow,
	})
	rec := httptest.NewRecorder()
	body, _ := json.Marshal(cardRequest{Value: "done", Version: versionOf(t, srv)})
	srv.ServeHTTP(rec, browserRequest(srv, http.MethodPut, "/api/card/backlog/backlog/flow.md", strings.NewReader(string(body))))
	var got errorBody
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if rec.Code != http.StatusUnprocessableEntity || !strings.HasPrefix(got.Error, "frontmatter of /backlog/flow.md can't be edited safely: ") {
		t.Errorf("PUT = %d, error %q; want 422 and the refusal", rec.Code, got.Error)
	}
	if after := raw(t, srv, "backlog/flow.md"); after != flow {
		t.Errorf("flow.md changed:\n%q", after)
	}
}

// /api/entry's frontmatter is the wiki CLI's string view, the text as YAML
// reads it: `wiki property raw` and `wiki list --format csv` on this file
// print exactly these values (checked against wiki v0.16.0).
func TestFrontmatterMatchesTheCLI(t *testing.T) {
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml": "spec = \"0.1\"\n",
		"values.md": `---
type: dataset
title: 'company''s filings'
note: "trailing space "
raw:
  - path: sources/10-K-2024.pdf
    pages: 40
  - path: sources/10-K-2025.pdf
    meta: {form: 10-K, year: 2025}
---
# Values
`,
	})
	var e EntryView
	if code := get(t, srv, "/api/entry/values.md", &e); code != http.StatusOK {
		t.Fatalf("GET = %d", code)
	}
	want := map[string]any{
		"type":  "dataset",
		"title": "company's filings",
		"note":  "trailing space ",
		"raw": []any{
			"{path: sources/10-K-2024.pdf, pages: 40}",
			"{path: sources/10-K-2025.pdf, meta: {form: 10-K, year: 2025}}",
		},
	}
	if !reflect.DeepEqual(e.Frontmatter, want) {
		t.Errorf("frontmatter\n got %#v\nwant %#v", e.Frontmatter, want)
	}
}

// An empty list item (`[a, ""]`, a bare `-`) is no tag: neither the bundle's
// tag list nor a card has one.
func TestEmptyTagsAreDropped(t *testing.T) {
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml": `spec = "0.1"

[[tool.wikiview.board]]
id    = "backlog"
path  = "/backlog"
where = []
`,
		"backlog/a.md": "---\ntype: task\nstatus: todo\ntags: [a, \"\"]\n---\nA\n",
		"backlog/b.md": "---\ntype: task\nstatus: todo\ntags:\n  -\n  - b\n---\nB\n",
	})
	var info BundleInfo
	if code := get(t, srv, "/api/bundle", &info); code != http.StatusOK {
		t.Fatalf("GET /api/bundle = %d", code)
	}
	if !reflect.DeepEqual(info.Tags, []string{"a", "b"}) {
		t.Errorf("bundle tags %q, want [a b]", info.Tags)
	}
	want := map[string][]string{"/backlog/a.md": {"a"}, "/backlog/b.md": {"b"}}
	for _, c := range board(t, srv, "/api/board/backlog").Columns {
		for _, card := range c.Cards {
			if !reflect.DeepEqual(card.Tags, want[card.Path]) {
				t.Errorf("%s: tags %q, want %q", card.Path, card.Tags, want[card.Path])
			}
		}
	}
}

// A card write that fails for a reason other than a refusal is the server's
// error, a 500: here the file was deleted after the index read it.
func TestFailedCardWriteIsA500(t *testing.T) {
	srv, _, dir := bundleServerIn(t, map[string]string{
		"wiki.toml": `spec = "0.1"

[[tool.wikiview.board]]
id   = "backlog"
path = "/backlog"
`,
		"backlog/gone.md": "---\ntype: task\nstatus: todo\n---\nGone\n",
	})
	at := versionOf(t, srv)
	if err := os.Remove(filepath.Join(dir, "backlog", "gone.md")); err != nil {
		t.Fatal(err)
	}
	if code, _ := put(t, srv, "/api/card/backlog/backlog/gone.md", cardRequest{Value: "done", Version: at}); code != http.StatusInternalServerError {
		t.Errorf("PUT = %d, want 500", code)
	}
}
