package git

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// objectsIn lists every object file under an object directory.
func objectsIn(t *testing.T, dir string) []string {
	t.Helper()
	var list []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			list = append(list, p)
		}
		return nil
	})
	return list
}

func changesOf(t *testing.T, dir string, sh *Shadow) map[string]FileChange {
	t.Helper()
	repo, files, err := Changes(context.Background(), dir, sh)
	if err != nil || !repo {
		t.Fatalf("Changes: repo=%v err=%v", repo, err)
	}
	m := map[string]FileChange{}
	for _, f := range files {
		m[f.Path] = f
	}
	return m
}

// An untracked file and a rename show up, and neither the user's index nor
// their object store gains anything: `git status` reads as before.
func TestChangesShowUntrackedAndRenamesWithoutWritingTheRepo(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "notes/old.md", "---\ntype: note\n---\n"+strings.Repeat("a line that stays\n", 20))
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "second")
	must(t, clone, "mv", "notes/old.md", "notes/new.md")
	must(t, clone, "reset", "--quiet") // unstaged: a rename git status can't see
	write(t, clone, "notes/fresh.md", "fresh\n")
	write(t, clone, "index.md", "---\nokf_version: \"0.1\"\n---\nhome, changed\n")

	statusBefore := must(t, clone, "status", "--porcelain")
	objectsBefore := objectsIn(t, filepath.Join(clone, ".git", "objects"))
	indexBefore, _ := os.ReadFile(filepath.Join(clone, ".git", "index"))

	got := changesOf(t, clone, NewShadow(t.TempDir()))
	if c := got["notes/new.md"]; c.Change != "renamed" || c.From != "notes/old.md" {
		t.Errorf("the rename: %+v", c)
	}
	if c := got["notes/fresh.md"]; c.Change != "new" || c.Added != 1 {
		t.Errorf("the untracked file: %+v", c)
	}
	if c := got["index.md"]; c.Change != "modified" || c.Added != 1 || c.Removed != 1 {
		t.Errorf("the modified file: %+v", c)
	}
	if len(got) != 3 {
		t.Errorf("got %+v", got)
	}

	if after := objectsIn(t, filepath.Join(clone, ".git", "objects")); len(after) != len(objectsBefore) {
		t.Errorf("the repo's objects went from %d to %d", len(objectsBefore), len(after))
	}
	if after, _ := os.ReadFile(filepath.Join(clone, ".git", "index")); string(after) != string(indexBefore) {
		t.Error("the user's index was written")
	}
	if after := must(t, clone, "status", "--porcelain"); after != statusBefore {
		t.Errorf("git status changed:\n%s\nwas\n%s", after, statusBefore)
	}
}

// A dot path is listed by name and never hashed: its content reaches neither
// the shadow objects nor the repo's.
func TestADotPathIsNeverHashed(t *testing.T) {
	clone, _ := repoPair(t)
	secret := "TOKEN=a-secret-nobody-else-has-1234\n"
	write(t, clone, ".env", secret)
	write(t, clone, "notes/.draft/x.md", "draft\n")
	shadowBase := t.TempDir()

	got := changesOf(t, clone, NewShadow(shadowBase))
	for _, p := range []string{".env", "notes/.draft/x.md"} {
		if c := got[p]; !c.Dot || c.Change != "new" || c.Added != 0 {
			t.Errorf("%s: %+v", p, got[p])
		}
	}
	blob := must(t, clone, "hash-object", ".env") // computed, not written
	name := blob[:2] + string(filepath.Separator) + blob[2:]
	for _, dir := range []string{shadowBase, filepath.Join(clone, ".git", "objects")} {
		for _, p := range objectsIn(t, dir) {
			if strings.HasSuffix(p, name) {
				t.Errorf("the dot file was hashed into %s", dir)
			}
		}
	}
}

// A file over MaxDiffSize is listed as Large, and not hashed into the shadow.
func TestALargeFileIsNotHashed(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "big.csv", strings.Repeat("x", MaxDiffSize+1))
	shadowBase := t.TempDir()
	got := changesOf(t, clone, NewShadow(shadowBase))
	if c := got["big.csv"]; !c.Large || c.Change != "new" {
		t.Errorf("%+v", c)
	}
	if n := len(objectsIn(t, shadowBase)); n > 2 { // the index, at most one tree
		t.Errorf("%d files in the shadow", n)
	}
}

// A file with a filter attribute (git-lfs) is listed without being added to
// the shadow, so its clean filter never runs on a listing: git-lfs's writes
// into the repository's own .git/lfs.
func TestAFilteredFileIsNotCleaned(t *testing.T) {
	clone, _ := repoPair(t)
	ran := filepath.Join(t.TempDir(), "ran")
	must(t, clone, "config", "filter.probe.clean", "echo x >> '"+ran+"'; cat")
	write(t, clone, ".gitattributes", "*.dat filter=probe\n")
	write(t, clone, "a.dat", "data\n")
	sh := NewShadow(t.TempDir())
	for range 2 {
		got := changesOf(t, clone, sh)
		if c := got["a.dat"]; !c.Filtered || c.Change != "new" {
			t.Errorf("%+v", c)
		}
	}
	if b, err := os.ReadFile(ran); err == nil {
		t.Errorf("the clean filter ran: %q", b)
	}
}

