package git

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// The changes view's git (the changes-view ADR): every uncommitted change in
// the bundle, read without touching the user's index or object store. git
// diffs a shadow index against HEAD, and the objects it hashes go to a shadow
// object directory in the user's cache folder. So untracked files show up, a
// deleted file plus a new one becomes a rename, and `git status` in a terminal
// reads exactly as before.

// MaxDiffSize is the largest file the changes view hashes and diffs. A bigger
// one is listed by name and size only.
const MaxDiffSize = 2 << 20

// shadowLimit is the size past which the shadow objects are emptied.
const shadowLimit = 512 << 20

// emptyTree is git's tree with nothing in it, per object format: the base of
// a diff on a branch with no commit yet.
var emptyTree = map[string]string{
	"sha1":   "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	"sha256": "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
}

// ErrShadowRemoved is the answer once the server has stopped.
var ErrShadowRemoved = errors.New("the server is stopping")

// Shadow is the session's shadow index and object directory: a folder of its
// own under base (mode 0700, since its objects are copies of the wiki's
// files), made on first use. Remove deletes it when the server stops.
//
// Next to the folder sits its lock file, held for the server's life, so a
// shadow left by a killed server can be told from a live one's (sweep).
type Shadow struct {
	mu      sync.Mutex
	base    string
	err     error // no cache folder for it
	root    string
	lock    *os.File
	removed bool
	// head holds each file of the commit headOf (headFiles).
	head   map[string]headFile
	headOf string
}

// NewShadow is a shadow under base, or under the user's cache folder when
// base is "". It removes the shadows that killed servers left there.
//
// With no cache folder (HOME and XDG_CACHE_HOME unset), every use fails with
// the reason. A shared folder such as /tmp isn't a fallback: another user
// could own it, and swap the files a commit is built from.
func NewShadow(base string) *Shadow {
	if base == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			return &Shadow{err: fmt.Errorf("the changes view needs a cache folder for its copies of your files: %w", err)}
		}
		base = filepath.Join(cache, "wikishell")
	}
	sweep(base)
	return &Shadow{base: base}
}

// sweep removes the shadows under base whose server is gone: a lock file no
// process holds, then any shadow folder without its lock file. A server
// makes its lock file before its folder and removes it after, so a folder
// without one is never live. Best effort: what can't be removed now is tried
// again at the next start.
func sweep(base string) {
	locks, _ := filepath.Glob(filepath.Join(base, "shadow-*.lock"))
	for _, l := range locks {
		if f, err := os.OpenFile(l, os.O_RDWR, 0); err == nil {
			free := lockFile(f) == nil
			f.Close()
			if free {
				os.Remove(l) // fails on Windows while its server has it open
			}
		}
	}
	dirs, _ := filepath.Glob(filepath.Join(base, "shadow-*"))
	for _, d := range dirs {
		if _, err := os.Stat(d + ".lock"); !strings.HasSuffix(d, ".lock") && errors.Is(err, fs.ErrNotExist) {
			os.RemoveAll(d)
		}
	}
}

// dir makes the shadow folder on first use: its lock file, held, then the
// folder. Called with mu held.
func (sh *Shadow) dir() (string, error) {
	switch {
	case sh.removed:
		return "", ErrShadowRemoved
	case sh.err != nil:
		return "", sh.err
	}
	if sh.root != "" {
		return sh.root, nil
	}
	if err := os.MkdirAll(sh.base, 0o700); err != nil {
		return "", err
	}
	lock, err := os.CreateTemp(sh.base, "shadow-*.lock")
	if err != nil {
		return "", err
	}
	// Another server's sweep can remove the file between its creation and the
	// lock; then the lock guards nothing, and a new one is made.
	if err := lockFile(lock); err != nil || !stillThere(lock) {
		lock.Close()
		if err != nil {
			return "", err
		}
		return sh.dir()
	}
	root := strings.TrimSuffix(lock.Name(), ".lock")
	if err := os.Mkdir(root, 0o700); err != nil {
		lock.Close()
		os.Remove(lock.Name())
		return "", err
	}
	sh.root, sh.lock = root, lock
	return root, nil
}

// Spool is a new temporary file in the shadow folder, for a copy of a file's
// checked bytes: private, and deleted with the shadow if the caller doesn't.
func (sh *Shadow) Spool() (*os.File, error) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	root, err := sh.dir()
	if err != nil {
		return nil, err
	}
	return os.CreateTemp(root, "spool-*")
}

