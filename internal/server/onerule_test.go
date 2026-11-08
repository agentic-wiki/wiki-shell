package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// getStatus is a GET's status and body bytes, for a file route.
func getStatus(srv *Server, path string) (int, string) {
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, browserRequest(srv, http.MethodGet, path, nil))
	return rec.Code, rec.Body.String()
}

// An image is read by the library's one rule: one named with a space loads
// through its escaped asset URL, and a link climbing out of the bundle, even
// spelled %2e%2e, gets no asset and nothing from /raw.
func TestAssetsByTheOneRule(t *testing.T) {
	srv, _, dir := bundleServerIn(t, map[string]string{
		"wiki.toml":  "spec = \"0.1\"\n",
		"a.md":       "---\ntype: note\n---\n![p](my%20pic.png) ![o](%2e%2e/x.png)\n",
		"my pic.png": "PNG",
	})
	if err := os.WriteFile(filepath.Join(filepath.Dir(dir), "x.png"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	var e EntryView
	get(t, srv, "/api/entry/a.md", &e)
	assets := map[string]string{}
	for _, l := range e.Links {
		assets[l.Raw] = l.Asset
		if l.Raw == "%2e%2e/x.png" && !l.Outside {
			t.Errorf("%%2e%%2e/x.png isn't outside: %+v", l)
		}
	}
	if assets["my%20pic.png"] != "/raw/my%20pic.png" || assets["%2e%2e/x.png"] != "" {
		t.Errorf("assets %q", assets)
	}
	if code, body := getStatus(srv, "/raw/my%20pic.png"); code != http.StatusOK || body != "PNG" {
		t.Errorf("/raw/my%%20pic.png: %d %q", code, body)
	}
	if code, body := getStatus(srv, "/raw/%2e%2e/x.png"); code != http.StatusNotFound || body == "secret" {
		t.Errorf("/raw/%%2e%%2e/x.png: %d %q, want 404", code, body)
	}
	// Spelled as plain .., the router cleans the path and redirects: never the file.
	if _, body := getStatus(srv, "/raw/../x.png"); body == "secret" {
		t.Error("/raw/../x.png served the file above the bundle")
	}
}

// An untitled entry is called by its first `#` heading, by the library's
// rule, wherever it is named: its page, the tree, a card and a graph node.
func TestUntitledEntriesShowTheirHeading(t *testing.T) {
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml": "spec = \"0.1\"\n\n[[tool.wikiview.board]]\nid = \"b\"\npath = \"/\"\nwhere = []\n\n[[tool.wikiview.graph]]\nid = \"g\"\npath = \"/\"\n",
		"plain.md":  "---\ntype: note\n---\n# The Heading\n",
	})
	var e EntryView
	get(t, srv, "/api/entry/plain.md", &e)
	var tree TreeNode
	get(t, srv, "/api/tree", &tree)
	card := ""
	for _, c := range board(t, srv, "/api/board/b").Columns {
		for _, k := range c.Cards {
			if k.Path == "/plain.md" {
				card = k.Title
			}
		}
	}
	var g GraphView
	get(t, srv, "/api/graph/g", &g)
	node := ""
	for _, n := range g.Nodes {
		if n.Path == "/plain.md" {
			node = n.Title
		}
	}
	stub := ""
	for _, s := range tree.Entries {
		if s.Path == "/plain.md" {
			stub = s.Title
		}
	}
	for where, got := range map[string]string{"entry": e.Title, "tree": stub, "card": card, "graph": node} {
		if got != "The Heading" {
			t.Errorf("%s title %q, want The Heading", where, got)
		}
	}
}

// A frontmatter reference with an #anchor is a reference all the same: it
// makes a blocker on a board and an edge on a graph.
func TestRefsWithAnAnchor(t *testing.T) {
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml": "spec = \"0.1\"\n\n[[tool.wikiview.board]]\nid = \"b\"\npath = \"/\"\n\n[[tool.wikiview.graph]]\nid = \"g\"\npath = \"/\"\n",
		"a.md":      "---\ntype: task\nstatus: todo\nblockers: [./b.md#step-2]\n---\n",
		"b.md":      "---\ntype: task\nstatus: todo\n---\n# B\n## Step 2\n",
	})
	blocked := -1
	for _, c := range board(t, srv, "/api/board/b").Columns {
		for _, k := range c.Cards {
			if k.Path == "/a.md" {
				blocked = k.BlockedBy
			}
		}
	}
	if blocked != 1 {
		t.Errorf("a.md BlockedBy %d, want 1", blocked)
	}
	var g GraphView
	get(t, srv, "/api/graph/g", &g)
	found := false
	for _, edge := range g.Edges {
		found = found || edge.From == "/a.md" && edge.To == "/b.md" && slices.Contains(edge.Via, "blockers")
	}
	if !found {
		t.Errorf("no blockers edge a -> b: %+v", g.Edges)
	}
}

// A ref chip is named as a card's blocker is: the target's title by the wiki's
// rule (here its first heading), else its filename made readable.
func TestRefChipsNameTheirTarget(t *testing.T) {
	srv, _ := bundleServer(t, map[string]string{
		"wiki.toml": "spec = \"0.1\"\n",
		"a.md":      "---\ntype: task\nblockers: [./b.md, ./c.md]\n---\n",
		"b.md":      "---\ntype: task\n---\n# Ship the beta\n",
		"c.md":      "---\ntype: task\n---\nno heading\n",
	})
	var e EntryView
	get(t, srv, "/api/entry/a.md", &e)
	labels := map[string]string{}
	for _, r := range e.FrontmatterRefs {
		labels[r.To] = r.Label
	}
	if labels["/b.md"] != "Ship the beta" || labels["/c.md"] != "C" {
		t.Errorf("labels %q", labels)
	}
}
