package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPullTakesTheRemotesWork(t *testing.T) {
	clone, remote := repoPair(t)
	// Somebody else pushes, via a second checkout.
	other := filepath.Join(t.TempDir(), "other")
	must(t, filepath.Dir(other), "clone", "--quiet", remote, other)
	configure(t, other, "o")
	write(t, other, "theirs.md", "---\ntype: note\n---\ntheirs\n")
	must(t, other, "add", ".")
	must(t, other, "commit", "--quiet", "--message", "theirs")
	must(t, other, "push", "--quiet")

	if _, err := Fetch(context.Background(), clone); err != nil {
		t.Fatal(err)
	}
	if s := Repo(clone); s.Behind != 1 {
		t.Fatalf("behind = %d after fetching, want 1", s.Behind)
	}
	if _, err := Pull(context.Background(), clone); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(clone, "theirs.md")); err != nil {
		t.Errorf("the pulled file is not there: %v", err)
	}
	if s := Repo(clone); s.Behind != 0 {
		t.Errorf("behind = %d after pulling", s.Behind)
	}
}

// The rule the whole task turns on. A rebase that stops halfway is a conflicted
// worktree, and a web page has no business asking anybody to resolve one.
func TestAFailedPullLeavesNothingBehind(t *testing.T) {
	clone, remote := repoPair(t)

	other := filepath.Join(t.TempDir(), "other")
	must(t, filepath.Dir(other), "clone", "--quiet", remote, other)
	configure(t, other, "o")
	write(t, other, "clash.md", "---\ntype: note\n---\ntheirs\n")
	must(t, other, "add", ".")
	must(t, other, "commit", "--quiet", "--message", "theirs")
	must(t, other, "push", "--quiet")

	// The same file, differently, here.
	write(t, clone, "clash.md", "---\ntype: note\n---\nmine\n")
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "mine")
	before := must(t, clone, "rev-parse", "HEAD")

	if _, err := Fetch(context.Background(), clone); err != nil {
		t.Fatal(err)
	}
	_, err := Pull(context.Background(), clone)
	if err == nil {
		t.Fatal("the conflicting pull reported success")
	}
	if !strings.Contains(err.Error(), "undone") {
		t.Errorf("error does not say the pull was undone: %v", err)
	}

	// The tree is exactly as it was: same commit, no rebase in progress, and the
	// local work still here.
	if now := must(t, clone, "rev-parse", "HEAD"); now != before {
		t.Errorf("HEAD moved from %s to %s", before, now)
	}
	if _, err := os.Stat(filepath.Join(clone, ".git", "rebase-merge")); !os.IsNotExist(err) {
		t.Error("a rebase is still in progress")
	}
	if out := must(t, clone, "status", "--porcelain"); out != "" {
		t.Errorf("the worktree is dirty after the abort:\n%s", out)
	}
	if body, _ := os.ReadFile(filepath.Join(clone, "clash.md")); !strings.Contains(string(body), "mine") {
		t.Errorf("the local version was lost: %s", body)
	}
}

// And the way out of that failure: the local work goes somewhere safe, to be
// resolved with a real tool on a real checkout.
func TestBranchPushesTheLocalWorkSomewhereSafe(t *testing.T) {
	clone, remote := repoPair(t)
	write(t, clone, "mine.md", "---\ntype: note\n---\nmine\n")
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "mine")

	name := ProposedBranch(time.Date(2026, 8, 12, 14, 30, 0, 0, time.UTC))
	if name != "wikishell/2026-08-12-1430" {
		t.Fatalf("proposed %q", name)
	}
	if _, err := Branch(context.Background(), clone, name); err != nil {
		t.Fatal(err)
	}
	if out := must(t, remote, "branch", "--list", name); !strings.Contains(out, name) {
		t.Errorf("the remote has no such branch: %q", out)
	}
	// And it left you where you were rather than moving you onto it.
	if b := Repo(clone).Branch; b != "main" {
		t.Errorf("branch = %q, want to be left on main", b)
	}
}

func TestBranchRefusesANameThatIsNotOne(t *testing.T) {
	clone, _ := repoPair(t)
	for _, name := range []string{"", "-x", "--force", "a b", "a;rm -rf /", "a..b", "x.lock", strings.Repeat("x", 200)} {
		if _, err := Branch(context.Background(), clone, name); err == nil {
			t.Errorf("accepted %q", name)
		}
	}
}