// stillThere reports whether f's path is still f.
func stillThere(f *os.File) bool {
	a, err := f.Stat()
	if err != nil {
		return false
	}
	b, err := os.Stat(f.Name())
	return err == nil && os.SameFile(a, b)
}

// Remove deletes the shadow folder and everything in it, then its lock file.
// Any later use fails with ErrShadowRemoved.
func (sh *Shadow) Remove() error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.removed = true
	if sh.root == "" {
		return nil
	}
	err := os.RemoveAll(sh.root)
	sh.lock.Close()
	if err == nil {
		err = os.Remove(sh.lock.Name())
	}
	return err
}

// repoInfo is what the commands here need about the repository a bundle is in.
type repoInfo struct {
	top     string // the worktree's top
	prefix  string // the bundle's folder from the top, with a trailing slash ("" at the top)
	index   string // the user's index file
	objects string // the user's object directory
	head    string // HEAD's commit, "" on a branch with no commit yet
	format  string // sha1 | sha256
}

// base is what a diff compares with: HEAD, or the empty tree before the first commit.
func (r repoInfo) base() string {
	if r.head != "" {
		return r.head
	}
	return emptyTree[r.format]
}

// spec is a bundle path as a pathspec that matches only that path, whatever
// characters it holds and wherever git runs.
func (r repoInfo) spec(rel string) string { return ":(top,literal)" + r.prefix + rel }

func info(ctx context.Context, dir string) (repoInfo, error) {
	out, err := run(ctx, dir, "rev-parse", "--show-toplevel", "--show-prefix", "--git-path", "index", "--git-path", "objects", "--show-object-format")
	if err != nil {
		return repoInfo{}, err
	}
	lines := strings.Split(out, "\n")
	if len(lines) != 5 {
		return repoInfo{}, fmt.Errorf("git rev-parse said %q", out)
	}
	abs := func(p string) string {
		if filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(dir, p)
	}
	r := repoInfo{top: lines[0], prefix: lines[1], index: abs(lines[2]), objects: abs(lines[3]), format: lines[4]}
	if head, err := run(ctx, dir, "rev-parse", "--verify", "--quiet", "HEAD"); err == nil {
		r.head = head
	}
	return r, nil
}

// shadowEnv points git at the shadow index and objects. The user's objects
// are read as alternates and never written.
func shadowEnv(root string, r repoInfo) []string {
	return []string{
		"GIT_INDEX_FILE=" + filepath.Join(root, "index"),
		"GIT_OBJECT_DIRECTORY=" + filepath.Join(root, "objects"),
		"GIT_ALTERNATE_OBJECT_DIRECTORIES=" + r.objects,
		"GIT_OPTIONAL_LOCKS=0",
	}
}

// prepare makes the shadow ready for a pass, and returns its environment. The
// objects are emptied past shadowLimit. A new shadow index starts as a copy of
// the user's: `add --all` makes it the worktree's either way, and the copy
// brings git's stat cache, so later passes only hash what changed. Called with
// mu held.
func (sh *Shadow) prepare(r repoInfo) ([]string, error) {
	root, err := sh.dir()
	if err != nil {
		return nil, err
	}
	objects, index := filepath.Join(root, "objects"), filepath.Join(root, "index")
	if size(objects) > shadowLimit {
		if err := os.RemoveAll(objects); err != nil {
			return nil, err
		}
		os.Remove(index)
	}
	if err := os.MkdirAll(objects, 0o700); err != nil {
		return nil, err
	}
	if _, err := os.Stat(index); errors.Is(err, fs.ErrNotExist) {
		b, err := os.ReadFile(r.index)
		switch {
		case err == nil:
			if err := os.WriteFile(index, b, 0o600); err != nil {
				return nil, err
			}
			// With the real index's mtime, as `cp -p` would: git's racily-
			// clean check compares each file's mtime with the index file's, so
			// a fresh mtime would make a same-size edit made in the same
			// second as the last index write look clean, for good.
			if fi, err := os.Stat(r.index); err == nil {
				if err := os.Chtimes(index, fi.ModTime(), fi.ModTime()); err != nil {
					return nil, err
				}
			}
		case !errors.Is(err, fs.ErrNotExist): // no index yet: git starts an empty one
			return nil, err
		}
	}
	return shadowEnv(root, r), nil
}

func size(dir string) int64 {
	var n int64
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n
}

