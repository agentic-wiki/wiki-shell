package git

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// File is one file of a commit, as the caller read and checked it.
type File struct {
	Path    string // from the bundle's folder
	From    string // a rename's old path, removed from the tree
	Content string // the checked bytes; a symlink's target text
	Source  string // or a file holding the checked bytes, read in place of Content
	Mode    string // 100755, or 120000 for a symlink; 100644 when empty
	Gone    bool   // deleted: removed from the tree
}

// ErrNothingToCommit is a commit refused because its tree would be HEAD's.
var ErrNothingToCommit = errors.New("nothing to commit: these files are as the last commit has them")

// ErrHeadMoved is a commit refused because HEAD moved while it was built.
var ErrHeadMoved = errors.New("the branch moved while committing (a commit or a pull elsewhere): nothing was committed")

// CommitFiles commits exactly the given files' checked bytes on top of HEAD,
// without the worktree or the user's index (the changes-view ADR):
//
//  1. the bytes go in as blobs, with the modes the caller gives;
//  2. a temporary index starts from HEAD's tree and takes the files;
//  3. the tree is written (refused if it is HEAD's: ErrNothingToCommit),
//     then the pre-commit and commit-msg hooks run, so nothing a hook
//     changes or stages is committed;
//  4. commit-tree makes the commit (signed when commit.gpgsign is set);
//  5. HEAD moves only from where it was, or ErrHeadMoved;
//  6. post-commit runs, and the committed paths in the user's index are set
//     to the new HEAD; anything else they staged stays.
//
// It returns the new commit's hash.
func CommitFiles(ctx context.Context, dir string, sh *Shadow, message string, files []File) (string, error) {
	r, err := info(ctx, dir)
	if err != nil {
		return "", err
	}
	if !hooksSupported(ctx) {
		return "", errors.New("committing here needs git 2.36 or later, to run your hooks")
	}
	sh.mu.Lock()
	root, err := sh.dir()
	sh.mu.Unlock()
	if err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(root, "commit-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	index, msgFile := filepath.Join(tmp, "index"), filepath.Join(tmp, "message")
	if err := os.WriteFile(msgFile, []byte(strings.TrimSpace(message)+"\n"), 0o600); err != nil {
		return "", err
	}
	tmpEnv := []string{"GIT_INDEX_FILE=" + index}
	git := func(env []string, stdin string, args ...string) (string, error) {
		return runWith(ctx, r.top, env, stdin, args...)
	}

	zero := strings.Repeat("0", len(emptyTree[r.format]))
	var entries strings.Builder // `update-index -z --index-info` lines
	var paths []string
	for _, f := range files {
		full := r.prefix + f.Path
		paths = append(paths, full)
		if f.From != "" {
			paths = append(paths, r.prefix+f.From)
			fmt.Fprintf(&entries, "0 %s\t%s\x00", zero, r.prefix+f.From)
		}
		if f.Gone {
			fmt.Fprintf(&entries, "0 %s\t%s\x00", zero, full)
			continue
		}
		var blob string
		if f.Source != "" { // streamed by git, however large
			blob, err = git(nil, "", "hash-object", "-w", "--path="+full, "--", f.Source)
		} else {
			blob, err = git(nil, f.Content, "hash-object", "-w", "--stdin", "--path="+full)
		}
		if err != nil {
			return "", err
		}
		mode := f.Mode
		if mode == "" {
			mode = "100644"
		}
		fmt.Fprintf(&entries, "%s %s\t%s\x00", mode, blob, full)
	}

	if r.head != "" {
		_, err = git(tmpEnv, "", "read-tree", r.head)
	} else {
		_, err = git(tmpEnv, "", "read-tree", "--empty")
	}
	if err != nil {
		return "", err
	}
	if _, err := git(tmpEnv, entries.String(), "update-index", "-z", "--index-info"); err != nil {
		return "", err
	}
	tree, err := git(tmpEnv, "", "write-tree")
	if err != nil {
		return "", err
	}
	if r.head != "" {
		if headTree, _ := git(nil, "", "rev-parse", r.head+"^{tree}"); tree == headTree {
			return "", ErrNothingToCommit
		}
	}

	if _, err := git(tmpEnv, "", "hook", "run", "--ignore-missing", "pre-commit"); err != nil {
		return "", fmt.Errorf("the pre-commit hook refused the commit: %w", err)
	}
	if _, err := git(tmpEnv, "", "hook", "run", "--ignore-missing", "commit-msg", "--", msgFile); err != nil {
		return "", fmt.Errorf("the commit-msg hook refused the commit: %w", err)
	}

	args := []string{"commit-tree", tree, "-F", msgFile}
	if r.head != "" {
		args = append(args, "-p", r.head)
	}
	if sign, _ := git(nil, "", "config", "--type=bool", "commit.gpgsign"); sign == "true" {
		args = append(args, "-S")
	}
	commit, err := git(nil, "", args...)
	if err != nil {
		return "", commitError(err)
	}

	old, reflog := r.head, "commit: "
	if old == "" {
		old, reflog = zero, "commit (initial): "
	}
	subject, _, _ := strings.Cut(strings.TrimSpace(message), "\n")
	if _, err := git(nil, "", "update-ref", "-m", reflog+subject, "HEAD", commit, old); err != nil {
		if now, _ := run(ctx, dir, "rev-parse", "--verify", "--quiet", "HEAD"); now != r.head {
			return "", ErrHeadMoved
		}
		return "", err
	}

	// After the commit: post-commit can't undo it (as for `git commit`), and
	// the user's index only needs the committed paths brought to the new HEAD.
	if _, err := git(nil, "", "hook", "run", "--ignore-missing", "post-commit"); err != nil {
		log.Printf("commit %s: the post-commit hook failed: %v", commit, err)
	}
	resetArgs := []string{"reset", "-q", "--"}
	for _, p := range paths {
		resetArgs = append(resetArgs, ":(top,literal)"+p)
	}
	if _, err := git(nil, "", resetArgs...); err != nil {
		log.Printf("commit %s: the committed files are still staged as before: %v", commit, err)
	}
	return commit, nil
}

// hooksSupported reports git 2.36 or later, which has `git hook run`.
func hooksSupported(ctx context.Context) bool {
	out, err := run(ctx, ".", "version")
	if err != nil {
		return false
	}
	fields := strings.Fields(out) // git version 2.47.3
	if len(fields) < 3 {
		return false
	}
	parts := strings.SplitN(fields[2], ".", 3)
	if len(parts) < 2 {
		return false
	}
	major, _ := strconv.Atoi(parts[0])
	minor, _ := strconv.Atoi(parts[1])
	return major > 2 || major == 2 && minor >= 36
}

// Push pushes the branch to its upstream.
func Push(ctx context.Context, dir string) (Status, error) {
	if _, err := run(ctx, dir, "push"); err != nil {
		return Repo(dir), err
	}
	return Repo(dir), nil
}
