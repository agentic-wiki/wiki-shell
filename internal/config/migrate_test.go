package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/agentic-wiki/wiki/bundle"
)

// Only the old view headers change, and an old table left empty goes.
// Everything else stays byte for byte: comments, values that only mention the
// old name, other tools, another table of this name, indentation, a comment
// after a header, and Windows line endings.
func TestMigrateRenamesTheOldTables(t *testing.T) {
	old := "spec = \"0.1\"\n" +
		"# [[tool.wikiview.board]] in a comment stays as written\n" +
		"[tool.wikiview]\n" +
		"# nothing in here\n" +
		"\n" +
		"[[tool.wikiview.board]]\r\n" +
		"id   = \"backlog\"\r\n" +
		"path = \"/backlog\"\r\n" +
		"name = \"[[tool.wikiview.board]] is only a value\"\n" +
		"\n" +
		"  [[ tool.wikiview.graph ]] # the map\n" +
		"  id   = \"map\"\n" +
		"  path = \"/backlog\"\n" +
		"\n" +
		"[[tool.wikiview.boards]]\n" +
		"[tool.wikiviewer]\n" +
		"other = 1\n"
	want := "spec = \"0.1\"\n" +
		"# [[tool.wikiview.board]] in a comment stays as written\n" +
		"# nothing in here\n" +
		"\n" +
		"[[board]]\r\n" +
		"id   = \"backlog\"\r\n" +
		"path = \"/backlog\"\r\n" +
		"name = \"[[tool.wikiview.board]] is only a value\"\n" +
		"\n" +
		"  [[graph]] # the map\n" +
		"  id   = \"map\"\n" +
		"  path = \"/backlog\"\n" +
		"\n" +
		"[[tool.wikiview.boards]]\n" +
		"[tool.wikiviewer]\n" +
		"other = 1\n"
	dir := declared(t, old)

	migrated, err := Migrate(dir)
	if err != nil || !migrated {
		t.Fatalf("Migrate = %v, %v; want true, nil", migrated, err)
	}
	if got := read(t, dir); got != want {
		t.Errorf("wiki.toml after the migration:\n%q\nwant:\n%q", got, want)
	}

	// A second run finds nothing to change, and writes nothing.
	if migrated, err := Migrate(dir); migrated || err != nil {
		t.Errorf("second Migrate = %v, %v; want false, nil", migrated, err)
	}
	if got := read(t, dir); got != want {
		t.Errorf("the second run changed the file:\n%q", got)
	}
}

// Old and new tables in one file join: arrays of tables concatenate, in file
// order. A clash is the usual problem, reported, never a refusal.
func TestMigrateJoinsOldAndNewTables(t *testing.T) {
	dir := declared(t, "spec = \"0.1\"\n\n"+
		"[[board]]\nid = \"new\"\npath = \"/backlog\"\n\n"+
		"[[tool.wikiview.board]]\nid = \"old\"\npath = \"/backlog\"\n\n"+
		"[[tool.wikiview.board]]\nid = \"new\"\npath = \"/backlog\"\n")

	if _, err := Migrate(dir); err != nil {
		t.Fatal(err)
	}
	cfg, problems := loadDir(t, dir)
	if len(cfg.Board) != 3 || cfg.Board[0].ID != "new" || cfg.Board[1].ID != "old" || cfg.Board[2].ID != "new" {
		t.Errorf("boards = %+v, want new, old, new in file order", cfg.Board)
	}
	if !strings.Contains(strings.Join(problems, "\n"), `board 3: id "new" is already board 1`) {
		t.Errorf("problems = %v, want the clash reported", problems)
	}
}

// What the rewrite cannot move is reported, not read: a key in the old table
// itself keeps that table, and the problem names the key.
func TestWhatCannotMoveIsReported(t *testing.T) {
	dir := declared(t, "spec = \"0.1\"\n\n"+
		"[tool.wikiview]\ndefault_board = \"backlog\"\n\n"+
		"[[tool.wikiview.board]]\nid = \"backlog\"\npath = \"/backlog\"\n")

	if _, err := Migrate(dir); err != nil {
		t.Fatal(err)
	}
	if got := read(t, dir); !strings.Contains(got, "[tool.wikiview]\ndefault_board") || !strings.Contains(got, "\n[[board]]\n") {
		t.Errorf("wiki.toml = %q, want the table with a key kept and the board renamed", got)
	}
	cfg, _ := loadDir(t, dir)
	if len(cfg.Board) != 1 {
		t.Errorf("boards = %+v, want the renamed one", cfg.Board)
	}
	b, err := bundle.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := LeftBehind(b), "[tool.wikiview] is no longer read, and still holds: default_board"; got != want {
		t.Errorf("LeftBehind = %q, want %q", got, want)
	}
}