// IsDot reports a bundle path with a segment starting with `.`: `.git`,
// `.env`, `.ssh`, an editor's swap file, or `..` out of the bundle. Such a
// file can hold secrets, so it is never served, shown, hashed, diffed or
// committed, whatever links to it. This is the one rule every read follows.
func IsDot(rel string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(rel), "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

// FileChange is one changed file of the bundle, as git sees it. Paths are
// from the bundle's folder, slash-separated.
type FileChange struct {
	Path   string
	From   string // a rename's old path
	Change string // new | modified | deleted | renamed
	Dot    bool   // a dot path: listed by name only
	Large  bool   // over MaxDiffSize: listed without a diff, never hashed into the shadow
	// Filtered has a `filter` attribute (git-lfs): listed without a diff,
	// never added to the shadow, so its clean filter never runs on a listing.
	Filtered bool
	Binary   bool
	Added    int // lines, for a text file
	Removed  int
	// HeadMode and HeadBlob are HEAD's mode and blob id for the file (its old
	// path, for a rename): "" when HEAD hasn't it. ExecBit is core.fileMode:
	// whether the worktree's execute bit is the file's mode, as `git add`
	// takes it.
	HeadMode string
	HeadBlob string
	ExecBit  bool
}

// Changes lists the bundle's uncommitted changes. repo is false when the
// bundle isn't in a git repository, or git isn't installed.
func Changes(ctx context.Context, dir string, sh *Shadow) (repo bool, files []FileChange, err error) {
	if !Available() {
		return false, []FileChange{}, nil
	}
	r, err := info(ctx, dir)
	if err != nil {
		return false, []FileChange{}, nil // not a repository
	}
	sh.mu.Lock()
	defer sh.mu.Unlock()
	env, err := sh.prepare(r)
	if err != nil {
		return true, nil, err
	}

	byPath := map[string]*FileChange{}
	var order []string
	add := func(c FileChange) {
		if _, ok := byPath[c.Path]; !ok {
			order = append(order, c.Path)
		}
		byPath[c.Path] = &c
	}

	// Dot paths, large files and filtered files come from the user's own
	// status, which reads without hashing new files: they are listed, never
	// hashed into the shadow.
	excludes := []string{":(exclude).*", ":(exclude)**/.*"}
	status, err := runWith(ctx, dir, []string{"GIT_OPTIONAL_LOCKS=0"}, "", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ".")
	if err != nil {
		return true, nil, err
	}
	var pending []FileChange // the others, to check for a filter
	for _, rec := range strings.Split(status, "\x00") {
		if len(rec) < 4 {
			continue
		}
		code, rel := rec[:2], strings.TrimPrefix(rec[3:], r.prefix)
		change := "modified"
		switch {
		case code == "??" || code[0] == 'A':
			change = "new"
		case code[0] == 'D' || code[1] == 'D':
			change = "deleted"
		}
		if IsDot(rel) {
			add(FileChange{Path: rel, Change: change, Dot: true})
			continue
		}
		if change == "deleted" {
			continue
		}
		if fi, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(rel))); err == nil && fi.Mode().IsRegular() && fi.Size() > MaxDiffSize {
			add(FileChange{Path: rel, Change: change, Large: true})
			excludes = append(excludes, ":(exclude,literal)"+rel)
			continue
		}
		pending = append(pending, FileChange{Path: rel, Change: change, Filtered: true})
	}
	filtered, err := filteredPaths(ctx, dir, pending)
	if err != nil {
		return true, nil, err
	}
	for _, c := range pending {
		if filtered[c.Path] {
			add(c)
			excludes = append(excludes, ":(exclude,literal)"+c.Path)
		}
	}

	if _, err := runWith(ctx, dir, env, "", append([]string{"add", "--all", "--", "."}, excludes...)...); err != nil {
		return true, nil, err
	}
	diff := func(format string) (string, error) {
		return runWith(ctx, dir, env, "", "diff", "--cached", "-z", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--relative", format, r.base(), "--", ".")
	}
	names, err := diff("--name-status")
	if err != nil {
		return true, nil, err
	}
	nums, err := diff("--numstat")
	if err != nil {
		return true, nil, err
	}
	for _, c := range parseNameStatus(names) {
		// A dot path is excluded from `add`, so the shadow index only keeps
		// what it was seeded with: its status line above is the truth. A large
		// or filtered file is listed above too.
		if IsDot(c.Path) || IsDot(c.From) || byPath[c.Path] != nil {
			continue
		}
		add(c)
	}
	for path, n := range parseNumstat(nums) {
		c, ok := byPath[path]
		if !ok || c.Dot || c.Large || c.Filtered {
			continue
		}
		c.Binary = n.binary
		c.Added, c.Removed = n.added, n.removed
	}
	head, err := sh.headFiles(ctx, dir, r)
	if err != nil {
		return true, nil, err
	}
	execBit := configBool(ctx, dir, "core.fileMode", true)
	files = make([]FileChange, 0, len(order))
	for _, p := range order {
		c := *byPath[p]
		from := c.Path
		if c.From != "" {
			from = c.From
		}
		c.HeadMode, c.HeadBlob, c.ExecBit = head[from].mode, head[from].blob, execBit
		files = append(files, c)
	}
	return true, files, nil
}

