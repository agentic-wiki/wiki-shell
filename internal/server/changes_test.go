package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agentic-wiki/wiki-shell/internal/git"
	"github.com/agentic-wiki/wiki/index"
	"github.com/agentic-wiki/wiki/parse"
)

const pageA = `---
type: note
status: todo
---
# A

First paragraph.

- one
- two
- three

Middle paragraph.

## Later

Last paragraph.
`

// newChangesServer is a git bundle with notes/a.md committed.
func newChangesServer(t *testing.T) *Server {
	t.Helper()
	srv, _ := newGitServer(t)
	writeFile(t, srv, "notes/a.md", pageA)
	gitIn(t, srv.store.Dir, "add", ".")
	gitIn(t, srv.store.Dir, "commit", "--quiet", "--message", "a")
	return srv
}

// writeFile writes a bundle file and rebuilds the index, as the watcher would.
func writeFile(t *testing.T, srv *Server, rel, content string) {
	t.Helper()
	p := filepath.Join(srv.store.Dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := srv.RebuildAndNotify(); err != nil {
		t.Fatal(err)
	}
}

func listChanges(t *testing.T, srv *Server) (map[string]changeView, int) {
	t.Helper()
	var got struct {
		Repo    bool         `json:"repo"`
		Files   []changeView `json:"files"`
		Outside int          `json:"outside"`
	}
	if code := get(t, srv, "/api/changes", &got); code != http.StatusOK || !got.Repo {
		t.Fatalf("GET /api/changes: %d %+v", code, got)
	}
	m := map[string]changeView{}
	for _, f := range got.Files {
		m[f.Path] = f
	}
	return m, got.Outside
}

type diffAnswer struct {
	Version string  `json:"version"`
	Raw     *string `json:"raw"`
	Blocks  *struct {
		Ops  []parse.Op    `json:"ops"`
		Head []parse.Block `json:"head"`
	} `json:"blocks"`
	Fields []fieldDiff `json:"fields"`
	Header *bool       `json:"header"`
	Hunks  []hunk      `json:"hunks"`
}

func diffAt(t *testing.T, srv *Server, path string) diffAnswer {
	t.Helper()
	var d diffAnswer
	if code := get(t, srv, "/api/changes"+path, &d); code != http.StatusOK {
		t.Fatalf("GET /api/changes%s: %d", path, code)
	}
	return d
}

func discard(t *testing.T, srv *Server, path, version string, hunk *int) (int, string) {
	t.Helper()
	req := map[string]any{"path": path, "version": version}
	if hunk != nil {
		req["hunk"] = *hunk
	}
	code, body := call(t, srv, http.MethodPost, "/api/changes/discard", req)
	return code, string(body)
}

func intp(i int) *int { return &i }

// The list names every kind of change: a page, a rename, a text file, a dot
// path (by name only), a symlink (never followed), a large and a binary file.
// A network bind leaves dot paths out.
func TestChangesListsEveryKind(t *testing.T) {
	srv := newChangesServer(t)
	dir := srv.store.Dir
	writeFile(t, srv, "notes/b.md", "---\ntype: note\n---\n"+strings.Repeat("a line that stays\n", 20))
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "--quiet", "--message", "b")

	writeFile(t, srv, "notes/a.md", strings.Replace(pageA, "First paragraph.", "First paragraph, changed.", 1))
	gitIn(t, dir, "mv", "notes/b.md", "notes/c.md")
	gitIn(t, dir, "reset", "--quiet")
	writeFile(t, srv, "wiki.toml", "spec = \"0.1\"\ntitle = \"T\"\n")
	writeFile(t, srv, ".env", "TOKEN=secret\n")
	writeFile(t, srv, "big.csv", strings.Repeat("x", git.MaxDiffSize+1))
	writeFile(t, srv, "logo.png", "\x89PNG\x00\x00binary")
	if err := os.Symlink("../nowhere/secret.md", filepath.Join(dir, "link.md")); err != nil {
		t.Fatal(err)
	}

	got, outside := listChanges(t, srv)
	check := func(path, change, kind string) changeView {
		t.Helper()
		c, ok := got[path]
		if !ok || c.Change != change || c.Kind != kind {
			t.Errorf("%s: %+v, want %s %s", path, c, change, kind)
		}
		return c
	}
	if c := check("/notes/a.md", "modified", "page"); c.Title != "A" || *c.Added != 1 || *c.Removed != 1 || c.Version != index.FileVersion([]byte(fileAt(t, srv, "/notes/a.md"))) {
		t.Errorf("the page: %+v", c)
	}
	if c := check("/notes/c.md", "renamed", "page"); c.From != "/notes/b.md" || *c.Added != 0 {
		t.Errorf("the rename: %+v", c)
	}
	if c := check("/wiki.toml", "modified", "text"); *c.Added != 1 || *c.Removed != 0 {
		t.Errorf("the text file: %+v", c)
	}
	if c := check("/.env", "new", "dot"); c.Version != "" || c.Added != nil {
		t.Errorf("the dot path: %+v", c)
	}
	if c := check("/big.csv", "new", "text"); c.Size != git.MaxDiffSize+1 || c.Added != nil || c.Version != index.FileVersion([]byte(strings.Repeat("x", git.MaxDiffSize+1))) {
		t.Errorf("the large file: %+v", c)
	}
	check("/logo.png", "new", "binary")
	if c := check("/link.md", "new", "link"); c.Version != index.FileVersion([]byte("../nowhere/secret.md")) {
		t.Errorf("the link: %+v", c)
	}
	if len(got) != 7 || outside != 0 {
		t.Errorf("%d files, outside %d: %+v", len(got), outside, got)
	}

	network := New(srv.store, nil, "0.0.0.0", 0)
	network.shadow = git.NewShadow(t.TempDir())
	if got, _ := listChanges(t, network); got["/.env"].Path != "" || len(got) != 6 {
		t.Errorf("a network bind lists %+v", got)
	}
}

