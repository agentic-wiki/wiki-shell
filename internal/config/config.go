// Package config reads the boards and graphs a bundle's wiki.toml declares.
//
// The standard defines `[[board]]` and `[[graph]]` for the apps that show
// them; `wiki` sets them aside and never reads inside them.
//
// Everything here is optional. A bundle with neither serves every
// view correctly: the reader needs no configuration, and a board infers its
// columns from the entries in the folder. Config exists for what inference gets
// wrong, not for what it gets right.
package config

import (
	"fmt"
	"sort"
	"strings"

	"github.com/agentic-wiki/wiki/bundle"
	"github.com/agentic-wiki/wiki/index"
)

// Board is one declared board.
//
// An array of tables rather than a flat list of paths, because every setting is
// per board: two backlogs in one bundle can legitimately use different status
// vocabularies, and `backlogs = [...]` cannot carry that.
//
//	[[board]]
//	path    = "/backlog"
//	where   = ["type=task"]                              # default; [] is every entry
//	status  = "status"                                   # default
//	columns = ["backlog", "todo", "in-progress", "done"] # default: inferred
//	lane    = "priority"                                 # default: no lanes
type Board struct {
	// Path is the folder the board is over. The only required key.
	Path string `toml:"path" json:"path"`
	// ID identifies the board, which the path cannot once two boards are over one
	// folder — everything and just bugs, or the same tasks grouped two ways. It
	// is what the URL carries: `/kanban/<id>/<entry path>`.
	//
	// Required, and never derived here. A derived id would have to come from the
	// path, and then the first segment of a board URL is sometimes an id and
	// sometimes a folder name — which is the ambiguity the id exists to remove.
	// Suggesting one from the board's name belongs to whatever creates boards,
	// where a person can see it and change it.
	//
	// A word, never a path. A slash would put it back in competition with the
	// folder names it sits among.
	ID string `toml:"id" json:"id"`
	// Name is what to call this board on screen. Optional: a folder already has
	// a readable name, so this is for when that one is wrong rather than
	// something every board has to carry.
	//
	// Filled in by whoever displays it, not here — naming a path readably is a
	// presentation rule with one home, and it is not this package's.
	Name string `toml:"name" json:"name,omitempty"`
	// Where filters which entries are cards, in the `--where` spelling. Nil
	// takes the default; empty is every entry under Path, which is why an empty
	// one is written out rather than left out (see `filter`).
	Where []string `toml:"where" json:"where,omitempty"`
	// Status is the frontmatter field the columns come from.
	Status string `toml:"status" json:"status"`
	// Columns pins the order and declares columns that are still empty, which
	// inference alone can never do. Never a filter: a status present in the
	// entries but missing here gets a column appended rather than dropped.
	Columns []string `toml:"columns" json:"columns,omitempty"`
	// Lane groups rows within the board. Empty means no lanes.
	Lane string `toml:"lane" json:"lane,omitempty"`
	// Lanes pins their order, the way Columns does for columns. Same rule: it
	// orders and adds, never filters.
	Lanes []string `toml:"lanes" json:"lanes,omitempty"`
	// Blockers is the frontmatter field naming what an entry is waiting on.
	//
	// Configurable rather than fixed because the format does not define it: it is
	// a workflow convention, and a bundle that says `waits_on` is not wrong. The
	// default is what the starter workflows write.
	Blockers string `toml:"blockers" json:"blockers,omitempty"`

	// Filters is Where, parsed. Built here so a consumer never re-implements the
	// query spelling: `index.ParseFilter` is the one that a CLI flag, a board
	// filter and a URL query all share.
	Filters []index.PropFilter `toml:"-" json:"-"`
}

// Graph is one declared graph: the entries under a folder, and the links
// between them.
//
//	[[graph]]
//	id         = "people"
//	path       = "/people"
//	where      = ["type=person"]  # default: none, every entry under path
//	neighbours = true             # default: false
type Graph struct {
	// Path and ID mean what they mean for a board, and are required for the
	// same reasons. Ids are a namespace of their own: `/graph/<id>` cannot be
	// mistaken for `/kanban/<id>`.
	Path string `toml:"path" json:"path"`
	ID   string `toml:"id" json:"id"`
	Name string `toml:"name" json:"name,omitempty"`
	// Where narrows the entries under Path. No default, unlike a board's: a
	// board assumes tasks, and a graph assumes nothing.
	Where []string `toml:"where" json:"where,omitempty"`
	// Neighbours also draws the entries one link away from the filtered ones.
	// Config rather than a view toggle because it changes which entries the
	// graph holds, which is what `where` is for too.
	Neighbours bool `toml:"neighbours" json:"neighbours,omitempty"`

	Filters []index.PropFilter `toml:"-" json:"-"`
}