// Blobs reads many objects in one run: their bytes exactly, and nothing for
// an id the repository lacks.
func TestBlobs(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "a.txt", "no newline")
	write(t, clone, "b.txt", "two\nlines\n")
	must(t, clone, "add", ".")
	a, b := must(t, clone, "rev-parse", ":a.txt"), must(t, clone, "rev-parse", ":b.txt")
	missing := strings.Repeat("1", len(a))
	got, err := Blobs(context.Background(), clone, []string{a, b, missing})
	if err != nil {
		t.Fatal(err)
	}
	if got[a] != "no newline" || got[b] != "two\nlines\n" || len(got) != 2 {
		t.Errorf("%q", got)
	}
}

// A same-size edit made in the same second as the last index write is still
// a change (Fronty's repro): git's racily-clean check compares a file's mtime
// with the index file's, so the shadow index keeps the real index's mtime.
// Built exactly, rather than by timing: minimal stat checks, and the page, its
// index entry and the index file all at one past time.
func TestARacilyCleanEditIsAChange(t *testing.T) {
	clone, _ := repoPair(t)
	must(t, clone, "config", "core.checkStat", "minimal")
	must(t, clone, "config", "core.trustctime", "false")
	past := time.Now().Add(-time.Hour).Truncate(time.Second)
	page := filepath.Join(clone, "b.md")
	write(t, clone, "b.md", "---\ntype: note\nstatus: todo\n---\n")
	os.Chtimes(page, past, past)
	must(t, clone, "add", "b.md")
	must(t, clone, "commit", "--quiet", "--message", "b")
	write(t, clone, "b.md", "---\nstatus: todo\ntype: note\n---\n") // same size
	os.Chtimes(page, past, past)
	os.Chtimes(filepath.Join(clone, ".git", "index"), past, past)
	if c, ok := changesOf(t, clone, NewShadow(t.TempDir()))["b.md"]; !ok || c.Change != "modified" {
		t.Errorf("the edit isn't listed: %+v", c)
	}
	if status := must(t, clone, "status", "--porcelain", "b.md"); !strings.Contains(status, "M b.md") {
		t.Errorf("git itself doesn't see the edit: %q", status)
	}
}

// The shadow lives in its own 0700 folder, made on first use, and is gone
// after Remove; any later use fails.
func TestTheShadowIsPrivateAndRemoved(t *testing.T) {
	clone, _ := repoPair(t)
	base := t.TempDir()
	sh := NewShadow(base)
	if entries, _ := os.ReadDir(base); len(entries) != 0 {
		t.Fatal("made before use")
	}
	changesOf(t, clone, sh)
	entries, _ := os.ReadDir(base)
	if len(entries) != 2 { // the folder and its lock file
		t.Fatalf("%d entries", len(entries))
	}
	fi, _ := os.Stat(strings.TrimSuffix(filepath.Join(base, entries[0].Name()), ".lock"))
	if !fi.IsDir() || fi.Mode().Perm() != 0o700 {
		t.Errorf("mode %v", fi.Mode())
	}
	if err := sh.Remove(); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(base); len(entries) != 0 {
		t.Error("still there after Remove")
	}
	if _, _, err := Changes(context.Background(), clone, sh); !errors.Is(err, ErrShadowRemoved) {
		t.Errorf("used after Remove: %v", err)
	}
}

// A shadow left by a server that was killed (SIGKILL) is removed when the
// next shadow starts, and a live server's is kept.
func TestStaleShadowsAreRemoved(t *testing.T) {
	base := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestShadowHelperProcess$")
	cmd.Env = append(os.Environ(), "SHADOW_HELPER_BASE="+base)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatalf("helper: %v", err)
	}
	killed := strings.TrimSpace(line)

	// A folder whose lock file is gone (its server died while removing it),
	// and a file that isn't a shadow.
	orphan := filepath.Join(base, "shadow-123")
	if err := os.MkdirAll(filepath.Join(orphan, "objects"), 0o700); err != nil {
		t.Fatal(err)
	}
	write(t, base, "notes.txt", "mine")

	NewShadow(base)
	if _, err := os.Stat(killed); err != nil {
		t.Fatalf("a live server's shadow was removed: %v", err)
	}
	if _, err := os.Stat(orphan); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("orphan folder kept: %v", err)
	}

	cmd.Process.Kill()
	cmd.Wait()
	NewShadow(base)
	entries, _ := os.ReadDir(base)
	if len(entries) != 1 || entries[0].Name() != "notes.txt" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("left after the sweep: %v", names)
	}
}