// A file with nothing to rename is not written at all.
func TestMigrateLeavesOtherFilesAlone(t *testing.T) {
	for name, toml := range map[string]string{
		"new tables": handWritten,
		"no tables":  "spec = \"0.1\"\n",
		"dotted key": "spec = \"0.1\"\ntool.wikiview.board = []\n",
		"empty":      "",
	} {
		t.Run(name, func(t *testing.T) {
			dir := declared(t, toml)
			if migrated, err := Migrate(dir); migrated || err != nil {
				t.Errorf("Migrate = %v, %v; want false, nil", migrated, err)
			}
			if got := read(t, dir); got != toml {
				t.Errorf("wiki.toml changed:\n%q", got)
			}
		})
	}
	if migrated, err := Migrate(t.TempDir()); migrated || err != nil {
		t.Errorf("no wiki.toml: Migrate = %v, %v; want false, nil", migrated, err)
	}
}

// A folder it cannot write to (a read-only checkout) is an error, and the file
// stays as it was.
func TestMigrateCannotWrite(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a folder this user cannot write to")
	}
	old := "spec = \"0.1\"\n\n[[tool.wikiview.board]]\nid = \"b\"\npath = \"/\"\n"
	dir := declared(t, old)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o755) })

	if _, err := Migrate(dir); err == nil {
		t.Error("no error, want one")
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "wiki.toml")); string(raw) != old {
		t.Errorf("wiki.toml changed:\n%q", raw)
	}
}

// The API's writes refuse a symlinked wiki.toml by the same rule as the
// migration, and say so, rather than replacing the link with a copy.
func TestWritesLeaveASymlinkAlone(t *testing.T) {
	for name, write := range map[string]func(dir string) error{
		"declare": func(dir string) error { return Declare(dir, Config{}, Board{ID: "new", Path: "/"}) },
		"update":  func(dir string) error { return Update(dir, "a", Settings{Name: "A"}) },
	} {
		t.Run(name, func(t *testing.T) {
			dir, outside := t.TempDir(), t.TempDir()
			target := filepath.Join(outside, "wiki.toml")
			if err := os.WriteFile(target, []byte("spec = \"0.1\"\n\n[[board]]\nid = \"a\"\npath = \"/\"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(dir, "wiki.toml")
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			if err := write(dir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
				t.Errorf("err = %v, want one saying wiki.toml is not a regular file", err)
			}
			if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
				t.Errorf("wiki.toml is no longer the symlink: %v", err)
			}
		})
	}
}

// Writes to wiki.toml run one at a time: each reads, edits and writes the whole
// file, so two at once would lose one while both report success.
func TestParallelWritesKeepEveryBoard(t *testing.T) {
	for range 20 {
		dir := declared(t, "spec = \"0.1\"\n\n[[tool.wikiview.board]]\nid = \"old\"\npath = \"/\"\n")
		var wg sync.WaitGroup
		for i := range 10 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := Declare(dir, Config{}, Board{ID: fmt.Sprintf("b%d", i), Path: "/"}); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Migrate(dir); err != nil {
				t.Error(err)
			}
		}()
		wg.Wait()

		cfg, _ := loadDir(t, dir)
		if len(cfg.Board) != 11 {
			t.Fatalf("%d boards after 10 declares and a migration, want 11:\n%s", len(cfg.Board), read(t, dir))
		}
	}
}

// Two declares of one id at once give one board: the id is checked again in
// the file under the lock, so the second is refused rather than written twice.
func TestParallelDeclaresOfOneIDGiveOneBoard(t *testing.T) {
	for range 20 {
		dir := declared(t, "spec = \"0.1\"\n")
		errs := make(chan error, 2)
		for range 2 {
			go func() { errs <- Declare(dir, Config{}, Board{ID: "same", Path: "/"}) }()
		}
		var refused int
		for range 2 {
			if err := <-errs; err != nil {
				if !strings.Contains(err.Error(), `a board with the id "same" is already declared`) {
					t.Fatalf("err = %v, want the id refused as taken", err)
				}
				refused++
			}
		}
		cfg, _ := loadDir(t, dir)
		if refused != 1 || len(cfg.Board) != 1 {
			t.Fatalf("%d refused and %d boards, want 1 and 1:\n%s", refused, len(cfg.Board), read(t, dir))
		}
	}
}