// filteredPaths is which of the changes have a `filter` attribute set, from
// one `git check-attr`.
func filteredPaths(ctx context.Context, dir string, changes []FileChange) (map[string]bool, error) {
	if len(changes) == 0 {
		return nil, nil
	}
	var paths strings.Builder
	for _, c := range changes {
		paths.WriteString(c.Path + "\x00")
	}
	out, err := runWith(ctx, dir, nil, paths.String(), "check-attr", "-z", "--stdin", "filter")
	if err != nil {
		return nil, err
	}
	filtered := map[string]bool{}
	f := strings.Split(out, "\x00") // path, attribute, value
	for i := 0; i+2 < len(f); i += 3 {
		if v := f[i+2]; v != "unspecified" && v != "unset" {
			filtered[f[i]] = true
		}
	}
	return filtered, nil
}

// headFile is a file of HEAD: its mode and blob id.
type headFile struct{ mode, blob string }

// headFiles is every file of HEAD in the bundle, by bundle path, read once
// per HEAD. Called with mu held.
func (sh *Shadow) headFiles(ctx context.Context, dir string, r repoInfo) (map[string]headFile, error) {
	if r.head == "" {
		return map[string]headFile{}, nil
	}
	if sh.headOf == r.head {
		return sh.head, nil
	}
	out, err := runWith(ctx, dir, nil, "", "ls-tree", "-r", "-z", r.head, "--", ".")
	if err != nil {
		return nil, err
	}
	files := map[string]headFile{}
	for _, rec := range strings.Split(out, "\x00") {
		meta, path, ok := strings.Cut(rec, "\t")
		if f := strings.Fields(meta); ok && len(f) == 3 { // mode, type, id
			files[path] = headFile{mode: f[0], blob: f[2]}
		}
	}
	sh.head, sh.headOf = files, r.head
	return files, nil
}

// configBool is a boolean of the repository's git config, or def when unset.
func configBool(ctx context.Context, dir, key string, def bool) bool {
	switch v, _ := run(ctx, dir, "config", "--type=bool", key); v {
	case "true":
		return true
	case "false":
		return false
	}
	return def
}

// parseNameStatus reads `diff --name-status -z`: a status letter, then one
// path, or two for a rename (old, new).
func parseNameStatus(out string) []FileChange {
	f := strings.Split(out, "\x00")
	var list []FileChange
	for i := 0; i+1 < len(f); i++ {
		code := f[i]
		if code == "" {
			continue
		}
		if code[0] == 'R' {
			if i+2 >= len(f) {
				break
			}
			list = append(list, FileChange{From: f[i+1], Path: f[i+2], Change: "renamed"})
			i += 2
			continue
		}
		change := map[byte]string{'A': "new", 'D': "deleted"}[code[0]]
		if change == "" {
			change = "modified"
		}
		list = append(list, FileChange{Path: f[i+1], Change: change})
		i++
	}
	return list
}

type numstat struct {
	added, removed int
	binary         bool
}

// parseNumstat reads `diff --numstat -z`: "added\tremoved\tpath", or for a
// rename "added\tremoved\t" followed by the old and the new path. A binary
// file counts "-".
func parseNumstat(out string) map[string]numstat {
	recs := strings.Split(out, "\x00")
	m := map[string]numstat{}
	for i := 0; i < len(recs); i++ {
		parts := strings.SplitN(recs[i], "\t", 3)
		if len(parts) < 3 {
			continue
		}
		p := parts[2]
		if p == "" && i+2 < len(recs) {
			p = recs[i+2]
			i += 2
		}
		if parts[0] == "-" {
			m[p] = numstat{binary: true}
			continue
		}
		a, _ := strconv.Atoi(parts[0])
		d, _ := strconv.Atoi(parts[1])
		m[p] = numstat{added: a, removed: d}
	}
	return m
}

