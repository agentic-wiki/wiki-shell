package config

import (
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/agentic-wiki/wiki/bundle"
)

// oldTool is the key WikiShell read its boards and graphs from, under
// `[tool]`, before the standard defined `[[board]]` and `[[graph]]`. Migrate
// moves them; the migration is removed in the first release on or after
// 2027-01-01.
const oldTool = "wikiview"

var (
	// oldView matches an old view header on a line of its own,
	// `[[tool.wikiview.board]]` or `[[tool.wikiview.graph]]`, keeping its
	// indentation and whatever follows it (a comment, a carriage return).
	oldView = regexp.MustCompile(`(?m)^([ \t]*)\[\[[ \t]*tool\.wikiview\.(board|graph)[ \t]*\]\](.*)$`)
	// oldTable matches the bare `[tool.wikiview]` header.
	oldTable = regexp.MustCompile(`^[ \t]*\[[ \t]*tool\.wikiview[ \t]*\][ \t]*(#.*)?\r?$`)
)

// Migrate renames the old view tables in the bundle's wiki.toml to the
// standard's, in place, and reports whether it changed the file.
//
// `[[tool.wikiview.board]]` becomes `[[board]]` and `[[tool.wikiview.graph]]`
// becomes `[[graph]]`, and a bare `[tool.wikiview]` left with nothing in it
// goes. Every other byte stays. A file that already has `[[board]]` tables is
// rewritten too: arrays of tables join, in file order, and two boards with one
// id are reported like any other. A second run finds nothing to change.
//
// Run before the config is read, at start and on each change of it, so a
// table an older app writes back is renamed again.
//
// Known limit: the rewrite does not parse TOML, so a line inside a multi-line
// string that looks like an old header is renamed too. Accepted: such a line
// is very unlikely, and parsing is what would lose the file's comments and
// formatting. Tracked with the migration's removal in the repo's backlog.
func Migrate(dir string) (bool, error) {
	writing.Lock()
	defer writing.Unlock()
	path := filepath.Join(dir, "wiki.toml")
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	renamed := renameViews(string(raw))
	if renamed == string(raw) {
		return false, nil
	}
	return true, replace(path, renamed)
}

// renameViews is Migrate's rewrite, line by line, so it can promise to touch
// nothing else.
func renameViews(raw string) string {
	lines := strings.Split(oldView.ReplaceAllString(raw, "${1}[[${2}]]${3}"), "\n")
	out := make([]string, 0, len(lines))
	for i, line := range lines {
		if oldTable.MatchString(line) && emptyTable(lines[i+1:]) {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// emptyTable says whether a table's body holds no key: only blank lines and
// comments up to the next header or the end of the file.
func emptyTable(body []string) bool {
	for _, line := range body {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			return true
		}
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			return false
		}
	}
	return true
}

// LeftBehind names what Migrate could not move, or says "" when nothing is
// left: keys in the old table itself, dotted keys, inline arrays. They are no
// longer read, so they are named rather than silently dropped. Asked after a
// Migrate that succeeded: after a failed one, the failure is the news.
func LeftBehind(b *bundle.Bundle) string {
	var left map[string]any
	if found, err := b.DecodeTool(oldTool, &left); !found || err != nil || len(left) == 0 {
		return ""
	}
	keys := slices.Sorted(maps.Keys(left))
	return fmt.Sprintf("[tool.%s] is no longer read, and still holds: %s", oldTool, strings.Join(keys, ", "))
}
