package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agentic-wiki/wiki-shell/internal/store"
)

// A page that links to .env or .git/config must not make them readable: once
// the browser can write page bodies (the editor ADR), any API writer can add
// that link itself. Fails today: both are served, git credentials included.
func TestRawNeverServesADotPath(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{
		"wiki.toml":   "spec = \"0.1\"\n",
		"index.md":    "# Home\n\n[c](.git/config) [e](.env)\n",
		".env":        "API_KEY=" + neverServed + "\n",
		".git/config": "[remote \"origin\"]\n\turl = https://user:" + neverServed + "@github.com/x/y.git\n",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv := New(s, nil, "localhost", 0)
	for _, p := range []string{"/raw/.env", "/raw/.git/config"} {
		rec := rawGet(t, srv, p)
		if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), neverServed) {
			t.Errorf("%s: %d, served a secret", p, rec.Code)
		}
	}
}

// The same rule on every read path, whatever leads to a dot path: an entry
// under one, a symlink to one, a symlink out of the bundle, a page's link.
func TestNoReadPathShowsADotPath(t *testing.T) {
	note := "---\ntype: note\n---\n"
	srv, _, dir := bundleServerIn(t, map[string]string{
		"wiki.toml":      "spec = \"0.1\"\n",
		"index.md":       "# Home\n\n[e](.env) [c](notes/cfg.txt) [s](notes/song.mp3)\n",
		".env":           "API_KEY=" + neverServed + "\n",
		".dot.md":        note + neverServed + "\n",
		"a/.hidden.md":   note + neverServed + "\n",
		".drafts/x.md":   note + neverServed + "\n",
		"notes/song.mp3": "ID3 not really",
		"notes/ok.md":    note + "fine\n",
	})
	for link, target := range map[string]string{
		"notes/cfg.txt": "../.env",                                     // a plain name, a dot path behind it
		"notes/env.md":  "../.env",                                     // an entry that is a dot path
		"notes/out.md":  "../../" + filepath.Base(dir) + "-outside.md", // out of the bundle
	} {
		if err := os.Symlink(target, filepath.Join(dir, filepath.FromSlash(link))); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(dir), filepath.Base(dir)+"-outside.md"), []byte(note+neverServed+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.store.Rebuild(); err != nil {
		t.Fatal(err)
	}

	for _, p := range []string{"/raw/.env", "/raw/notes/cfg.txt", "/raw/notes/env.md", "/raw/notes/out.md"} {
		if rec := rawGet(t, srv, p); rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), neverServed) {
			t.Errorf("%s: %d", p, rec.Code)
		}
	}
	for _, p := range []string{"/api/entry/.dot.md", "/api/entry/a/.hidden.md", "/api/entry/.drafts/x.md", "/api/entry/notes/env.md", "/api/entry/notes/out.md"} {
		rec := rawGet(t, srv, p)
		if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), neverServed) {
			t.Errorf("%s: %d", p, rec.Code)
		}
	}
	// The page still renders: the link to .env gets no /raw address.
	var home EntryView
	if code := get(t, srv, "/api/entry/index.md", &home); code != http.StatusOK {
		t.Fatalf("index.md: %d", code)
	}
	for _, l := range home.Links {
		if strings.Contains(l.Asset, ".env") {
			t.Errorf("a /raw address for a dot path: %+v", l)
		}
	}
	// Plain paths still serve: audio, and an entry.
	if rec := rawGet(t, srv, "/raw/notes/song.mp3"); rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "audio/mpeg" {
		t.Errorf("song.mp3: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if code := get(t, srv, "/api/entry/notes/ok.md", nil); code != http.StatusOK {
		t.Errorf("ok.md: %d", code)
	}
}
