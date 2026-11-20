package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agentic-wiki/wiki/parse"
)

// draftServer is a bundle declaring its types, with a folder, an entry and a
// file already at /spec/taken.md.
func draftServer(t *testing.T) *Server {
	t.Helper()
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml":     "spec = \"0.1\"\ntypes = [\"spec\", \"note\"]\nignore = [\"drafts/**\"]\n",
		"index.md":      "---\nokf_version: \"0.1\"\n---\nhome\n",
		"spec/thing.md": "---\ntype: spec\n---\nthing\n",
		"spec/taken.md": "---\ntype: spec\n---\ntaken\n",
	})
	return srv
}

func draftEntry(t *testing.T, srv *Server, in, typ, title string) (int, map[string]string) {
	t.Helper()
	q := url.Values{"in": {in}, "type": {typ}, "title": {title}}
	code, body := call(t, srv, http.MethodGet, "/api/entries/new?"+q.Encode(), nil)
	var out map[string]string
	json.Unmarshal(body, &out)
	return code, out
}

// The draft names the file from the title, in the folder given or in an
// entry's own folder (never thing/index.md), with a header of type, title and
// an empty tags list, nothing else (the CEO's call); a title YAML would
// misread comes back quoted, and reads back as written.
func TestDraftAnEntry(t *testing.T) {
	srv := draftServer(t)
	for name, c := range map[string]struct{ in, title, path string }{
		"in a folder":      {"/spec", "Settlement rules", "/spec/settlement-rules.md"},
		"in a folder, /":   {"/spec/", "Settlement rules", "/spec/settlement-rules.md"},
		"under an entry":   {"/spec/thing.md", "A part", "/spec/thing/a-part.md"},
		"at the root":      {"", "Top", "/top.md"},
		"a title to quote": {"/spec", "Q3: plan, v2", "/spec/q3-plan-v2.md"},
	} {
		code, out := draftEntry(t, srv, c.in, "spec", c.title)
		if code != http.StatusOK || out["path"] != c.path {
			t.Errorf("%s: %d %v, want %s", name, code, out, c.path)
			continue
		}
		fm, body := parse.Frontmatter(out["content"])
		if fm["type"] != "spec" || fm["title"] != c.title || body != "" || len(fm) != 3 {
			t.Errorf("%s: content %q reads %v, body %q", name, out["content"], fm, body)
		}
	}
	if _, out := draftEntry(t, srv, "/spec", "spec", "Settlement rules"); out["content"] != "---\ntype: spec\ntitle: Settlement rules\ntags: []\n---\n" {
		t.Errorf("the header: %q", out["content"])
	}
	// Writes nothing.
	if _, err := os.Stat(filepath.Join(srv.store.Dir, "spec", "settlement-rules.md")); err == nil {
		t.Error("the draft wrote a file")
	}
	// Posted unchanged, it creates the entry.
	_, out := draftEntry(t, srv, "/spec", "spec", "Settlement rules")
	if code, body := call(t, srv, http.MethodPost, "/api/entries", out); code != http.StatusCreated {
		t.Errorf("posting the draft: %d %s", code, body)
	}
}

// A taken path is 409; a title with no letter or digit, a type wiki.toml
// doesn't declare (or none), a reserved file's name, or an `in` that leaves
// the bundle, names a dot path or is one wiki.toml ignores is 422.
func TestDraftRefusals(t *testing.T) {
	srv := draftServer(t)
	if code, out := draftEntry(t, srv, "/spec", "spec", "Taken"); code != http.StatusConflict || out["error"] != "There is already an entry at /spec/taken.md." || out["path"] != "/spec/taken.md" {
		t.Errorf("a taken path: %d %v", code, out)
	}
	// Create's 409 says the same, with the taken path, for "Open it".
	code, body := call(t, srv, http.MethodPost, "/api/entries", map[string]string{"path": "spec/taken.md", "content": "---\ntype: spec\n---\n"})
	var out map[string]string
	if json.Unmarshal(body, &out); code != http.StatusConflict || out["error"] != "There is already an entry at /spec/taken.md." || out["path"] != "/spec/taken.md" {
		t.Errorf("create over a file: %d %s", code, body)
	}
	for name, c := range map[string]struct{ in, typ, title string }{
		"no letter or digit": {"/spec", "spec", "!!! ---"},
		"an undeclared type": {"/spec", "memo", "A memo"},
		"no type":            {"/spec", "", "Untyped"},
		"index":              {"/spec", "spec", "Index"},
		"log":                {"/spec", "spec", "LOG"},
		"climbing out":       {"/../outside", "spec", "Out"},
		"a dot folder":       {"/.drafts", "spec", "Hidden"},
		"an empty segment":   {"/spec//x", "spec", "Empty"},
	} {
		if code, out := draftEntry(t, srv, c.in, c.typ, c.title); code != http.StatusUnprocessableEntity || out["error"] == "" {
			t.Errorf("%s: %d %v", name, code, out)
		}
	}
	// A folder wiki.toml ignores is refused by the draft, with Create's own
	// reason, not only when posted.
	if code, out := draftEntry(t, srv, "/drafts", "spec", "Ignored"); code != http.StatusUnprocessableEntity || !strings.Contains(out["error"], "ignore") {
		t.Errorf("an ignored folder: %d %v", code, out)
	}
}

// A draft writes nothing, so a read-only network bind allows it.
func TestDraftOnAReadOnlyBind(t *testing.T) {
	srv := newNetworkServer(t)
	if code, out := draftEntry(t, srv, "/notes", "note", "From afar"); code != http.StatusOK || out["path"] != "/notes/from-afar.md" {
		t.Errorf("%d %v", code, out)
	}
}
