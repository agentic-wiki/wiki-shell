package git

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hook installs an executable hook script in the repository.
func hook(t *testing.T, dir, name, script string) {
	t.Helper()
	p := filepath.Join(dir, ".git", "hooks", name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func commitFiles(t *testing.T, dir, message string, files ...File) (string, error) {
	t.Helper()
	return CommitFiles(context.Background(), dir, NewShadow(t.TempDir()), message, files)
}

// The commit holds the bytes given, not what the file holds at commit time,
// and the user's other staged paths stay staged.
func TestCommitFilesCommitsTheCheckedBytes(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "notes/a.md", "what an agent wrote after the check\n")
	write(t, clone, "other.txt", "staged by the user\n")
	must(t, clone, "add", "other.txt")

	sha, err := commitFiles(t, clone, "Add a\n\nThe body.", File{Path: "notes/a.md", Content: "the checked bytes\n"})
	if err != nil {
		t.Fatal(err)
	}
	if head := must(t, clone, "rev-parse", "HEAD"); head != sha {
		t.Errorf("HEAD %s, commit %s", head, sha)
	}
	if got := must(t, clone, "show", "HEAD:notes/a.md"); got != "the checked bytes" {
		t.Errorf("committed %q", got)
	}
	if msg := must(t, clone, "log", "-1", "--format=%B"); msg != "Add a\n\nThe body." {
		t.Errorf("message %q", msg)
	}
	if files := must(t, clone, "show", "--name-only", "--format=", "HEAD"); files != "notes/a.md" {
		t.Errorf("committed files %q", files)
	}
	if staged := must(t, clone, "diff", "--cached", "--name-only"); staged != "other.txt" {
		t.Errorf("staged now: %q", staged)
	}
	if reflog := must(t, clone, "reflog", "-1", "--format=%gs"); reflog != "commit: Add a" {
		t.Errorf("reflog %q", reflog)
	}
	// The worktree keeps the later write, now an uncommitted change.
	if st := must(t, clone, "status", "--porcelain", "--", "notes/a.md"); st != "M notes/a.md" {
		t.Errorf("status %q", st)
	}
}

// Deletes and renames, and an executable file stays executable.
func TestCommitFilesDeletesRenamesAndTakesModes(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "run.sh", "echo 1\n")
	write(t, clone, "gone.md", "gone\n")
	write(t, clone, "old.md", "old\n")
	must(t, clone, "add", ".")
	must(t, clone, "update-index", "--chmod=+x", "run.sh")
	must(t, clone, "commit", "--quiet", "--message", "second")

	_, err := commitFiles(t, clone, "Change",
		File{Path: "run.sh", Content: "echo 2\n", Mode: "100755"},
		File{Path: "gone.md", Gone: true},
		File{Path: "new.md", From: "old.md", Content: "old\n"},
	)
	if err != nil {
		t.Fatal(err)
	}
	tree := must(t, clone, "ls-tree", "HEAD")
	for _, want := range []string{"100755 blob", "\trun.sh", "\tnew.md"} {
		if !strings.Contains(tree, want) {
			t.Errorf("tree lacks %q:\n%s", want, tree)
		}
	}
	for _, gone := range []string{"\tgone.md", "\told.md"} {
		if strings.Contains(tree, gone) {
			t.Errorf("tree still has %q", gone)
		}
	}
}

// A symlink is committed as mode 120000, its blob being its target text.
func TestCommitFilesCommitsASymlinkAsALink(t *testing.T) {
	clone, _ := repoPair(t)
	if _, err := commitFiles(t, clone, "Link", File{Path: "link.md", Content: "../outside/secret.md", Mode: "120000"}); err != nil {
		t.Fatal(err)
	}
	if tree := must(t, clone, "ls-tree", "HEAD", "link.md"); !strings.HasPrefix(tree, "120000 blob") {
		t.Errorf("tree: %s", tree)
	}
	if got := must(t, clone, "cat-file", "blob", "HEAD:link.md"); got != "../outside/secret.md" {
		t.Errorf("blob %q", got)
	}
}

