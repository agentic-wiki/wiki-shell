package ui

import (
	"bytes"
	"encoding/json"
	"flag"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/agentic-wiki/wiki/parse"
)

var update = flag.Bool("update", false, "rewrite src/edit/testdata/corpus.json")

// corpusFile holds the pages the editor's tests load, each with its blocks as
// the server splits them. The browser never splits a page (editor-adr.md), so
// its tests take the blocks from wiki's own splitter, through this file.
const corpusFile = "src/edit/testdata/corpus.json"

type corpusPage struct {
	Path   string        `json:"path"`
	Body   string        `json:"body"`
	Blocks []parse.Block `json:"blocks"`
}

// TestEditorCorpus keeps corpus.json in step with the pages and with wiki's
// splitter: a frozen copy of this repo's backlog, the pages `wiki init --full`
// scaffolds, and src/edit/testdata/kinds.md, a page of every kind. After
// changing kinds.md, or wiki's version: go test ./ui -run EditorCorpus -update.
//
// The backlog pages are read from corpus.json itself, not from ../backlog, so
// editing the backlog never fails this test: they are real-shaped pages, and
// only their blocks are checked against the splitter.
func TestEditorCorpus(t *testing.T) {
	var pages []corpusPage
	raw, err := os.ReadFile(corpusFile)
	if err != nil {
		t.Fatal(err)
	}
	var stored []corpusPage
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	for _, p := range stored {
		if strings.HasPrefix(p.Path, "backlog/") {
			pages = append(pages, corpusPage{p.Path, p.Body, nonNil(parse.Blocks(p.Body))})
		}
	}
	add := func(fsys fs.FS, prefix string) {
		err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(p, ".md") {
				return err
			}
			raw, err := fs.ReadFile(fsys, p)
			if err != nil {
				return err
			}
			body := parse.Body(string(raw))
			pages = append(pages, corpusPage{prefix + p, body, nonNil(parse.Blocks(body))})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	add(os.DirFS(filepath.Join(wikiDir(t), "internal/scaffold/files")), "scaffold/")
	add(os.DirFS("src/edit/testdata"), "testdata/")
	sort.Slice(pages, func(i, j int) bool { return pages[i].Path < pages[j].Path })

	// One page a line, so a change to the splitter shows as the pages it moved.
	var got []byte
	for i, p := range pages {
		line, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, "[,"[min(i, 1)])
		got = append(append(got, line...), '\n')
	}
	got = append(got, "]\n"...)
	if *update {
		if err := os.WriteFile(corpusFile, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	if !bytes.Equal(got, raw) {
		t.Fatalf("%s is stale: run go test ./ui -run EditorCorpus -update", corpusFile)
	}
}

// wikiDir is where the wiki module's source is, for its scaffold's pages.
func wikiDir(t *testing.T) string {
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/agentic-wiki/wiki").Output()
	if err != nil {
		t.Fatalf("finding the wiki module: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func nonNil(bs []parse.Block) []parse.Block {
	if bs == nil {
		return []parse.Block{}
	}
	return bs
}