// A page's diff: HEAD's blocks, the operations, the fields, and the hunks the
// server numbers: fields first, then block runs, a move on its own.
func TestAPageDiffNumbersItsHunks(t *testing.T) {
	srv := newChangesServer(t)
	now := strings.Replace(pageA, "status: todo", "status: done", 1)
	now = strings.Replace(now, "- two\n", "- two, changed\n", 1)
	now = strings.Replace(now, "Middle paragraph.\n\n", "", 1)
	now += "\nMiddle paragraph.\n"
	writeFile(t, srv, "notes/a.md", now)

	d := diffAt(t, srv, "/notes/a.md")
	if d.Version != index.FileVersion([]byte(now)) || d.Raw == nil || !strings.Contains(*d.Raw, "+- two, changed") {
		t.Errorf("version or raw: %+v", d)
	}
	if d.Blocks == nil || len(d.Blocks.Head) != 8 || len(d.Fields) != 1 || d.Fields[0] != (fieldDiff{"status", "todo", "done"}) {
		t.Fatalf("blocks or fields: %+v", d)
	}
	if len(d.Hunks) != 3 || d.Hunks[0].Kind != "field" || d.Hunks[0].Key != "status" || d.Hunks[1].Kind != "blocks" || d.Hunks[2].Kind != "move" {
		t.Fatalf("hunks: %+v", d.Hunks)
	}
	if op := d.Blocks.Ops[d.Hunks[1].Ops[0]]; op.Op != "replace" || op.At != 3 {
		t.Errorf("the block hunk is %+v", op)
	}
	if op := d.Blocks.Ops[d.Hunks[2].Ops[0]]; op.Op != "move" || op.At != 5 {
		t.Errorf("the move is %+v", op)
	}

	for path, want := range map[string]int{"/.env": http.StatusForbidden, "/notes/.x.md": http.StatusForbidden, "/index.md": http.StatusNotFound} {
		if code := get(t, srv, "/api/changes"+path, nil); code != want {
			t.Errorf("%s: %d, want %d", path, code, want)
		}
	}
}

// A header whose bytes changed says so, even when no field's value did (a
// key moved): the layout-only row. An unchanged header sends no `header`.
func TestAPageDiffSaysItsHeaderChanged(t *testing.T) {
	srv := newChangesServer(t)
	writeFile(t, srv, "notes/a.md", strings.Replace(pageA, "type: note\nstatus: todo\n", "status: todo\ntype: note\n", 1))
	if d := diffAt(t, srv, "/notes/a.md"); d.Header == nil || !*d.Header || len(d.Fields) != 0 {
		t.Errorf("a key moved: header %v, fields %+v", d.Header, d.Fields)
	}
	writeFile(t, srv, "notes/a.md", strings.Replace(pageA, "First paragraph.", "First, changed.", 1))
	if code, body := call(t, srv, http.MethodGet, "/api/changes/notes/a.md", nil); code != http.StatusOK || strings.Contains(string(body), `"header"`) {
		t.Errorf("an unchanged header: %d %s", code, body)
	}
	// A new page has no HEAD to compare with: no `header` either.
	writeFile(t, srv, "notes/new.md", "---\ntype: note\n---\nNew.\n")
	if code, body := call(t, srv, http.MethodGet, "/api/changes/notes/new.md", nil); code != http.StatusOK || strings.Contains(string(body), `"header"`) {
		t.Errorf("a new page: %d %s", code, body)
	}
}

// Operations next to each other, or with only a moved block between them,
// are one hunk; an unchanged block between them makes two.
func TestBlockHunksAreRunsBetweenUnchangedBlocks(t *testing.T) {
	ops := []parse.Op{
		{Op: "replace", At: 1}, {Op: "insert", After: 1}, {Op: "delete", At: 2}, // one run
		{Op: "move", At: 3, After: 9}, {Op: "replace", At: 4}, // the move between doesn't split
		{Op: "delete", At: 6}, // block 5 is unchanged: a new run
		{Op: "insert", After: 6},
	}
	got := pageDiff{ops: ops}.hunks(true)
	// The move's old place doesn't split the run around it, so 4 joins 0–2.
	want := []hunk{{Kind: "blocks", Ops: []int{0, 1, 2, 4}}, {Kind: "move", Ops: []int{3}}, {Kind: "blocks", Ops: []int{5, 6}}}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Errorf("hunks\n%s\nwant\n%s", gotJSON, wantJSON)
	}
}

// A discard at a version that moved is refused, and nothing changes.
func TestDiscardIsRefusedOnAChangedVersion(t *testing.T) {
	srv := newChangesServer(t)
	writeFile(t, srv, "notes/a.md", strings.Replace(pageA, "First", "Changed", 1))
	shown := diffAt(t, srv, "/notes/a.md").Version
	later := strings.Replace(pageA, "First", "Changed again", 1)
	writeFile(t, srv, "notes/a.md", later)

	for _, h := range []*int{nil, intp(0)} {
		code, body := discard(t, srv, "/notes/a.md", shown, h)
		if code != http.StatusConflict || !strings.Contains(body, index.FileVersion([]byte(later))) {
			t.Errorf("%d %s", code, body)
		}
		if fileAt(t, srv, "/notes/a.md") != later {
			t.Error("the file changed")
		}
	}
	if code, _ := discard(t, srv, "/notes/a.md", index.FileVersion([]byte(later)), intp(5)); code != http.StatusUnprocessableEntity {
		t.Errorf("a hunk out of range: %d", code)
	}
	if code, _ := discard(t, srv, "/index.md", "x", nil); code != http.StatusNotFound {
		t.Errorf("an unchanged file: %d", code)
	}
	if code, _ := discard(t, srv, "/.env", "", nil); code != http.StatusForbidden {
		t.Errorf("a dot path: %d", code)
	}
}