// A commit whose tree would be HEAD's is refused: there is nothing to commit.
func TestCommitFilesRefusesNothingToCommit(t *testing.T) {
	clone, _ := repoPair(t)
	head := must(t, clone, "rev-parse", "HEAD")
	_, err := commitFiles(t, clone, "Nothing", File{Path: "index.md", Content: "---\nokf_version: \"0.1\"\n---\nhome\n"})
	if !errors.Is(err, ErrNothingToCommit) {
		t.Fatalf("err = %v", err)
	}
	if now := must(t, clone, "rev-parse", "HEAD"); now != head {
		t.Error("a commit was made")
	}
}

// The first commit of a branch with none yet.
func TestCommitFilesOnAnUnbornBranch(t *testing.T) {
	if !Available() {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	must(t, dir, "init", "--quiet", "--initial-branch=main")
	configure(t, dir, "t")
	write(t, dir, "index.md", "home\n")
	sha, err := commitFiles(t, dir, "First", File{Path: "index.md", Content: "home\n"})
	if err != nil {
		t.Fatal(err)
	}
	if head := must(t, dir, "rev-parse", "main"); head != sha {
		t.Errorf("main is %s", head)
	}
	if parents := must(t, dir, "log", "-1", "--format=%P"); parents != "" {
		t.Errorf("parents %q", parents)
	}
	if st := must(t, dir, "status", "--porcelain"); st != "" {
		t.Errorf("status %q", st)
	}
}

// HEAD moved between building and committing: nothing is committed.
func TestCommitFilesRefusesWhenHeadMoved(t *testing.T) {
	clone, _ := repoPair(t)
	// The hook runs after the tree is built and before HEAD moves: the moment
	// a commit from a terminal could land.
	hook(t, clone, "pre-commit", `env -u GIT_INDEX_FILE GIT_CONFIG_GLOBAL=/dev/null git commit --quiet --no-verify --allow-empty -m elsewhere`)
	_, err := commitFiles(t, clone, "Mine", File{Path: "index.md", Content: "mine\n"})
	if !errors.Is(err, ErrHeadMoved) {
		t.Fatalf("err = %v", err)
	}
	if log := must(t, clone, "log", "--format=%s"); strings.Contains(log, "Mine") || !strings.HasPrefix(log, "elsewhere") {
		t.Errorf("log:\n%s", log)
	}
}

// A failing pre-commit hook refuses, with its output.
func TestAFailingPreCommitHookRefuses(t *testing.T) {
	clone, _ := repoPair(t)
	hook(t, clone, "pre-commit", `echo "lint failed: trailing space" >&2; exit 1`)
	_, err := commitFiles(t, clone, "Mine", File{Path: "index.md", Content: "mine\n"})
	if err == nil || !strings.Contains(err.Error(), "lint failed: trailing space") {
		t.Fatalf("err = %v", err)
	}
	if log := must(t, clone, "log", "--format=%s"); log != "first" {
		t.Errorf("log %q", log)
	}
}

// A file a pre-commit hook rewrites is committed as it was shown, and the
// hook's change stays in the worktree, uncommitted. The hook sees the files
// being committed.
func TestAHookRewriteIsNotCommitted(t *testing.T) {
	clone, _ := repoPair(t)
	hook(t, clone, "pre-commit", `git diff --cached --name-only HEAD > .git/seen; echo formatted > index.md; git add index.md`)
	if _, err := commitFiles(t, clone, "Mine", File{Path: "index.md", Content: "as shown\n"}); err != nil {
		t.Fatal(err)
	}
	if got := must(t, clone, "show", "HEAD:index.md"); got != "as shown" {
		t.Errorf("committed %q", got)
	}
	if b, _ := os.ReadFile(filepath.Join(clone, "index.md")); string(b) != "formatted\n" {
		t.Errorf("worktree %q", b)
	}
	if seen, _ := os.ReadFile(filepath.Join(clone, ".git", "seen")); string(seen) != "index.md\n" {
		t.Errorf("the hook saw %q", seen)
	}
	if staged := must(t, clone, "diff", "--cached", "--name-only"); staged != "" {
		t.Errorf("staged: %q", staged)
	}
}

// A commit-msg hook can refuse, and its edit of the message is kept.
func TestTheCommitMsgHookRuns(t *testing.T) {
	clone, _ := repoPair(t)
	hook(t, clone, "commit-msg", `echo "Signed-off-by: t" >> "$1"`)
	if _, err := commitFiles(t, clone, "Mine", File{Path: "index.md", Content: "x\n"}); err != nil {
		t.Fatal(err)
	}
	if msg := must(t, clone, "log", "-1", "--format=%B"); msg != "Mine\nSigned-off-by: t" {
		t.Errorf("message %q", msg)
	}
	hook(t, clone, "commit-msg", `exit 1`)
	if _, err := commitFiles(t, clone, "Again", File{Path: "index.md", Content: "y\n"}); err == nil {
		t.Error("a failing commit-msg hook didn't refuse")
	}
}

// A failing post-commit hook can't undo the commit, so it is logged, with
// its output.
func TestAFailingPostCommitHookIsLogged(t *testing.T) {
	clone, _ := repoPair(t)
	hook(t, clone, "post-commit", `echo "notify failed" >&2; exit 1`)
	var logged strings.Builder
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	if _, err := commitFiles(t, clone, "Mine", File{Path: "index.md", Content: "x\n"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logged.String(), "post-commit") || !strings.Contains(logged.String(), "notify failed") {
		t.Errorf("logged %q", logged.String())
	}
}

func TestPushSendsTheCommits(t *testing.T) {
	clone, remote := repoPair(t)
	if _, err := commitFiles(t, clone, "Pushed", File{Path: "index.md", Content: "x\n"}); err != nil {
		t.Fatal(err)
	}
	s, err := Push(context.Background(), clone)
	if err != nil {
		t.Fatal(err)
	}
	if s.Ahead != 0 {
		t.Errorf("still ahead by %d", s.Ahead)
	}
	if out := must(t, remote, "log", "--oneline", "-1"); !strings.Contains(out, "Pushed") {
		t.Errorf("the remote's last commit is %q", out)
	}
}

// A machine configured to sign commits is a machine whose commits are signed,
// and this must not quietly make an exception. Configured exactly as a real one
// is — ssh signing, a key the agent would hold — with no agent to reach.
func TestAFailedSignatureIsNotSilentlyDropped(t *testing.T) {
	clone, _ := repoPair(t)
	must(t, clone, "config", "commit.gpgsign", "true")
	must(t, clone, "config", "gpg.format", "ssh")
	must(t, clone, "config", "user.signingkey", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIneverloaded")
	t.Setenv("SSH_AUTH_SOCK", "")
	write(t, clone, "notes/a.md", "---\ntype: note\n---\na\n")

	_, err := CommitFiles(context.Background(), clone, NewShadow(t.TempDir()), "add a note", []File{{Path: "notes/a.md", Content: "---\ntype: note\n---\na\n"}})
	if err == nil {
		t.Fatal("the commit succeeded, so it was made unsigned")
	}
	// Says what it is about, and keeps git's own words, which are the specific
	// ones.
	if !strings.Contains(err.Error(), "could not be signed") {
		t.Errorf("the error does not name signing: %v", err)
	}

	// And nothing was committed: no half-done state to discover later.
	if out := must(t, clone, "log", "--oneline"); strings.Contains(out, "add a note") {
		t.Errorf("a commit was made anyway: %q", out)
	}
}
