package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Real repositories in temp directories, not a fake.
//
// The whole argument for shelling out is that these commands behave exactly as
// they do in the user's terminal, and a test against a mock would be testing the
// mock's opinion of git rather than git's.
func must(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

/*
configure pins the settings that would otherwise come from the machine.

**In the repository's own config, not the environment.** `must` suppresses the
global and system files so a developer's identity does not leak into a test, but
the code under test shells out with the ambient environment — that is the entire
point of shelling out — so it reads config that `must` does not. Anything set one
side of that line and not the other makes the test and the thing it is testing
disagree about the same repository. Repo-local config is the one place both of
them look.

`core.autocrlf` is why this exists rather than being three inlined lines. Git for
Windows turns it on in the system config, so on a Windows runner a checkout wrote
CRLF while the test's own `git status` was still reading the file as LF, and a
`rebase --abort` that restored the tree perfectly was reported as leaving it
dirty. Nothing here is a Windows workaround: it is the test declaring the
repository it means to be testing against.

Signing is off for a plainer reason: a machine configured to sign commits has an
agent, and a container running tests does not.
*/
func configure(t *testing.T, dir, who string) {
	t.Helper()
	must(t, dir, "config", "user.email", who+"@example.com")
	must(t, dir, "config", "user.name", who)
	must(t, dir, "config", "commit.gpgsign", "false")
	must(t, dir, "config", "core.autocrlf", "false")
}

// A bare "remote" and a clone of it, which is the shape every action assumes.
func repoPair(t *testing.T) (clone, remote string) {
	t.Helper()
	if !Available() {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	remote = filepath.Join(root, "remote.git")
	must(t, root, "init", "--bare", "--initial-branch=main", remote)

	clone = filepath.Join(root, "work")
	must(t, root, "clone", "--quiet", remote, clone)
	configure(t, clone, "t")
	write(t, clone, "index.md", "---\nokf_version: \"0.1\"\n---\nhome\n")
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "first")
	must(t, clone, "push", "--quiet", "--set-upstream", "origin", "main")
	return clone, remote
}

// Not being a repository is an ordinary answer. A bundle is a folder first, and
// most folders are not repositories.
func TestAFolderThatIsNotARepository(t *testing.T) {
	if s := Repo(t.TempDir()); s.Repo {
		t.Errorf("status = %+v, want repo=false", s)
	}
}

func TestStatusReadsTheBranchAndItsUpstream(t *testing.T) {
	clone, _ := repoPair(t)
	s := Repo(clone)
	if !s.Repo || s.Branch != "main" {
		t.Fatalf("status = %+v", s)
	}
	if s.Remote != "origin/main" {
		t.Errorf("remote = %q, want origin/main", s.Remote)
	}
	if s.Ahead != 0 || s.Behind != 0 || len(s.Changes) != 0 {
		t.Errorf("a clean clone reports %+v", s)
	}
}

// Head is HEAD's short sha on a branch and on a detached HEAD alike, so a
// detached one can say where it is; "" before the first commit and outside a
// repository. Before the first commit, the branch is still named: a new
// repository isn't detached.
func TestStatusCarriesHeadsShortSha(t *testing.T) {
	clone, _ := repoPair(t)
	sha := must(t, clone, "rev-parse", "--short", "HEAD")
	if s := Repo(clone); s.Head != sha || s.Branch != "main" {
		t.Errorf("on a branch: head %q branch %q, want %q main", s.Head, s.Branch, sha)
	}
	must(t, clone, "checkout", "--quiet", "--detach")
	if s := Repo(clone); s.Head != sha || s.Branch != "" {
		t.Errorf("detached: head %q branch %q, want %q and no branch", s.Head, s.Branch, sha)
	}

	unborn := t.TempDir()
	must(t, unborn, "init", "--quiet", "--initial-branch=main")
	if s := Repo(unborn); !s.Repo || s.Head != "" || s.Branch != "main" {
		t.Errorf("unborn: %+v, want branch main and no head", s)
	}
	if s := Repo(t.TempDir()); s.Head != "" {
		t.Errorf("outside a repository: head %q", s.Head)
	}
}

// The preview has to show everything a commit would carry, including work
// somebody else did: an agent editing alongside is the expected case, and hiding
// its files would be lying about what the button does.
func TestChangesListEverythingInTheBundle(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "index.md", "---\nokf_version: \"0.1\"\n---\nedited\n")
	write(t, clone, "notes/new.md", "---\ntype: note\n---\nby an agent\n")

	byPath := map[string]string{}
	for _, c := range Repo(clone).Changes {
		byPath[c.Path] = c.Code
	}
	if byPath["index.md"] != " M" {
		t.Errorf("index.md = %q, want modified", byPath["index.md"])
	}
	if byPath["notes/new.md"] != "??" {
		t.Errorf("notes/new.md = %q, want untracked", byPath["notes/new.md"])
	}
}

// A bundle can be a subdirectory of a larger repository, and a button in a notes
// viewer must not sweep up somebody's unrelated work in the same worktree.
func TestChangesAreScopedToTheBundle(t *testing.T) {
	clone, _ := repoPair(t)
	write(t, clone, "elsewhere/code.go", "package main\n")
	write(t, clone, "kb/index.md", "---\nokf_version: \"0.1\"\n---\nnotes\n")
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "second")

	write(t, clone, "elsewhere/code.go", "package main // edited\n")
	write(t, clone, "kb/note.md", "---\ntype: note\n---\nn\n")

	// Asked from inside the bundle, which is the only thing this program ever
	// points at.
	for _, c := range Repo(filepath.Join(clone, "kb")).Changes {
		if strings.Contains(c.Path, "elsewhere") {
			t.Errorf("a change outside the bundle was listed: %+v", c)
		}
	}
	if got := len(Repo(filepath.Join(clone, "kb")).Changes); got != 1 {
		t.Errorf("changes = %d, want only the bundle's one", got)
	}
}