// Undoing a page's hunks one at a time gives back HEAD's bytes exactly, and
// each discard leaves the other changes alone.
func TestAPageHunkIsUndoneExactly(t *testing.T) {
	for _, fromEnd := range []bool{true, false} {
		srv := newChangesServer(t)
		now := strings.Replace(pageA, "status: todo", "status: done\ntags: [x]", 1)
		now = strings.Replace(now, "- two\n", "- two, changed\n- two and a half\n", 1)
		now = strings.Replace(now, "Middle paragraph.\n\n", "", 1)
		now = strings.Replace(now, "## Later\n", "## Later\n\nA new paragraph.\n", 1)
		now = strings.Replace(now, "# A\n", "Intro.\n\n# A\n", 1)
		now = strings.Replace(now, "Last paragraph.\n", "Last paragraph.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", 1)
		writeFile(t, srv, "notes/a.md", now)

		for round := 0; fileAt(t, srv, "/notes/a.md") != pageA; round++ {
			d := diffAt(t, srv, "/notes/a.md")
			if round > 10 {
				t.Fatalf("hunks left: %+v", d.Hunks)
			}
			before := fileAt(t, srv, "/notes/a.md")
			n := 0
			if fromEnd {
				n = len(d.Hunks) - 1
			}
			code, body := discard(t, srv, "/notes/a.md", d.Version, &n)
			if code != http.StatusOK {
				t.Fatalf("round %d, hunk %+v: %d %s", round, d.Hunks[n], code, body)
			}
			after := fileAt(t, srv, "/notes/a.md")
			if after == before {
				t.Fatalf("round %d: nothing changed", round)
			}
			if !strings.Contains(body, index.FileVersion([]byte(after))) {
				t.Errorf("round %d: %s", round, body)
			}
		}
		if listed, _ := listChanges(t, srv); len(listed) != 0 {
			t.Errorf("still changed: %+v", listed)
		}
	}
}

// A field hunk puts HEAD's own lines for the key back, so an empty value
// comes back empty (not `z: ""`), and the file is no longer a change.
func TestAFieldComesBackExactly(t *testing.T) {
	srv := newChangesServer(t)
	head := strings.Replace(pageA, "status: todo\n", "status: todo\nz:\n", 1)
	writeFile(t, srv, "notes/a.md", head)
	gitIn(t, srv.store.Dir, "commit", "--quiet", "--all", "--message", "z")
	writeFile(t, srv, "notes/a.md", strings.Replace(head, "z:\n", "z: x\n", 1))
	d := diffAt(t, srv, "/notes/a.md")
	if len(d.Hunks) != 1 || d.Hunks[0].Kind != "field" {
		t.Fatalf("hunks %+v", d.Hunks)
	}
	if code, body := discard(t, srv, "/notes/a.md", d.Version, intp(0)); code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	if listed, _ := listChanges(t, srv); len(listed) != 0 {
		t.Errorf("still listed: %+v; file %q", listed, fileAt(t, srv, "/notes/a.md"))
	}
}