type Config struct {
	Board []Board `json:"board,omitempty"`
	Graph []Graph `json:"graph,omitempty"`
}

// Defaults applied to a board that leaves a key out. A backlog is tasks with a
// `status`, which is what every starter workflow produces.
var (
	defaultWhere    = []string{"type=task"}
	defaultStatus   = "status"
	defaultBlockers = "blockers"
)

// RootID names the board every bundle has without configuring one.
const RootID = "root"

// Root is that board: the whole bundle, with every default.
//
// One built-in rather than "any folder boards by URL", so the first segment of
// a board address is always an id and never sometimes a folder name. A bundle
// with no config still has a kanban to open; a second one is something you
// declare, and declaring it is what gives it an id to be addressed by.
//
// A declared board may take this id, and then it is simply that board.
func Root() Board {
	return Defaults(Board{Path: "/", ID: RootID})
}

// Defaults fills in the keys a board may leave out.
//
// Exported because a caller sometimes needs to know what a board *would* hold
// before there is one to ask — declaring a board over a folder with no cards in
// it is a board that renders as an empty page, which is the hardest thing for
// whoever declared their first one to debug.
func Defaults(b Board) Board {
	if b.Status == "" {
		b.Status = defaultStatus
	}
	if b.Blockers == "" {
		b.Blockers = defaultBlockers
	}
	if b.Where == nil {
		b.Where = defaultWhere
	}
	b.Filters = nil
	for _, w := range b.Where {
		if f, err := index.ParseFilter(w); err == nil {
			b.Filters = append(b.Filters, f)
		}
	}
	return b
}

// Decode reads the `[[board]]` and `[[graph]]` tables and reports what is
// wrong with them.
//
// A problem is not an error. A board pointing at a folder somebody deleted, or
// a filter with a typo in it, must not stop the bundle being served — the
// reader does not need this config, and taking the server down over a view
// preference would be the wrong trade. The problems are reported and the rest
// of the config stands.
//
// Validation lives here rather than in `wiki check` because the standard keeps
// `wiki` passive: it never reads inside these tables, so the apps that show
// them are the ones that report on them.
func Decode(b *bundle.Bundle, idx *index.Index) (Config, []string) {
	var problems []string
	var cfg Config
	var looseBoards, looseGraphs []map[string]any
	if err := decode(b.DecodeBoards, &looseBoards, &cfg.Board); err != nil {
		problems = append(problems, err.Error())
		cfg.Board, looseBoards = nil, nil
	}
	if err := decode(b.DecodeGraphs, &looseGraphs, &cfg.Graph); err != nil {
		problems = append(problems, err.Error())
		cfg.Graph, looseGraphs = nil, nil
	}
	problems = append(problems, unknownKeys("board", looseBoards)...)
	problems = append(problems, unknownKeys("graph", looseGraphs)...)

	// The id identifies a board, so two claiming one is a config that cannot
	// mean what it says: the second is unreachable, and silently taking the
	// first would hide a declaration somebody wrote on purpose. Two boards over
	// the same *path* are fine now — that is what ids are for.
	seen := map[string]int{}

	for i := range cfg.Board {
		board := &cfg.Board[i]
		if board.Path == "" {
			problems = append(problems, fmt.Sprintf("board %d: path is required", i+1))
			continue
		}
		if board.ID == "" {
			problems = append(problems, fmt.Sprintf("board %d (%s): id is required", i+1, board.Path))
			continue
		}
		if !idPattern.MatchString(board.ID) {
			problems = append(problems, fmt.Sprintf("board %d: id %q %s", i+1, board.ID, notAWord))
		}
		if first, ok := seen[board.ID]; ok {
			problems = append(problems, fmt.Sprintf(
				"board %d: id %q is already board %d, so give them different ids", i+1, board.ID, first))
		} else {
			seen[board.ID] = i + 1
		}
		if board.Status == "" {
			board.Status = defaultStatus
		}
		if board.Blockers == "" {
			board.Blockers = defaultBlockers
		}
		if board.Where == nil {
			board.Where = defaultWhere
		}
		for _, w := range board.Where {
			f, err := index.ParseFilter(w)
			if err != nil {
				problems = append(problems, fmt.Sprintf("board %s: %v", board.Path, err))
				continue
			}
			board.Filters = append(board.Filters, f)
		}
		if idx == nil {
			continue
		}
		if !hasEntries(idx, board.Path) {
			problems = append(problems, fmt.Sprintf("board %s: no entries there", board.Path))
		}
		// A grouping is by one value, and a list has many. Reported rather than
		// rendered, because what it renders is every card in one nameless group —
		// which looks like the board is broken and says nothing about why.
		scope := idx.Filter(strings.TrimSuffix(board.Path, "/"), nil)
		for key, field := range map[string]string{"status": board.Status, "lane": board.Lane} {
			if field != "" && IsList(scope, field) {
				problems = append(problems, fmt.Sprintf(
					"board %s: %s %q holds a list, which is not something to group by", board.Path, key, field))
			}
		}
	}
	problems = append(problems, checkGraphs(cfg.Graph, idx)...)
	return cfg, problems
}