// Staged work outside the bundle is counted so the preview can say it will be
// left alone. Not committing it is right; letting somebody assume otherwise is
// not.
func TestOutsideCountsStagedWorkACommitWillNotTouch(t *testing.T) {
	clone, _ := repoPair(t)
	bundle := filepath.Join(clone, "bundle")
	write(t, clone, "bundle/index.md", "home\n")
	write(t, clone, "secret.txt", "unrelated\n")
	write(t, clone, "notes/other.txt", "unrelated\n")
	must(t, clone, "add", ".")
	must(t, clone, "commit", "--quiet", "--message", "second")

	if got := Repo(bundle).Outside; got != 0 {
		t.Errorf("nothing is staged, so nothing is outside: got %d", got)
	}

	must(t, clone, "add", "secret.txt")
	write(t, clone, "secret.txt", "one\n")
	write(t, clone, "notes/other.txt", "two\n")
	must(t, clone, "add", "secret.txt", "notes/other.txt")
	// And something staged inside the bundle, which is not "outside" and is the
	// thing a commit here is for.
	write(t, clone, "bundle/b.md", "b\n")
	must(t, clone, "add", "bundle/b.md")

	if got := Repo(bundle).Outside; got != 2 {
		t.Errorf("two files staged outside the bundle: got %d", got)
	}
	// Seen from the repository root, the bundle is the whole thing and nothing
	// can be outside it.
	if got := Repo(clone).Outside; got != 0 {
		t.Errorf("a bundle at the repository root has no outside: got %d", got)
	}
}

// pushFrom makes n commits in a second checkout and pushes them, as somebody
// else working on the same remote would. Subjects are "theirs 1"…"theirs n".
func pushFrom(t *testing.T, remote string, n int) {
	t.Helper()
	other := filepath.Join(t.TempDir(), "other")
	must(t, filepath.Dir(other), "clone", "--quiet", remote, other)
	configure(t, other, "ana")
	for i := 1; i <= n; i++ {
		name := "theirs " + strconv.Itoa(i)
		write(t, other, strconv.Itoa(i)+".md", "---\ntype: note\n---\n"+name+"\n")
		must(t, other, "add", ".")
		// A subject with a tab and a pipe in it: the fields are split on a
		// character a message cannot hold, and this is what proves it.
		must(t, other, "commit", "--quiet", "--author", "ana <ana@example.com>", "--message", name+"\twith | separators")
	}
	must(t, other, "push", "--quiet")
}

// What a pull would take, said as commits rather than a count: newest first,
// with who wrote each and when, so the preview reads like the log it is.
func TestIncomingListsTheCommitsAPullWouldTake(t *testing.T) {
	clone, remote := repoPair(t)
	if s := Repo(clone); len(s.Incoming) != 0 || s.Incoming == nil {
		t.Fatalf("level with upstream, incoming = %#v, want an empty list", s.Incoming)
	}
	pushFrom(t, remote, 3)
	// Nothing is known until something fetches, and nothing here fetches on its
	// own: the list is as stale as Behind, by design.
	if s := Repo(clone); len(s.Incoming) != 0 {
		t.Errorf("before a fetch, incoming = %v", s.Incoming)
	}
	if _, err := Fetch(context.Background(), clone); err != nil {
		t.Fatal(err)
	}
	s := Repo(clone)
	if len(s.Incoming) != 3 {
		t.Fatalf("incoming = %+v, want 3", s.Incoming)
	}
	first := s.Incoming[0]
	if first.Subject != "theirs 3\twith | separators" || first.Author != "ana" {
		t.Errorf("newest = %+v, want the last one pushed, whole subject, by ana", first)
	}
	if s.Incoming[2].Subject != "theirs 1\twith | separators" {
		t.Errorf("oldest = %+v", s.Incoming[2])
	}
	if len(first.SHA) < 7 || strings.ContainsAny(first.SHA, " \t") {
		t.Errorf("sha = %q, want an abbreviated hash", first.SHA)
	}
	if _, err := time.Parse(time.RFC3339, first.When); err != nil {
		t.Errorf("when = %q: %v", first.When, err)
	}

	// Taken, and so no longer incoming.
	if _, err := Pull(context.Background(), clone); err != nil {
		t.Fatal(err)
	}
	if s := Repo(clone); len(s.Incoming) != 0 {
		t.Errorf("after pulling, incoming = %v", s.Incoming)
	}
}

// Behind is the count and Incoming is a sample of it: past the limit the list
// stops, and the count does not.
func TestIncomingIsCappedWhileBehindIsNot(t *testing.T) {
	clone, remote := repoPair(t)
	pushFrom(t, remote, IncomingLimit+2)
	if _, err := Fetch(context.Background(), clone); err != nil {
		t.Fatal(err)
	}
	s := Repo(clone)
	if s.Behind != IncomingLimit+2 || len(s.Incoming) != IncomingLimit {
		t.Errorf("behind=%d incoming=%d, want %d and %d", s.Behind, len(s.Incoming), IncomingLimit+2, IncomingLimit)
	}
}

// Without an upstream there is nothing to pull from, and still a list.
func TestIncomingIsAnEmptyListWithoutAnUpstream(t *testing.T) {
	if !Available() {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	must(t, dir, "init", "--quiet", "--initial-branch=main")
	s := Repo(dir)
	if s.Incoming == nil || len(s.Incoming) != 0 {
		t.Errorf("incoming = %#v, want an empty list", s.Incoming)
	}
	if none := Repo(t.TempDir()); none.Incoming == nil {
		t.Error("outside a repository, incoming is nil: it would marshal as null")
	}
}