// One block hunk undone leaves the others, and the fields, as they are.
func TestDiscardingOneHunkKeepsTheOthers(t *testing.T) {
	srv := newChangesServer(t)
	now := strings.Replace(pageA, "status: todo", "status: done", 1)
	now = strings.Replace(now, "First paragraph.", "First, changed.", 1)
	now = strings.Replace(now, "Last paragraph.", "Last, changed.", 1)
	writeFile(t, srv, "notes/a.md", now)
	d := diffAt(t, srv, "/notes/a.md")
	if len(d.Hunks) != 3 {
		t.Fatalf("hunks %+v", d.Hunks)
	}
	if code, body := discard(t, srv, "/notes/a.md", d.Version, intp(1)); code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	want := strings.Replace(now, "First, changed.", "First paragraph.", 1)
	if got := fileAt(t, srv, "/notes/a.md"); got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

// A block moved next to a new one (Dessy's case) is a move and an insert,
// two hunks, and each can be discarded alone: the move goes back without
// duplicating the block, and the new block goes without taking the move.
func TestAMoveNextToAnInsertDiscardsAlone(t *testing.T) {
	const head = "---\ntype: note\n---\n## Goals\n\nShip it.\n\nKeep the files plain Markdown.\n\n## Risks\n\nScope creep.\n"
	const now = "---\ntype: note\n---\n## Goals\n\nShip it.\n\n## Risks\n\nScope creep.\n\nKeep the files plain Markdown.\n\nA new risk.\n"
	for name, c := range map[string]struct {
		kind string
		want string
	}{
		"the move":   {"move", "---\ntype: note\n---\n## Goals\n\nShip it.\n\nKeep the files plain Markdown.\n\n## Risks\n\nScope creep.\n\nA new risk.\n"},
		"the insert": {"blocks", now[:strings.Index(now, "\n\nA new risk.")] + "\n"},
	} {
		t.Run(name, func(t *testing.T) {
			srv := newChangesServer(t)
			writeFile(t, srv, "notes/plan.md", head)
			gitIn(t, srv.store.Dir, "add", ".")
			gitIn(t, srv.store.Dir, "commit", "--quiet", "--message", "plan")
			writeFile(t, srv, "notes/plan.md", now)
			d := diffAt(t, srv, "/notes/plan.md")
			if len(d.Hunks) != 2 || d.Hunks[0].Kind != "move" || d.Hunks[1].Kind != "blocks" {
				t.Fatalf("hunks %+v", d.Hunks)
			}
			n := 0
			if c.kind == "blocks" {
				n = 1
			}
			if code, body := discard(t, srv, "/notes/plan.md", d.Version, &n); code != http.StatusOK {
				t.Fatalf("%d %s", code, body)
			}
			if got := fileAt(t, srv, "/notes/plan.md"); got != c.want {
				t.Errorf("got\n%q\nwant\n%q", got, c.want)
			}
		})
	}
}

// A moved block goes back after its old neighbour.
func TestAMoveIsUndone(t *testing.T) {
	srv := newChangesServer(t)
	now := strings.Replace(pageA, "Middle paragraph.\n\n", "", 1) + "\nMiddle paragraph.\n"
	writeFile(t, srv, "notes/a.md", now)
	d := diffAt(t, srv, "/notes/a.md")
	if len(d.Hunks) != 1 || d.Hunks[0].Kind != "move" {
		t.Fatalf("hunks %+v", d.Hunks)
	}
	if code, body := discard(t, srv, "/notes/a.md", d.Version, intp(0)); code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	if got := fileAt(t, srv, "/notes/a.md"); got != pageA {
		t.Errorf("got\n%s", got)
	}
}

// A text file's hunk is undone by line; whole files are restored, deleted
// when new (a link itself, never its target), and a rename is undone.
func TestDiscardTextHunksAndWholeFiles(t *testing.T) {
	srv := newChangesServer(t)
	dir := srv.store.Dir
	var lines []string
	for i := 1; i <= 30; i++ {
		lines = append(lines, strings.Repeat("v", i))
	}
	data := strings.Join(lines, "\n") + "\n"
	writeFile(t, srv, "data.csv", data)
	writeFile(t, srv, "notes/b.md", "---\ntype: note\n---\n"+strings.Repeat("a line that stays\n", 20))
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "--quiet", "--message", "data")

	changed := append([]string{}, lines...)
	changed[1], changed[27] = "two", "twenty-eight"
	writeFile(t, srv, "data.csv", strings.Join(changed, "\n")+"\n")
	d := diffAt(t, srv, "/data.csv")
	if len(d.Hunks) != 2 || d.Hunks[1].Kind != "lines" || *d.Hunks[1].At != 1 || d.Blocks != nil {
		t.Fatalf("%+v", d)
	}
	if code, body := discard(t, srv, "/data.csv", d.Version, intp(1)); code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	changed[27] = lines[27]
	if got := fileAt(t, srv, "/data.csv"); got != strings.Join(changed, "\n")+"\n" {
		t.Errorf("after the hunk:\n%s", got)
	}
	listed, _ := listChanges(t, srv)
	if code, body := discard(t, srv, "/data.csv", listed["/data.csv"].Version, nil); code != http.StatusOK || fileAt(t, srv, "/data.csv") != data {
		t.Errorf("the whole file: %d %s", code, body)
	}

	target := filepath.Join(t.TempDir(), "target.md")
	os.WriteFile(target, []byte("outside\n"), 0o644)
	os.Symlink(target, filepath.Join(dir, "link.md"))
	writeFile(t, srv, "notes/new.md", "---\ntype: note\n---\nnew\n")
	gitIn(t, dir, "mv", "notes/b.md", "notes/c.md")
	gitIn(t, dir, "reset", "--quiet")
	listed, _ = listChanges(t, srv)
	for _, p := range []string{"/link.md", "/notes/new.md", "/notes/c.md"} {
		if code, body := discard(t, srv, p, listed[p].Version, nil); code != http.StatusOK || body != `{"version":""}`+"\n" && body != `{"version":""}` {
			t.Errorf("%s: %d %s", p, code, body)
		}
	}
	if _, err := os.Lstat(filepath.Join(dir, "link.md")); err == nil {
		t.Error("the link is still there")
	}
	if b, err := os.ReadFile(target); err != nil || string(b) != "outside\n" {
		t.Error("the link's target was touched")
	}
	if _, err := os.Stat(filepath.Join(dir, "notes", "b.md")); err != nil {
		t.Error("the rename wasn't undone")
	}
	if listed, _ := listChanges(t, srv); len(listed) != 0 {
		t.Errorf("left: %+v", listed)
	}
}

// A new or deleted text file has no line hunks: only the whole file is
// discarded.
func TestANewTextFileHasNoHunks(t *testing.T) {
	srv := newChangesServer(t)
	writeFile(t, srv, "data.csv", "a\nb\n")
	if d := diffAt(t, srv, "/data.csv"); len(d.Hunks) != 0 || d.Raw == nil {
		t.Errorf("%+v", d)
	}
}

// A discard waits for a git action (a pull, a commit) to finish, so it never
// writes a file the action is changing.
func TestADiscardWaitsForAGitAction(t *testing.T) {
	srv := newChangesServer(t)
	writeFile(t, srv, "notes/a.md", strings.Replace(pageA, "First", "Changed", 1))
	shown := diffAt(t, srv, "/notes/a.md").Version

	srv.acting.Lock()
	done := make(chan int)
	go func() {
		code, _ := discard(t, srv, "/notes/a.md", shown, nil)
		done <- code
	}()
	select {
	case code := <-done:
		t.Fatalf("discarded during a git action: %d", code)
	case <-time.After(200 * time.Millisecond):
	}
	srv.acting.Unlock()
	if code := <-done; code != http.StatusOK {
		t.Errorf("after the action: %d", code)
	}
}