// FileDiff is git's unified diff of one changed file against HEAD, of the
// bytes the caller read and checked (f.Content and f.Mode, or f.Gone), never
// of the file as it is by then. For a rename, f.From is the old path.
func FileDiff(ctx context.Context, dir string, sh *Shadow, f File) (string, error) {
	r, err := info(ctx, dir)
	if err != nil {
		return "", err
	}
	sh.mu.Lock()
	defer sh.mu.Unlock()
	env, err := sh.prepare(r)
	if err != nil {
		return "", err
	}
	git := func(stdin string, args ...string) (string, error) {
		return runWith(ctx, r.top, env, stdin, args...)
	}
	zero := strings.Repeat("0", len(emptyTree[r.format]))
	var entries strings.Builder // `update-index -z --index-info` lines
	paths := []string{r.spec(f.Path)}
	if f.From != "" {
		paths = append(paths, r.spec(f.From))
		fmt.Fprintf(&entries, "0 %s\t%s\x00", zero, r.prefix+f.From)
	}
	if f.Gone {
		fmt.Fprintf(&entries, "0 %s\t%s\x00", zero, r.prefix+f.Path)
	} else {
		blob, err := git(f.Content, "hash-object", "-w", "--stdin", "--path="+r.prefix+f.Path)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&entries, "%s %s\t%s\x00", f.Mode, blob, r.prefix+f.Path)
	}
	if _, err := git(entries.String(), "update-index", "-z", "--index-info"); err != nil {
		return "", err
	}
	return runRaw(ctx, r.top, env, "", append([]string{"diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--find-renames", r.base(), "--"}, paths...)...)
}

// Blobs reads objects by id with one `git cat-file --batch`: their bytes,
// by id. An id the repository lacks, or "", is left out.
func Blobs(ctx context.Context, dir string, ids []string) (map[string]string, error) {
	blobs := map[string]string{}
	ids = slices.DeleteFunc(slices.Clone(ids), func(id string) bool { return id == "" })
	if len(ids) == 0 {
		return blobs, nil
	}
	out, err := runRaw(ctx, dir, nil, strings.Join(ids, "\n")+"\n", "cat-file", "--batch")
	if err != nil {
		return nil, err
	}
	for out != "" {
		line, rest, _ := strings.Cut(out, "\n")
		f := strings.Fields(line) // "<id> <type> <size>", or "<id> missing"
		if len(f) == 2 {
			out = rest
			continue
		}
		size := -1
		if len(f) == 3 {
			size, _ = strconv.Atoi(f[2])
		}
		if size < 0 || len(rest) < size+1 {
			return nil, fmt.Errorf("git cat-file said %q", line)
		}
		blobs[f[0]], out = rest[:size], rest[size+1:]
	}
	return blobs, nil
}

var hunkStart = regexp.MustCompile(`(?m)^@@ `)

// Hunks splits a unified diff of one file into its header and its `@@` hunks.
func Hunks(raw string) (header string, hunks []string) {
	locs := hunkStart.FindAllStringIndex(raw, -1)
	if len(locs) == 0 {
		return raw, nil
	}
	for i, l := range locs {
		end := len(raw)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		hunks = append(hunks, raw[l[0]:end])
	}
	return raw[:locs[0][0]], hunks
}

// ReverseHunk undoes hunk n of a file's diff (from FileDiff) in the worktree
// only, with `git apply --reverse`, whatever the user's apply.whitespace. The
// patch names the file's current path on both sides, taken from git's own
// `+++` line (so quoted as git quotes it): a rename's hunk then changes lines
// and never renames the file back.
func ReverseHunk(ctx context.Context, dir, raw string, n int) error {
	header, hunks := Hunks(raw)
	if n < 0 || n >= len(hunks) {
		return fmt.Errorf("no hunk %d", n)
	}
	var plus string
	for _, line := range strings.Split(header, "\n") {
		if strings.HasPrefix(line, "+++ ") {
			plus = line
		}
	}
	name := strings.TrimPrefix(plus, "+++ ")
	if !strings.HasPrefix(name, "b/") && !strings.HasPrefix(name, `"b/`) {
		return errors.New("this file has no lines to restore")
	}
	minus := "--- " + strings.Replace(name, "b/", "a/", 1)
	r, err := info(ctx, dir)
	if err != nil {
		return err
	}
	_, err = runWith(ctx, r.top, nil, minus+"\n"+plus+"\n"+hunks[n], "apply", "--reverse", "--whitespace=nowarn", "-")
	return err
}

// Restore puts paths back as HEAD has them, in the worktree only: the user's
// index isn't touched.
func Restore(ctx context.Context, dir string, rels ...string) error {
	r, err := info(ctx, dir)
	if err != nil {
		return err
	}
	args := []string{"restore", "--source=HEAD", "--worktree", "--"}
	for _, rel := range rels {
		args = append(args, r.spec(rel))
	}
	_, err = run(ctx, dir, args...)
	return err
}