// checkGraphs validates graphs by the rules boards follow, and parses their
// filters in place. A problem is reported, and what can still be served is.
func checkGraphs(graphs []Graph, idx *index.Index) []string {
	var problems []string
	seen := map[string]int{}
	for i := range graphs {
		g := &graphs[i]
		if g.Path == "" {
			problems = append(problems, fmt.Sprintf("graph %d: path is required", i+1))
			continue
		}
		if g.ID == "" {
			problems = append(problems, fmt.Sprintf("graph %d (%s): id is required", i+1, g.Path))
			continue
		}
		if !idPattern.MatchString(g.ID) {
			problems = append(problems, fmt.Sprintf("graph %d: id %q %s", i+1, g.ID, notAWord))
		}
		if first, ok := seen[g.ID]; ok {
			problems = append(problems, fmt.Sprintf(
				"graph %d: id %q is already graph %d, so give them different ids", i+1, g.ID, first))
		} else {
			seen[g.ID] = i + 1
		}
		for _, w := range g.Where {
			f, err := index.ParseFilter(w)
			if err != nil {
				problems = append(problems, fmt.Sprintf("graph %s: %v", g.Path, err))
				continue
			}
			g.Filters = append(g.Filters, f)
		}
		if idx != nil && !hasEntries(idx, g.Path) {
			problems = append(problems, fmt.Sprintf("graph %s: no entries there", g.Path))
		}
	}
	return problems
}

// decode reads one kind of table twice: loosely, to see the keys actually
// written, then into its shape. The loose pass is the only way to catch a
// misspelled key, which otherwise decodes into nothing and is silently
// ignored.
func decode(read func(v any) (bool, error), loose *[]map[string]any, typed any) error {
	if _, err := read(loose); err != nil {
		return err
	}
	_, err := read(typed)
	return err
}

// notAWord says what an id must look like, the standard's pattern (idPattern).
const notAWord = "is not a word: use lowercase letters, digits, _ and -, starting with a letter or a digit"

// IsList reports whether a frontmatter key holds a list anywhere in scope.
//
// Anywhere rather than everywhere: one entry with `tags: [ui, api]` is enough to
// make grouping by `tags` undefined, whatever the others do.
func IsList(entries []*index.Entry, key string) bool {
	for _, e := range entries {
		if _, ok := e.Frontmatter()[key].([]string); ok {
			return true
		}
	}
	return false
}

// known keys, so a misspelling is reported rather than ignored.
var (
	boardKeys = map[string]bool{
		"path": true, "id": true, "name": true, "where": true, "status": true, "columns": true,
		"lane": true, "lanes": true, "blockers": true,
	}
	graphKeys = map[string]bool{"path": true, "id": true, "name": true, "where": true, "neighbours": true}
	tableKeys = map[string]map[string]bool{"board": boardKeys, "graph": graphKeys}
)

func unknownKeys(kind string, tables []map[string]any) []string {
	var out []string
	for i, table := range tables {
		for k := range table {
			if !tableKeys[kind][k] {
				out = append(out, fmt.Sprintf("unknown key in %s %d: %s", kind, i+1, k))
			}
		}
	}
	// Map iteration order is not something a startup message should vary by.
	sort.Strings(out)
	return out
}

// hasEntries reports whether anything in the index lives at or under path.
//
// A folder is not a thing the index holds — it holds entries — so "the folder
// exists" is really "something is in it", which is also the only version a
// board cares about.
func hasEntries(idx *index.Index, path string) bool {
	if path == "/" {
		return len(idx.Entries) > 0
	}
	prefix := strings.TrimSuffix(path, "/") + "/"
	for _, e := range idx.Entries {
		if e.Path == path || strings.HasPrefix(e.Path, prefix) {
			return true
		}
	}
	return false
}