// A new page is a page from its path alone, before the watcher has indexed
// it: its hunks are the same before and after the rebuild, and one can be
// discarded before it.
func TestANewPageIsAPageBeforeTheRebuild(t *testing.T) {
	srv := newChangesServer(t)
	p := filepath.Join(srv.store.Dir, "notes", "new.md")
	content := "---\ntype: note\n---\nOne.\n\nTwo.\n"
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil { // no rebuild
		t.Fatal(err)
	}
	if listed, _ := listChanges(t, srv); listed["/notes/new.md"].Kind != "page" {
		t.Fatalf("listed as %+v", listed["/notes/new.md"])
	}
	before := diffAt(t, srv, "/notes/new.md")
	if len(before.Hunks) == 0 || before.Blocks == nil {
		t.Fatalf("hunks %+v", before)
	}
	srv.rebuilt()
	after := diffAt(t, srv, "/notes/new.md")
	b1, _ := json.Marshal(before.Hunks)
	b2, _ := json.Marshal(after.Hunks)
	if string(b1) != string(b2) {
		t.Errorf("the hunks changed with the rebuild:\n%s\n%s", b1, b2)
	}

	os.WriteFile(filepath.Join(srv.store.Dir, "notes", "other.md"), []byte(content), 0o644) // no rebuild
	d := diffAt(t, srv, "/notes/other.md")
	last := len(d.Hunks) - 1
	if code, body := discard(t, srv, "/notes/other.md", d.Version, &last); code != http.StatusOK {
		t.Errorf("a discard before the rebuild: %d %s", code, body)
	}
}

// A block put back by a discard comes back with the gap HEAD had around it,
// not a default blank line: for a delete and for a move.
func TestADiscardKeepsHeadsGaps(t *testing.T) {
	const head = "---\ntype: note\n---\nOne.\n\n\n\nTwo.\n\nThree.\n\n\nFour.\n"
	for name, now := range map[string]string{
		"delete": "---\ntype: note\n---\nOne.\n\nThree.\n\n\nFour.\n",
		"move":   "---\ntype: note\n---\nOne.\n\nThree.\n\n\nFour.\n\nTwo.\n",
	} {
		t.Run(name, func(t *testing.T) {
			srv := newChangesServer(t)
			writeFile(t, srv, "notes/g.md", head)
			gitIn(t, srv.store.Dir, "add", ".")
			gitIn(t, srv.store.Dir, "commit", "--quiet", "--message", "g")
			writeFile(t, srv, "notes/g.md", now)
			d := diffAt(t, srv, "/notes/g.md")
			if len(d.Hunks) != 1 {
				t.Fatalf("hunks %+v", d.Hunks)
			}
			if code, body := discard(t, srv, "/notes/g.md", d.Version, intp(0)); code != http.StatusOK {
				t.Fatalf("%d %s", code, body)
			}
			if got := fileAt(t, srv, "/notes/g.md"); got != head {
				t.Errorf("got\n%q\nwant\n%q", got, head)
			}
		})
	}
}

func commit(t *testing.T, srv *Server, req map[string]any) (int, map[string]any) {
	t.Helper()
	code, body := call(t, srv, http.MethodPost, "/api/commit", req)
	var out map[string]any
	json.Unmarshal(body, &out)
	return code, out
}

func shownFiles(listed map[string]changeView, paths ...string) []map[string]string {
	var files []map[string]string
	for _, p := range paths {
		files = append(files, map[string]string{"path": p, "version": listed[p].Version})
	}
	return files
}

// A commit refuses the file that changed after it was shown, and commits the
// rest; the user's other staged work stays staged.
func TestACommitRefusesAChangedFileAndCommitsTheRest(t *testing.T) {
	srv := newChangesServer(t)
	dir := srv.store.Dir
	shownA := strings.Replace(pageA, "First", "Shown", 1)
	writeFile(t, srv, "notes/a.md", shownA)
	writeFile(t, srv, "wiki.toml", "spec = \"0.1\"\ntitle = \"shown\"\n")
	listed, _ := listChanges(t, srv)
	writeFile(t, srv, "wiki.toml", "spec = \"0.1\"\ntitle = \"later\"\n")
	writeFile(t, srv, "index.md", "---\nokf_version: \"0.1\"\n---\nstaged by the user\n")
	gitIn(t, dir, "add", "index.md")

	code, out := commit(t, srv, map[string]any{"message": "Shown", "files": shownFiles(listed, "/notes/a.md", "/wiki.toml")})
	if code != http.StatusOK {
		t.Fatalf("%d %v", code, out)
	}
	if c, _ := json.Marshal(out["committed"]); string(c) != `["/notes/a.md"]` {
		t.Errorf("committed %s", c)
	}
	if r, _ := json.Marshal(out["refused"]); string(r) != `[{"path":"/wiki.toml","reason":"changed after you read it"}]` {
		t.Errorf("refused %s", r)
	}
	if sha, _ := out["commit"].(string); sha != gitIn(t, dir, "rev-parse", "HEAD") {
		t.Errorf("commit %v", out["commit"])
	}
	if out["status"] == nil || out["pushed"] != false {
		t.Errorf("%v", out)
	}
	if got := gitIn(t, dir, "show", "HEAD:notes/a.md"); got+"\n" != shownA {
		t.Errorf("committed %q", got)
	}
	if staged := gitIn(t, dir, "diff", "--cached", "--name-only"); staged != "index.md" {
		t.Errorf("staged %q", staged)
	}

	for name, req := range map[string]map[string]any{
		"no message": {"message": "  ", "files": shownFiles(listed, "/notes/a.md")},
		"a NUL":      {"message": "a\x00b", "files": shownFiles(listed, "/notes/a.md")},
		"too long":   {"message": strings.Repeat("x", maxMessage+1), "files": shownFiles(listed, "/notes/a.md")},
		"no files":   {"message": "m", "files": []any{}},
		"a dot path": {"message": "m", "files": []map[string]string{{"path": "/.env", "version": ""}}},
		"a bad path": {"message": "m", "files": []map[string]string{{"path": "/../x", "version": ""}}},
	} {
		if code, out := commit(t, srv, req); code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %v", name, code, out)
		}
	}
}