// TestShadowHelperProcess is the server TestStaleShadowsAreRemoved kills: it
// makes a shadow, prints its folder and waits.
func TestShadowHelperProcess(t *testing.T) {
	base := os.Getenv("SHADOW_HELPER_BASE")
	if base == "" {
		t.Skip("run by TestStaleShadowsAreRemoved")
	}
	sh := NewShadow(base)
	sh.mu.Lock()
	root, err := sh.dir()
	sh.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index"), []byte("copy"), 0o600); err != nil {
		t.Fatal(err)
	}
	fmt.Println(root)
	time.Sleep(time.Minute)
}

// With no cache folder, the shadow refuses with the reason instead of
// falling back to a shared folder such as /tmp, which another user could own.
func TestNoCacheFolderRefuses(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "plan9" {
		t.Skip("the cache folder comes from HOME and XDG_CACHE_HOME here")
	}
	clone, _ := repoPair(t)
	t.Setenv("HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	sh := NewShadow("")
	if _, _, err := Changes(context.Background(), clone, sh); err == nil || !strings.Contains(err.Error(), "cache folder") {
		t.Errorf("err = %v", err)
	}
}

// Undoing one hunk of a renamed file changes those lines only, and never
// renames the file back.
func TestReverseHunkOfARename(t *testing.T) {
	clone, _ := repoPair(t)
	var lines []string
	for i := 1; i <= 30; i++ {
		lines = append(lines, strings.Repeat("l", i))
	}
	write(t, clone, "old name.txt", strings.Join(lines, "\n")+"\n")
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "second")
	must(t, clone, "mv", "old name.txt", "new name.txt")
	must(t, clone, "reset", "--quiet")
	changed := append([]string{}, lines...)
	changed[2], changed[24] = "three", "twenty-five"
	write(t, clone, "new name.txt", strings.Join(changed, "\n")+"\n")

	sh := NewShadow(t.TempDir())
	raw, err := FileDiff(context.Background(), clone, sh, File{Path: "new name.txt", From: "old name.txt", Content: strings.Join(changed, "\n") + "\n", Mode: "100644"})
	if err != nil {
		t.Fatal(err)
	}
	if _, hunks := Hunks(raw); len(hunks) != 2 {
		t.Fatalf("hunks of:\n%s", raw)
	}
	if err := ReverseHunk(context.Background(), clone, raw, 1); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(clone, "new name.txt"))
	if !strings.Contains(string(b), "three\n") || strings.Contains(string(b), "twenty-five") {
		t.Errorf("after undoing hunk 1:\n%s", b)
	}
	if _, err := os.Stat(filepath.Join(clone, "old name.txt")); err == nil {
		t.Error("the file was renamed back")
	}
}

// The diff and its undo don't follow the user's git config: no color, git's
// a/ and b/ prefixes, and whitespace that apply would warn about.
func TestDiffIgnoresTheUsersConfig(t *testing.T) {
	clone, _ := repoPair(t)
	for _, kv := range [][2]string{{"diff.noprefix", "true"}, {"diff.mnemonicPrefix", "true"}, {"color.diff", "always"}, {"color.ui", "always"}, {"apply.whitespace", "error"}} {
		must(t, clone, "config", kv[0], kv[1])
	}
	write(t, clone, "a.txt", "one\ntwo\nthree\n")
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "a")
	now := "one\ntwo, with a trailing space \nthree\n"
	write(t, clone, "a.txt", now)

	raw, err := FileDiff(context.Background(), clone, NewShadow(t.TempDir()), File{Path: "a.txt", Content: now, Mode: "100644"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "\x1b[") || !strings.Contains(raw, "+++ b/a.txt") {
		t.Fatalf("diff:\n%q", raw)
	}
	if err := ReverseHunk(context.Background(), clone, raw, 0); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(clone, "a.txt")); string(b) != "one\ntwo\nthree\n" {
		t.Errorf("after the undo: %q", b)
	}
}

// FileDiff diffs the bytes it is given, the ones whose version was checked,
// never the file as it is by then.
func TestFileDiffDiffsTheCheckedBytes(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "a.txt", "one\ntwo\n")
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "a")
	write(t, clone, "a.txt", "written later\n")

	raw, err := FileDiff(context.Background(), clone, NewShadow(t.TempDir()), File{Path: "a.txt", Content: "one\ntwo, checked\n", Mode: "100644"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "+two, checked") || strings.Contains(raw, "written later") {
		t.Errorf("diff:\n%s", raw)
	}
}

// Restore brings files back from HEAD in the worktree, leaving the index.
func TestRestoreLeavesTheIndex(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "index.md", "changed\n")
	must(t, clone, "add", "index.md")
	write(t, clone, "index.md", "changed again\n")
	if err := Restore(context.Background(), clone, "index.md"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(clone, "index.md"))
	if string(b) != "---\nokf_version: \"0.1\"\n---\nhome\n" {
		t.Errorf("restored to %q", b)
	}
	if staged := must(t, clone, "diff", "--cached", "--name-only"); staged != "index.md" {
		t.Errorf("staged: %q", staged)
	}
}
