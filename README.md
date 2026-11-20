# WikiShell

[![Release](https://img.shields.io/github/v/release/agentic-wiki/wiki-shell?sort=semver)](https://github.com/agentic-wiki/wiki-shell/releases)
[![Homebrew](https://img.shields.io/badge/brew-agentic--wiki%2Ftap%2Fwikishell-FBB040?logo=homebrew&logoColor=white)](https://github.com/agentic-wiki/homebrew-tap)
[![CI](https://github.com/agentic-wiki/wiki-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/agentic-wiki/wiki-shell/actions/workflows/ci.yml)

> A web UI for [agentic-wiki](https://github.com/agentic-wiki/wiki) bundles.

A wiki bundle is a folder of Markdown that an agent maintains and the `wiki` CLI queries like a database. WikiShell is the screen for it: point it at the folder, read it in a browser, follow the links, tick the checkboxes, and see the same entries as boards and graphs.

![A board of tasks, one of them open in the side panel](img/2-kanban.png)

One binary with the frontend built into it. Your files stay ordinary Markdown.

```sh
brew install agentic-wiki/tap/wikishell
cd my-kb && wikishell      # Open http://localhost:8080
```

## Install

Homebrew, on macOS or Linux:

```sh
brew install agentic-wiki/tap/wikishell
```

Or grab a binary directly:

```sh
# macOS
curl -L https://github.com/agentic-wiki/wiki-shell/releases/latest/download/wikishell_darwin_arm64.tar.gz | tar xz
sudo mv wikishell /usr/local/bin/

# Linux or WSL (amd64)
curl -L https://github.com/agentic-wiki/wiki-shell/releases/latest/download/wikishell_linux_amd64.tar.gz | tar xz
sudo mv wikishell /usr/local/bin/
```

Other platforms (linux/arm64 for a Raspberry Pi, darwin/amd64, windows/amd64, windows/arm64) are on the [releases page](https://github.com/agentic-wiki/wiki-shell/releases).

> [!WARNING]
> **Do not use `go install`.** It produces a binary without the UI in it. The
> frontend is built rather than committed. Use Homebrew or a release binary above, or build from
> source below.

From source, with [bun](https://bun.sh) and a Go toolchain:

```sh
git clone https://github.com/agentic-wiki/wiki-shell && cd wiki-shell
just build          # builds the frontend, then embeds it in the binary
./bin/wikishell ../backlog
```

## Running it

```sh
wikishell [path] [flags]
```

The path defaults to the working directory and walks up looking for `wiki.toml`, so running it inside a bundle needs no arguments. Flags may come before or after the path.

| Flag | Default | |
| --- | --- | --- |
| `--host` | `localhost` | interface to listen on; any non-loopback address (`0.0.0.0` for all) turns the token on |
| `--port` | `8080` | port to listen on |
| `--edit` | | on a network address, let anyone with the link edit pages, commit and push as you; it means nothing on localhost, where editing is always on |
| `--version` | | print the version and exit |

```sh
wikishell my-kb --port 3000
```

**On localhost, open the address it prints.** Nothing else is needed, and a bookmark keeps working. Behind the scenes, every `/api` call carries an `X-Wikishell-Token` header with any value. A web page on another site cannot add that header, so it cannot write to your wiki through localhost. On a shared machine, every user of it can open your wiki.

**On a network address, open the link it prints.** With `--host 0.0.0.0` or another non-loopback address, WikiShell creates a token at every start and prints it in the link: `http://<this machine>:8080/#t=…`. With `0.0.0.0`, the link names the machine by its hostname. If another machine cannot resolve that name, use this machine's IP in its place. Open the link once: the app keeps the token for that tab and takes it out of the address bar. A tab without it says what to do and shows no entry. The token lasts until the process exits, and a restart prints a new one.

There is no TLS, so the token and every page cross the network in clear text. Use a network address only on a network you trust.

**On a network address, the wiki is read-only unless you start with `--edit`.** Without it, every change (a page, a field, a board, a git action) is refused with `403`, and the app shows the wiki read-only; only Refresh still works, since it just re-reads the files. With `--edit`, everyone holding the link can rewrite every page, commit and push as you, and your agents read those pages, so use it only with people you trust.

## A quick tour

<table>
  <tr>
    <td width="50%"><img src="img/1-main.png" alt="The reader: the folder tree, an entry, and its heading map"></td>
    <td width="50%"><img src="img/2-kanban.png" alt="A board of tasks, one of them open in the side panel"></td>
  </tr>
  <tr>
    <td><b>Read.</b> The folder as a tree and each entry as a page, with a heading map in the margin and a dot on what changed since you last looked.</td>
    <td><b>Board.</b> Any folder's entries as columns and lanes, from their frontmatter. Drag a card and its file changes; open one and it reads beside the board.</td>
  </tr>
  <tr>
    <td><img src="img/3-multiple-kanbans.png" alt="A board with lanes, and the form that adds another"></td>
    <td><img src="img/4-graph.png" alt="A graph of tasks, coloured by folder, with the groups legend open"></td>
  </tr>
  <tr>
    <td><b>Many views, one folder.</b> Boards and graphs are declared in <code>wiki.toml</code>, and a form writes that for you.</td>
    <td><b>Graph.</b> Entries as nodes and their links as edges, coloured by folder. Hide a group, or show only one.</td>
  </tr>
  <tr>
    <td><img src="img/5-subgraph.png" alt="Pointing at a node lights its links and shows which way they go"></td>
    <td><img src="img/7-read-later-and-git.png" alt="The read later list, with the source control popover open over it"></td>
  </tr>
  <tr>
    <td><b>Follow a thread.</b> Point at a node and its links light, with arrows for which way they go.</td>
    <td><b>Read later.</b> A queue of entries to come back to, in your own order.<br><b>Git.</b> The branch pill says what changed; pull and push from its popover, and review and commit in the changes view.</td>
  </tr>
</table>

## What you get

Browse the folder tree, follow links between entries, jump to headings. A folder opens its `index.md`, or gets a listing if it has none.

Tick a checkbox and it edits the file: one character, written atomically through the engine's write API. Moving a card writes its status (and its lane, when that changes) the same way, and the board and graph settings write their table in `wiki.toml`. Nothing else is written: prose is never edited.

The screen keeps up with the files. An agent or an editor working on the same folder shows up within a second. Entries that changed since you last opened them get a dot in the tree, so you notice the ones you were not watching.

Images display inline. A link to a contract or a spreadsheet sitting beside the notes about it opens in a new tab.

Callouts are set apart rather than shown as syntax: `> [!warning]`, `> [!success] Shipped`, and any other marker word, in GitHub's spelling or Obsidian's. A word with no colour of its own is still labelled with itself.

Light, dark and system themes, and a reading column you can widen for a big screen. Both are yours rather than the bundle's, and both are applied before the first paint.

Boards are built: columns, lanes, drag by both at once, and a card sheet. So are graphs: the entries of a folder you declare as nodes, the links between them as edges, the way Obsidian draws them. On either, ⌘F (Ctrl+F) goes to the view's own search box, filtering cards or highlighting nodes; press it again there for the browser's find. Escape there clears it. Git is there too: fetch, pull and push, each showing what it will do before it does it, and a failed pull undoing itself and offering your work as a named branch.

Every page is editable where you read it: click and type, as in Notion, with `/` for blocks and Markdown shortcuts. Each change is saved to the file as you go, block by block, so every byte you didn't touch stays as it was, and nothing is committed until you say so. The changes view (`/changes`, or "Review changes" in the palette) shows every uncommitted change, yours or an agent's, as a rendered diff with the raw lines a click away; there you discard a change, a field or a file, and commit the files you tick, each as you saw it. An agent writing the same file meanwhile is taken in live; the block you are typing in is never overwritten, and where you both changed one, you choose. On an address other than localhost, editing needs `--edit`. Dataset tables are not built yet. The plan lives in [`backlog/`](backlog/index.md), which is itself a bundle you can serve.

## Configuration

Optional, and it lives in the bundle's own `wiki.toml` as `[[board]]` and `[[graph]]` tables, alongside whatever else that file already holds. The agentic-wiki standard defines both, so every app that shows boards (Foreman too) reads the same tables, and `wiki` itself never reads inside them. There is no second config file and nothing to create: a bundle with none of this serves every view.

**From an older wiki.** WikiShell up to v0.18.0 read `[tool.wikiview]`. When WikiShell opens a wiki, and whenever its `wiki.toml` changes, it renames `[[tool.wikiview.board]]` to `[[board]]` and `[[tool.wikiview.graph]]` to `[[graph]]` in place, and removes a `[tool.wikiview]` table left empty. Nothing else in the file changes, and it prints one line when it does this. Anything it can't move, such as a key in `[tool.wikiview]` itself, is no longer read, and the startup check names it.

What it configures is boards and [graphs](#graphs). Every bundle already has one board — `/kanban/root`, the whole bundle — so this is for the others:

```toml
[[board]]
id   = "backlog"
path = "/backlog"
```

That is a whole board, reachable at `/kanban/backlog`. You do not have to type it: **New board** in the Boards panel opens a dialog where you pick the folder, the name and which entries become cards, and it writes this table for you.

The id is what the URL carries and what tells two boards apart; every other key has a default, and writing them out is only worth it when one is wrong:

```toml
[[board]]
id       = "backlog"
path     = "/backlog"
name     = "Backlog"       # default: the folder, made readable
where    = ["type=task"]   # default; [] is every entry under path
status   = "status"        # default: the frontmatter field the columns come from
columns  = []              # default: column keys inferred from the entries
lane     = ""              # default: no lanes, which is to say one
lanes    = []              # default: the order described below
blockers = "blockers"      # default: the field naming what an entry waits on
```

An array of tables rather than a list of paths, because every board has its own settings — and because **two boards can be over one folder**, which is the reason ids exist. Everything and just bugs, or the same tasks grouped by `priority` beside the same tasks grouped by `area`:

```toml
[[board]]
id    = "bugs"
path  = "/backlog"
where = ["type=task", "kind=bug"]
```

`where` follows the same spelling as `wiki list --where status!=done`. A board holds tasks by default, but any filter works: `where = ["type=idea"]` is a board of ideas, and `where = []` is every entry under `path`. That last one is not the same as leaving `where` out, which brings back the `type=task` default.

An id is a word, never a path: lowercase letters, digits, `_` and `-`, starting with a letter or a digit. One written any other way is reported at startup, and its board is still shown. It is the first segment of a board's address, and everything after it is an entry, so `/kanban/backlog/3-reader/006-x.md` opens that card on that board. Ids are declared rather than derived, because a derived one would come from the path and then that first segment would sometimes be an id and sometimes a folder name.

**Order comes from the vocabulary first, and from you when you say so.** `status` and `priority` read the way they mean without being configured: `todo, in-progress, done` rather than alphabetical, and `high, medium, low` rather than `high, low, medium`. `severity` and `size` too. A field WikiShell does not recognise falls back to alphabetical, and `columns` or `lanes` replaces the order outright for any field at all. A value nothing in the table mentions still appears, after the ones that do.

**`columns` orders and adds. It never hides.** A status present in your entries but missing from the list still gets a column, appended after the ones you named. Declaring `["todo", "in-progress", "done"]` pins that order and shows `in-progress` while it is still empty, which is the thing inference cannot do for you — but a card whose status you forgot to list appears anyway rather than vanishing off a board while sitting in the folder. Hiding cards is `where`'s job, where it is explicit.

### Graphs

A graph draws a folder's entries and the links between them, reachable at `/graph/<id>`. Unlike boards, none is built in: every graph is declared. **New graph** in the Graphs panel declares one for you, through the same dialog boards use, and a graph's Settings change its name, filter and neighbours without opening this file.

```toml
[[graph]]
id         = "people"
path       = "/people"
where      = ["type=person"]  # default: none, every entry under path
neighbours = false            # default
```

`id` and `path` work as they do for a board, but graph ids are their own namespace, so a board and a graph can both be called `people`. `where` has no default: without it, the graph is every entry under `path`.

An edge is any link from one entry on the graph to another: a link in the body, or a frontmatter value naming one (`manager: ./ana.md`, `blockers: [...]`). Several links between the same two entries are one edge, and two entries linking each other are one line. Self-links, links to entries nobody has written, and links to images and other files are not edges. An entry with no edges is still drawn, as a dot on its own.

`neighbours = true` also draws the entries one link away from those, in either direction, even though they fail the filter. They are hollow, since they are context rather than what the graph is about, and no edge is drawn between two of them. A folder's `index.md` is drawn as a solid ring in its group's colour and named after its folder, and its name shows whenever labels are on, not only when it is a hub. A neighbour that is an index stays hollow. A folder's `log.md` is named the same way, as "Folder (log)", and shown under the same rule, but drawn as an ordinary dot.

Drag a node and its neighbours follow; point at one to light up what it touches, with arrowheads saying which way each of its links points; click it to open the entry over the graph. Pan by dragging the background. The wheel zooms by spreading nodes apart: dots and labels stay the same size, so zooming in makes room to read. How big they are is a separate Small, Medium or Large control in the header. Long titles are shortened, and shown whole on the node you point at. The text size is remembered in your browser. So is **Highlight follows preview**, in a graph's Settings and off by default: when it is on, the node open beside the graph keeps the highlight hovering gives it until you close it. It is the one setting there that is not written to `wiki.toml`. Past 500 nodes the graph suggests narrowing `where`, and still draws every node.

## HTTP API

Useful for scripting against a running server. One rule: every `/api` request carries `X-Wikishell-Token`. If the server has a token (network bind), the value must equal it. So on localhost any value works, and on a network address you copy the token from the printed link (the fragment is never sent to the server, so the link itself cannot be used here). On a network address, `/raw` needs the `wikishell_raw_<port>` cookie that every accepted `/api` response sets; the browser does this for you.

```sh
curl -H "X-Wikishell-Token: local" http://localhost:8080/api/bundle
```

```
GET  /api/bundle              the bundle itself: dir, spec, entry count, [tool.*] tables, version, declared boards and graphs, every tag in first-appearance order, the types wiki.toml declares, and whether it takes edits
GET  /api/tree                the folder tree, each folder's entries and its index.md if it has one,
                              with when each last changed and how many entries it is
                              linked with, either way (its degree on a graph)
GET  /api/entry/{path...}     one entry: body, frontmatter, checkboxes, and resolved-link
                              and heading-id tables, when it last changed (its
                              `timestamp`, else the file's mtime, as `wiki` sorts),
                              and its version and blocks, for an edit
GET  /api/blocks/{path...}    what changed since ?since=<version>, by block, or the
                              whole block list for a version no longer kept
GET  /api/board/{id}          one board as columns of cards, in the config's order,
                              with the frontmatter keys its folder uses and the
                              entries under it whose frontmatter couldn't be read
GET  /api/graph/{id}          one graph as nodes and edges, each edge saying which
                              way it points and whether it came from the body or a field
GET  /api/git                 the bundle's repository: branch, upstream, ahead/behind,
                              the commits a pull would take (up to 50, as of the
                              last fetch), and everything a commit would carry
GET  /api/changes             every uncommitted change in the bundle, with its version,
                              and its `mode` when its git mode changed
GET  /api/changes/{path...}   one changed file's diff: by block and field for a page,
                              by line otherwise, and its numbered hunks
GET  /api/table/{path...}     a page's one table as a file, ?format=csv or json: the
                              bytes `wiki table --format` prints, as an attachment
GET  /api/events              server-sent events carrying the current version
GET  /raw/{path...}           a file as it is on disk, frontmatter and all
PUT  /api/blocks/{path...}    save a page's changed blocks, merged with what changed on disk
PUT  /api/fields/{path...}    set frontmatter fields, each guarded by the value you read
GET  /api/entries/new         draft a new page: its path and first content, from in, type and title
POST /api/entries             create a page, never over a file
PUT  /api/card/{id}/{path...} move a card to another column and lane, guarded by the version you read
POST /api/board               declare a board, appending it to the bundle's wiki.toml
PUT  /api/board/{id}          change a board's settings in place
POST /api/graph               declare a graph, the same way
PUT  /api/graph/{id}          change a graph's settings in place
POST /api/refresh             re-read the files
POST /api/git/fetch           ask the remote what it has
POST /api/git/pull            rebase onto the upstream, undoing the attempt if it fails
POST /api/changes/discard     put a file, or one hunk of it, back as HEAD has it
POST /api/commit              commit the files you saw, each at the version you saw
POST /api/git/push            push the branch
POST /api/git/branch          push the current work to a new branch
```

A page is written block by block, through `wiki`'s guarded write (`Entry.ApplyBlocks`). `PUT /api/blocks` takes `{"base": "<version>", "baseBlocks": ["<hash>", …], "ops": […]}`: the version and block hashes you read from `/api/entry`, and the changes as `replace`, `insert` and `delete` operations anchored by a block's index and hash. What changed on disk meanwhile is merged three ways, so an agent's edit to another block is kept; a block both changed comes back as a conflict, with the disk's text, and the rest is written (`200`). An invalid save is refused with `422` and writes nothing; a request that isn't valid JSON, or a body over 2 MiB, gets `400`. Ticking a checkbox is a `replace` of its item. `PUT /api/fields` takes `{"set": {…}, "old": {…}, "unset": […]}` and writes each key that still holds its `old` value. It refuses with `422` a `type` that `wiki.toml`'s declared `types` don't hold, and a key wiki can't write back as itself. `GET /api/entries/new?in=/spec&type=spec&title=Settlement rules` drafts a page without writing it: `{"path": "/spec/settlement-rules.md", "content": "---\ntype: spec\ntitle: Settlement rules\ntags: []\n---\n"}`, the file named from the title (`wiki`'s `parse.FileSlug`), in the folder given or, `in` an entry `/spec/thing.md`, in `/spec/thing/`. It is `409` where a file is (`{"error": "There is already an entry at /x.md.", "path": "/x.md"}`, as `POST /api/entries` answers too), and `422` for a title with no letter or digit, a type `wiki.toml` doesn't declare, a reserved name (`index`, `log`), or a folder outside the wiki, on a dot path or left out by `wiki.toml`'s `ignore` (the same check, `wiki`'s `Index.CheckNewEntry`, that `POST /api/entries` makes). `POST /api/entries` takes `{"path": "/notes/x.md", "content": "…"}` and answers `201`, or `409` where a file is. Posting a draft unchanged creates it. The server keeps each page's last 8 block lists (over the 64 pages most recently served) to answer `/api/blocks?since=` with only what changed. Both block reads say whether the page is `editable`: not on a read-only network bind, and not for a page over 20,000 blocks, which opens read-only, without its blocks.

The changes view reads git without touching your index or object store: it diffs a shadow index against HEAD, with the objects it hashes in a private folder under your cache folder (`wikishell/shadow-*`, mode 0700, deleted when the server stops, and at the next start if the server was killed; with no cache folder, as when `HOME` is unset, the changes view answers with that reason instead of using a shared folder such as `/tmp`). So a new file shows up, and a deleted file plus a new one shows as a rename, while `git status` in a terminal reads as before. A file whose name or folder starts with a dot is listed by name only (`kind: dot`), never read, diffed or committed here, and isn't listed at all on a network address. A file over 2 MiB is listed with its `size`, without a diff, and read as a stream, never whole. A file with a `filter` attribute (git-lfs) is listed without a diff too, so its clean filter doesn't run each time the list is read. A symlink (`kind: link`) is its target text, never followed. A file whose git mode changed carries `mode: {from, to}`: an execute bit set or cleared, or a file that became a symlink (`120000`) or stopped being one. A new file has no `from`, and shows only a mode other than `100644`. `POST /api/changes/discard` takes `{"path": "/notes/a.md", "version": "…", "hunk": 2}` (no `hunk` for the whole file): `hunk` is an index into the diff's `hunks`, and a `version` that moved gets `409` with nothing discarded. A page's diff has `header: true` when its header's bytes differ from HEAD's, a key moved say, even where no field's value changed. A page is any `.md` file, indexed yet or not. Its hunk is undone with the same block merge as an edit, worked out from the bytes you were shown and written only if the file still has them (`wiki`'s `Index.WriteIf`): all or nothing. A field comes back as HEAD's own lines for it, so any value returns exactly. `POST /api/commit` takes `{"message": "…", "files": [{"path": "…", "version": "…"}]}` and only commits; pushing is `POST /api/git/push`. It commits the bytes it checked against each version, never the worktree at commit time, through a temporary index, so whatever else you staged stays staged. A file that changed since is listed under `refused`, and the rest is committed. Your `pre-commit` and `commit-msg` hooks run (this needs git 2.36 or later), and signing follows `commit.gpgsign`. Each file gets the mode `git add` would give it: with `core.fileMode` on, its execute bit; with it off, the mode it had. A commit whose files are all as HEAD has them is `422`. If the branch moved meanwhile, it's `409` and nothing is committed.

A refetch of the list reuses what it can, so hundreds of changed pages stay cheap: a page's counts while its bytes and HEAD's are the same, and a large file's version while its size, time and mode are. A discard or a commit always reads the file again.

A card or board write carries the bundle `version` it was read at, and one that has moved is refused with `409` and the current version. `/api/card` takes the values a drop landed on, `{"value": "done", "lane": "high", "version": 7}`, and the board decides which frontmatter keys those stand for. Both are written in one pass, and an empty `lane` leaves that field alone rather than clearing it.

`POST /api/board` takes `{"id": "bugs", "path": "/backlog", "name": "Bugs", "where": ["type=task"]}` and appends a `[[board]]` table, leaving the rest of the file alone. Leave `where` out to get the default; send `[]` for every entry under the path. The dialog gets its starting filter and the folder's keys from `GET /api/draft/{board|graph}/{folder}`, so the default is defined once, on the server. It refuses an id that is not a word, one already declared, a filter that does not parse, and a path that is not a folder in the bundle. A folder with no tasks in it yet is fine: the board starts empty and says what will fill it.

`PUT /api/board/{id}` takes `name`, `where`, `status`, `columns`, `lane`, `lanes` and `blockers` together and rewrites those lines in that board's table. A setting sent empty is a key removed, except `where`: an empty one is written as `where = []`, because leaving the key out would bring the default back. `id` and `path` are not settings: they are what the board is, and changing an id breaks every link to it.

`POST /api/graph` and `PUT /api/graph/{id}` do the same for graphs. A graph's settings are `name`, `where` and `neighbours`, and a graph's id is checked only against other graphs. A graph is refused by the same rule, a path that is not a folder; an empty folder is fine. All of these writes edit `wiki.toml` line by line and never reserialize it, so comments, other tools' tables and your formatting survive; a value written across several lines is reported rather than edited around.

`/raw` serves what the index refers to, not what the directory contains: every entry, plus every non-entry an entry links to. Of those, it serves only what a page can display (images, PDFs, audio and video) and text; another binary, such as a database or an archive, is not served even when a page links to it. A path with a part that starts with a dot (`.env`, `.git/config`, `.ssh/…`) is never served, and neither is a file a symlink leads to that is a dot path or outside the bundle. `/api/entry` follows the same rule, so an entry named `.draft.md` or a symlink to `.env` does not open, and a page's link to a dot path gets no `/raw` address.

It is also the only way to get an entry's exact bytes. `/api/entry` returns the body with frontmatter stripped and the frontmatter parsed, and you cannot reassemble the original file from those.

Frontmatter is read by the `wiki` library, so each value is what `wiki` shows: the text as YAML reads it (`'company''s'` is `company's`), and a list or map inside a value as one line of YAML (`{path: a.pdf, pages: 40}`). A page whose frontmatter isn't valid YAML, or is over one of `wiki`'s limits, has no fields. Its page says why (`frontmatterError` on `/api/entry` and on its tree entry), and a board lists it under `unread` rather than dropping it, since no column can hold it. A card move onto a header `wiki` can't edit safely is refused with `422` and the reason, and the file is left as it was.

## Relationship to `wiki`

`wiki` is the engine and stays one: a static binary with a single dependency, a neutral index over a folder. WikiShell imports its packages rather than shelling out to the CLI, so a rule like link resolution has exactly one implementation and it lives in the engine.

Install `wiki` too for the terminal side of the same folder: querying, refactoring, `check`, and the skills an agent drives it with.

## Development

```sh
just serve      # build the frontend and serve this repo's own backlog
just check      # vet, lint and tests, Go and UI
just test-all   # unit, UI, and end-to-end
just ui-dev     # the Vite dev server, proxying /api to a running WikiShell
```