// The commit holds the bytes that were shown: a pre-commit hook's rewrite
// stays in the worktree, uncommitted.
func TestACommitTakesTheBytesShown(t *testing.T) {
	srv := newChangesServer(t)
	dir := srv.store.Dir
	shown := strings.Replace(pageA, "First", "Shown", 1)
	writeFile(t, srv, "notes/a.md", shown)
	listed, _ := listChanges(t, srv)
	hookIn(t, dir, "pre-commit", `echo "rewritten by a hook" > notes/a.md`)

	if code, out := commit(t, srv, map[string]any{"message": "Shown", "files": shownFiles(listed, "/notes/a.md")}); code != http.StatusOK {
		t.Fatalf("%d %v", code, out)
	}
	if got := gitIn(t, dir, "show", "HEAD:notes/a.md"); got+"\n" != shown {
		t.Errorf("committed %q", got)
	}
	if got := fileAt(t, srv, "/notes/a.md"); got != "rewritten by a hook\n" {
		t.Errorf("worktree %q", got)
	}
}

// HEAD moving during a commit is a 409 with nothing committed; a failing hook
// is a 500 with its output.
func TestACommitThatCantLandCommitsNothing(t *testing.T) {
	srv := newChangesServer(t)
	dir := srv.store.Dir
	writeFile(t, srv, "notes/a.md", strings.Replace(pageA, "First", "Shown", 1))
	listed, _ := listChanges(t, srv)
	head := gitIn(t, dir, "rev-parse", "HEAD")

	hookIn(t, dir, "pre-commit", `echo "lint: no" >&2; exit 1`)
	if code, out := commit(t, srv, map[string]any{"message": "m", "files": shownFiles(listed, "/notes/a.md")}); code != http.StatusInternalServerError || !strings.Contains(out["error"].(string), "lint: no") {
		t.Errorf("a failing hook: %d %v", code, out)
	}
	hookIn(t, dir, "pre-commit", `env -u GIT_INDEX_FILE GIT_CONFIG_GLOBAL=/dev/null git commit --quiet --no-verify --allow-empty -m elsewhere`)
	if code, out := commit(t, srv, map[string]any{"message": "m", "files": shownFiles(listed, "/notes/a.md")}); code != http.StatusConflict {
		t.Errorf("HEAD moved: %d %v", code, out)
	}
	if log := gitIn(t, dir, "log", "--format=%s", head+"..HEAD"); log != "elsewhere" {
		t.Errorf("commits since: %q", log)
	}
}

// A symlink is committed as one, its target text as its blob, without its
// target being read (here it doesn't even exist).
func TestASymlinkIsCommittedAsALink(t *testing.T) {
	srv := newChangesServer(t)
	dir := srv.store.Dir
	if err := os.Symlink("../nowhere/secret.md", filepath.Join(dir, "link.md")); err != nil {
		t.Fatal(err)
	}
	listed, _ := listChanges(t, srv)
	d := diffAt(t, srv, "/link.md")
	if d.Raw == nil || !strings.Contains(*d.Raw, "+../nowhere/secret.md") || len(d.Hunks) != 0 {
		t.Errorf("the link's diff: %+v", d)
	}
	if code, out := commit(t, srv, map[string]any{"message": "Link", "files": shownFiles(listed, "/link.md")}); code != http.StatusOK {
		t.Fatalf("%d %v", code, out)
	}
	if tree := gitIn(t, dir, "ls-tree", "HEAD", "link.md"); !strings.HasPrefix(tree, "120000 blob") {
		t.Errorf("tree %s", tree)
	}
}

// modeOfListed is a listed file's mode change, as "from>to".
func modeOfListed(c changeView) string {
	if c.Mode == nil {
		return ""
	}
	return c.Mode.From + ">" + c.Mode.To
}

// With core.fileMode on, the mode follows the worktree's execute bit, as
// `git add` would: a chmod alone is listed, commits, and leaves the list,
// and a new +x file commits as 100755.
func TestTheModeFollowsTheExecuteBit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no execute bit")
	}
	srv := newChangesServer(t)
	dir := srv.store.Dir
	os.Chmod(filepath.Join(dir, "notes", "a.md"), 0o755)
	writeFile(t, srv, "run.sh", "echo 1\n")
	os.Chmod(filepath.Join(dir, "run.sh"), 0o755)
	writeFile(t, srv, "plain.txt", "x\n")

	listed, _ := listChanges(t, srv)
	if c := listed["/notes/a.md"]; modeOfListed(c) != "100644>100755" || c.Change != "modified" || *c.Added != 0 || *c.Removed != 0 {
		t.Errorf("the chmod: %+v %s", c, modeOfListed(c))
	}
	if m := modeOfListed(listed["/run.sh"]); m != ">100755" {
		t.Errorf("the new +x file: %q", m)
	}
	if m := modeOfListed(listed["/plain.txt"]); m != "" {
		t.Errorf("a new plain file: %q", m)
	}
	if code, out := commit(t, srv, map[string]any{"message": "Modes", "files": shownFiles(listed, "/notes/a.md", "/run.sh", "/plain.txt")}); code != http.StatusOK {
		t.Fatalf("%d %v", code, out)
	}
	for path, want := range map[string]string{"notes/a.md": "100755", "run.sh": "100755", "plain.txt": "100644"} {
		if tree := gitIn(t, dir, "ls-tree", "HEAD", path); !strings.HasPrefix(tree, want) {
			t.Errorf("%s: %s", path, tree)
		}
	}
	if listed, _ := listChanges(t, srv); len(listed) != 0 {
		t.Errorf("left: %+v", listed)
	}
}

