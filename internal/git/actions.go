package git

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Fetch updates what the repository knows about its upstream, and reports the
// status that follows.
//
// Separate from reading the status because it is the one read that reaches the
// network, and this program does nothing over a network without being asked.
// Asking to see what a pull would do is asking.
func Fetch(ctx context.Context, dir string) (Status, error) {
	if _, err := run(ctx, dir, "fetch", "--quiet"); err != nil {
		return Repo(dir), err
	}
	return Repo(dir), nil
}

// Pull rebases the branch onto its upstream.
//
// Rebase rather than merge: a wiki's history is a sequence of edits, and a merge
// commit per pull says nothing about the notes. It also makes the failure
// recoverable, which is the whole of the rule below.
//
// **A pull that fails leaves nothing behind.** A rebase that stops halfway is a
// conflicted worktree, and a web page has no business asking somebody to resolve
// one: there is no editor here, no `git status` to read, and no way out that does
// not involve a terminal. So a failure aborts, restoring the tree exactly as it
// was, and the caller is told what happened — with the local work still local and
// still intact, ready to be pushed somewhere safe.
func Pull(ctx context.Context, dir string) (Status, error) {
	if _, err := run(ctx, dir, "rebase", "--quiet", "@{upstream}"); err != nil {
		// Best effort, and unconditional: `--abort` on a rebase that never
		// started is harmless, and not trying would be worse than trying and
		// finding nothing to undo.
		_, abortErr := run(ctx, dir, "rebase", "--abort")
		if abortErr != nil {
			// The tree is mid-rebase and this could not undo it, which is the
			// one case where saying so plainly is all that can be done.
			return Repo(dir), fmt.Errorf(
				"the pull failed and could not be undone, so the repository is mid-rebase: %w", err)
		}
		return Repo(dir), fmt.Errorf("the pull was undone and nothing changed: %w", err)
	}
	return Repo(dir), nil
}

// Branch pushes the current work to a new branch on the remote.
//
// The way out of a failed pull. The local commits are already safe on disk; what
// this adds is safe *somewhere else*, so the conflict can be resolved with a real
// tool on a real checkout instead of in a browser tab.
//
// The branch is created at HEAD and pushed, and the working branch is left where
// it was: nothing here moves anybody onto a different branch as a side effect of
// rescuing their work.
func Branch(ctx context.Context, dir, name string) (Status, error) {
	if !validBranch.MatchString(name) {
		return Repo(dir), fmt.Errorf("%w: %q", ErrBadBranch, name)
	}
	// git's own rule too, and the name always after `--`, so it is never read
	// as an option.
	if _, err := run(ctx, dir, "check-ref-format", "--branch", name); err != nil {
		return Repo(dir), fmt.Errorf("%w: %q", ErrBadBranch, name)
	}
	if _, err := run(ctx, dir, "branch", "--", name); err != nil {
		return Repo(dir), err
	}
	// No `--set-upstream`: this is a place to put the work, not a branch to move
	// onto, and rewriting the tracking of the branch somebody is on would be a
	// side effect of a rescue.
	if _, err := run(ctx, dir, "push", "--", "origin", name); err != nil {
		// Leave no half-made branch behind: it was created for this push, and a
		// dangling local branch is litter somebody has to notice and clean up.
		_, _ = run(ctx, dir, "branch", "--delete", "--", name)
		return Repo(dir), err
	}
	return Repo(dir), nil
}

// ErrBadBranch is a rescue name that isn't a branch name.
var ErrBadBranch = errors.New("not a branch name")

// validBranch is deliberately narrower than git's own rule, and starts with a
// letter or digit, so a name is never an option.
//
// This name is proposed by the UI and confirmed by a person, so it only has to
// admit the names that proposal produces and the ones somebody would type in its
// place. Anything git would accept but a shell would mangle is not worth the
// argument.
var validBranch = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$`)

// ProposedBranch is the name offered when a pull has to be abandoned.
//
// Dated and prefixed, so it sorts with its siblings, says where it came from, and
// never collides with a branch somebody named themselves.
func ProposedBranch(now time.Time) string {
	return "wikishell/" + now.Format("2006-01-02-1504")
}

// commitError names the cause when a commit fails for a reason git states
// obliquely.
//
// **Signing is never dropped to make a commit succeed.** Somebody who set
// `commit.gpgsign` decided every commit they make is signed, and a web page
// quietly producing unsigned ones would put a hole in that record which they did
// not ask for and would not notice. It would also make this behave differently
// from the same action in their terminal, which is the one thing shelling out to
// their git is for. And it often only moves the failure: a repository that
// requires signed commits rejects the push instead, after the commit exists.
//
// So the commit fails, and the message says why. Git's own words are kept — they
// are the specific ones — with a sentence in front saying what they are about,
// because "Couldn't get agent socket" reads as nothing at all unless you already
// know signing is turned on.
func commitError(err error) error {
	text := strings.ToLower(err.Error())
	for _, sign := range []string{"gpg", "agent socket", "signing", "failed to sign"} {
		if strings.Contains(text, sign) {
			return fmt.Errorf(
				"the commit could not be signed, and WikiShell will not make an unsigned one on your behalf: %w", err)
		}
	}
	return err
}