// With core.fileMode off, a file keeps HEAD's mode, whatever its bit says.
func TestWithFileModeOffHeadsModeIsKept(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no execute bit")
	}
	srv := newChangesServer(t)
	dir := srv.store.Dir
	writeFile(t, srv, "run.sh", "echo 1\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "update-index", "--chmod=+x", "run.sh")
	gitIn(t, dir, "commit", "--quiet", "--message", "run")
	gitIn(t, dir, "config", "core.fileMode", "false")

	writeFile(t, srv, "run.sh", "echo 2\n") // 0644 on disk, 100755 in HEAD
	writeFile(t, srv, "notes/a.md", pageA+"\nMore.\n")
	os.Chmod(filepath.Join(dir, "notes", "a.md"), 0o755)
	listed, _ := listChanges(t, srv)
	if m := modeOfListed(listed["/run.sh"]) + modeOfListed(listed["/notes/a.md"]); m != "" {
		t.Errorf("modes listed: %q", m)
	}
	if code, out := commit(t, srv, map[string]any{"message": "Off", "files": shownFiles(listed, "/run.sh", "/notes/a.md")}); code != http.StatusOK {
		t.Fatalf("%d %v", code, out)
	}
	for path, want := range map[string]string{"run.sh": "100755", "notes/a.md": "100644"} {
		if tree := gitIn(t, dir, "ls-tree", "HEAD", path); !strings.HasPrefix(tree, want) {
			t.Errorf("%s: %s", path, tree)
		}
	}
}

// A file that becomes a symlink, or a symlink that becomes a file, lists
// the change of mode: Dessy's "Now a link" and "No longer a link".
func TestAFileBecomingALinkListsTheMode(t *testing.T) {
	srv := newChangesServer(t)
	dir := srv.store.Dir
	if err := os.Symlink("notes/a.md", filepath.Join(dir, "was-link.md")); err != nil {
		t.Fatal(err)
	}
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "--quiet", "--message", "link")

	os.Remove(filepath.Join(dir, "notes", "a.md"))
	os.Symlink("../index.md", filepath.Join(dir, "notes", "a.md"))
	os.Remove(filepath.Join(dir, "was-link.md"))
	writeFile(t, srv, "was-link.md", "now a file\n")
	listed, _ := listChanges(t, srv)
	if c := listed["/notes/a.md"]; modeOfListed(c) != "100644>120000" || c.Kind != "link" {
		t.Errorf("now a link: %+v %s", c, modeOfListed(c))
	}
	if c := listed["/was-link.md"]; modeOfListed(c) != "120000>100644" || c.Kind != "page" {
		t.Errorf("no longer a link: %+v %s", c, modeOfListed(c))
	}
}

// Listing a large file streams it through the hash and never holds it: one
// GET /api/changes of a 64 MiB dataset must not cost its size in memory.
// (Audy, changes-api M-1: a 300 MB file took the server to 5 GB.)
func TestListingALargeFileDoesNotHoldIt(t *testing.T) {
	srv := newChangesServer(t)
	const size = 64 << 20
	if err := os.WriteFile(filepath.Join(srv.store.Dir, "dataset.csv"), []byte(strings.Repeat("a", size)), 0o644); err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	listed, _ := listChanges(t, srv)
	runtime.ReadMemStats(&after)
	if listed["/dataset.csv"].Size != size {
		t.Fatalf("dataset.csv not listed as large: %+v", listed["/dataset.csv"])
	}
	if got := after.TotalAlloc - before.TotalAlloc; got > size/4 {
		t.Errorf("one GET /api/changes allocated %d MiB for a %d MiB file", got>>20, size>>20)
	}
}

// Committing a large file streams it: the server never holds it whole, and
// the commit has every byte.
func TestCommittingALargeFileStreamsIt(t *testing.T) {
	srv := newChangesServer(t)
	const size = 64 << 20
	if err := os.WriteFile(filepath.Join(srv.store.Dir, "dataset.csv"), []byte(strings.Repeat("a", size)), 0o644); err != nil {
		t.Fatal(err)
	}
	listed, _ := listChanges(t, srv)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	code, out := commit(t, srv, map[string]any{"message": "Data", "files": shownFiles(listed, "/dataset.csv")})
	runtime.ReadMemStats(&after)
	if code != http.StatusOK {
		t.Fatalf("%d %v", code, out)
	}
	if got := after.TotalAlloc - before.TotalAlloc; got > size/4 {
		t.Errorf("the commit allocated %d MiB for a %d MiB file", got>>20, size>>20)
	}
	if n := gitIn(t, srv.store.Dir, "cat-file", "-s", "HEAD:dataset.csv"); n != strconv.Itoa(size) {
		t.Errorf("committed %s bytes", n)
	}
}

// A file is opened without following a symlink at its last name, so one
// swapped in after the check is refused rather than read.
func TestOpenRegularRefusesASymlink(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "target"), []byte("outside\n"), 0o644)
	os.Symlink("target", filepath.Join(dir, "link"))
	if f, _, err := openRegular(filepath.Join(dir, "link")); err == nil {
		f.Close()
		t.Error("opened a symlink")
	}
	f, fi, err := openRegular(filepath.Join(dir, "target"))
	if err != nil || fi.Size() != 8 {
		t.Fatalf("%v %v", fi, err)
	}
	f.Close()
}

// A filtered file has no diff and no hunks: only Discard file.
func TestAFilteredFileHasNoDiff(t *testing.T) {
	srv := newChangesServer(t)
	gitIn(t, srv.store.Dir, "config", "filter.probe.clean", "cat")
	writeFile(t, srv, ".gitattributes", "*.dat filter=probe\n")
	writeFile(t, srv, "a.dat", "data\n")
	listed, _ := listChanges(t, srv)
	if c := listed["/a.dat"]; c.Kind != "text" || c.Added != nil || c.Version == "" {
		t.Errorf("listed %+v", c)
	}
	if d := diffAt(t, srv, "/a.dat"); d.Raw != nil || len(d.Hunks) != 0 {
		t.Errorf("diff %+v", d)
	}
}

// gitCalls puts a git on PATH that counts its runs, and returns the count so
// far.
func gitCalls(t *testing.T) func() int {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	shim := "#!/bin/sh\necho x >> '" + log + "'\nexec '" + real + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return func() int {
		b, _ := os.ReadFile(log)
		return strings.Count(string(b), "x")
	}
}

// Listing many changed pages costs the same git runs as listing one: HEAD's
// blobs come from one cat-file, and a page's counts are kept by version.
func TestListingManyPagesRunsGitAFixedNumberOfTimes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the counting git is a shell script")
	}
	srv := newChangesServer(t)
	dir := srv.store.Dir
	for i := range 40 {
		writeFile(t, srv, fmt.Sprintf("notes/p%d.md", i), "---\ntype: note\n---\nOne.\n\nTwo.\n")
	}
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "--quiet", "--message", "pages")
	calls := gitCalls(t)

	writeFile(t, srv, "notes/p0.md", "---\ntype: note\n---\nOne, changed.\n\nTwo.\n")
	n0 := calls()
	listChanges(t, srv)
	one := calls() - n0

	for i := range 40 {
		writeFile(t, srv, fmt.Sprintf("notes/p%d.md", i), "---\ntype: note\n---\nOne, changed.\n\nTwo.\n")
	}
	n0 = calls()
	listed, _ := listChanges(t, srv)
	many := calls() - n0
	t.Logf("git runs: %d for one page, %d for 40", one, many)
	if many > one {
		t.Errorf("40 pages ran git %d times, one page %d", many, one)
	}
	if c := listed["/notes/p7.md"]; *c.Added != 1 || *c.Removed != 1 {
		t.Errorf("counts %+v", c)
	}
}

// A page's counts follow HEAD: after a commit of the page, the same bytes
// are no longer a change, and a new change is counted against the new HEAD.
func TestPageCountsFollowHead(t *testing.T) {
	srv := newChangesServer(t)
	changed := strings.Replace(pageA, "First paragraph.", "First, changed.", 1)
	writeFile(t, srv, "notes/a.md", changed)
	listChanges(t, srv)
	gitIn(t, srv.store.Dir, "commit", "--quiet", "--all", "--message", "a")
	writeFile(t, srv, "notes/a.md", changed+"\nMore.\n")
	listed, _ := listChanges(t, srv)
	if c := listed["/notes/a.md"]; *c.Added != 1 || *c.Removed != 0 {
		t.Errorf("counts %+v", c)
	}
}

// With push, the commit goes to the remote; a failed push leaves the commit
// and says why.
func TestACommitCanPush(t *testing.T) {
	srv, remote := newGitServer(t)
	dir := srv.store.Dir
	writeFile(t, srv, "note.md", "---\ntype: note\n---\nn\n")
	listed, _ := listChanges(t, srv)
	if code, out := commit(t, srv, map[string]any{"message": "Pushed", "files": shownFiles(listed, "/note.md"), "push": true}); code != http.StatusOK || out["pushed"] != true {
		t.Fatalf("%d %v", code, out)
	}
	if log := gitIn(t, remote, "log", "--format=%s", "-1"); log != "Pushed" {
		t.Errorf("the remote has %q", log)
	}

	gitIn(t, dir, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "gone.git"))
	writeFile(t, srv, "note.md", "---\ntype: note\n---\nm\n")
	listed, _ = listChanges(t, srv)
	code, out := commit(t, srv, map[string]any{"message": "Not pushed", "files": shownFiles(listed, "/note.md"), "push": true})
	if code != http.StatusOK || out["pushed"] != false || out["pushError"] == nil || out["commit"] == "" {
		t.Errorf("%d %v", code, out)
	}
}

// The shadow stays usable after Close, for the requests that run until the
// HTTP server has shut down, and RemoveShadow deletes it after that.
func TestTheShadowGoesAfterShutdown(t *testing.T) {
	srv := newChangesServer(t)
	base := t.TempDir()
	srv.shadow = git.NewShadow(base)
	writeFile(t, srv, "notes/a.md", "changed\n")
	srv.Close()
	if listed, _ := listChanges(t, srv); len(listed) != 1 {
		t.Fatalf("after Close: %+v", listed)
	}
	if entries, _ := os.ReadDir(base); len(entries) != 2 { // the folder and its lock file
		t.Fatalf("%d entries", len(entries))
	}
	srv.RemoveShadow()
	if entries, _ := os.ReadDir(base); len(entries) != 0 {
		t.Error("the shadow outlived the server")
	}
}

// A bundle that isn't in git says so.
func TestChangesOutsideGit(t *testing.T) {
	srv := newTestServer(t)
	var got map[string]any
	if code := get(t, srv, "/api/changes", &got); code != http.StatusOK || got["repo"] != false {
		t.Errorf("%d %v", code, got)
	}
}

// hookIn installs an executable hook script.
func hookIn(t *testing.T, dir, name, script string) {
	t.Helper()
	p := filepath.Join(dir, ".git", "hooks", name)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}
