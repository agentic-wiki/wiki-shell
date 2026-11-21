// The server's shape, mirrored. Every field here has a counterpart in
// internal/server; if one drifts the other should be changed with it.

import { clearToken, token } from "@/token";

export interface BundleInfo {
  /** Scopes anything this browser remembers, so preferences never leak between
   *  bundles. Computed by the server: identity has one definition. */
  id: string;
  /** The bundle's folder made readable, named by the rule that names entries. */
  label: string;
  dir: string;
  spec: string;
  entries: number;
  tools: string[];
  version: number;
  /** Boards declared in `[[board]]`, with their defaults filled in.
   *  Absent when the bundle declares none, which is the common case. */
  boards?: (BoardConfig & { /** Every card on it. */ cards: number })[];
  /** Graphs declared in `[[graph]]`. There is no built-in one, so absent
   *  means none. */
  graphs?: (GraphConfig & { /** The entries it is over, neighbours not counted. */ entries: number })[];
  /** Every tag in the bundle, first appearance first. A tag's colour is its
   *  position here (`colour.ts`), so the order is the contract. */
  tags: string[];
  /** Whether this server takes writes: always on loopback, and on a network
   *  address only when it was started with `--edit`. */
  editable: boolean;
  /** The types wiki.toml declares, in its order, for the editor's type field
   *  to offer. Empty when types are free-form. */
  types: string[];
}

/**
 * A link as written, alongside where it resolves to.
 *
 * `raw` is the lookup key: it is the href exactly as the markdown renderer will
 * encounter it. Resolving a link means finding it in this table, never doing
 * path arithmetic against the bundle root — that is the engine's rule, and
 * redoing it here is how the previous attempt ended up with three copies of it.
 */
export interface Link {
  raw: string;
  to: string;
  anchor: string;
  text: string;
  line: number;
  /** False when the target names no entry. Not an error: it may be unwritten. */
  exists: boolean;
  /** Where to fetch a target that is not an entry, absent when there is none. */
  asset?: string;
  /**
   * True when the link resolves above the bundle root. `to` is empty for these.
   *
   * Reported so the client never has to guess what an unknown href means. Left
   * as a plain anchor, the browser resolves the relative path against the
   * current route and a click becomes a full page load into an address the app
   * does not serve.
   */
  outside: boolean;
}

/**
 * A link pointing at this entry.
 *
 * `title` is the *linking* entry's own title — which entry mentions this one.
 * `text` is the words it used, which is a different thing: a link is usually
 * labelled with its target's name, so showing the text alone reads as this
 * page's own name.
 */
export interface Backlink {
  from: string;
  title: string;
  text: string;
  line: number;
}

/**
 * Positions arrive in two coordinate systems, and using the wrong one fails
 * silently: `line` counts from the top of the *file* including frontmatter and
 * is what a write is addressed by; `bodyLine` counts within `body` as served,
 * which is what a renderer of that body can match against.
 */
interface Positioned {
  line: number;
  bodyLine: number;
}

/** Ids come from the server because every markdown library slugs differently. */
export interface Heading extends Positioned {
  level: number;
  text: string;
  id: string;
}

export interface Checkbox extends Positioned {
  done: boolean;
  text: string;
}

/**
 * A frontmatter value that names an entry in this bundle.
 *
 * Which fields these are is not fixed: `blockers` and `epic` are conventions, and
 * any field whose value resolves is one. The client looks a value up here rather
 * than deciding for itself what looks like a path.
 */
export interface Ref {
  key: string;
  value: string;
  to: string;
  /** The target's filename made readable, the same name the tree gives it. */
  label: string;
}

export interface Entry {
  path: string;
  /** The entry's title, or a readable name from its filename. Always present. */
  title: string;
  type: string;
  frontmatter: Record<string, unknown>;
  /** Why the header couldn't be read, as the wiki library says it; absent when
   *  it reads. An unreadable header gives no fields, but the body still shows. */
  frontmatterError?: string;
  /** The markdown as written. The only representation of the content. */
  body: string;
  links: Link[];
  frontmatterRefs: Ref[];
  backlinks: Backlink[];
  headings: Heading[];
  checkboxes: Checkbox[];
  /** When it last changed, RFC 3339, by the engine's rule (a `timestamp`,
   *  else the file's mtime). Absent when it has neither. */
  updated?: string;
  /** The page version: a hash of the whole file. Every body write is made
   *  against one, so the server can tell what changed meanwhile. */
  version: string;
  /** The body as blocks, in order (editor-adr.md, "The block model"). Empty for
   *  a page too big to edit (over 20,000 blocks). */
  blocks: Block[];
  /** Whether this page takes writes: the bind allows them, and it isn't too big. */
  editable: boolean;
}

/** A block of a page's body: a paragraph, a heading, a list item, a table row… */
export interface Block {
  kind: "paragraph" | "heading" | "code" | "rule" | "quote" | "html" | "item" | "table-head" | "row";
  text: string;
  /** The block's version: a hash of its text. */
  hash: string;
}

/**
 * A change to a page's blocks, anchored to a block of a known version by its
 * index and hash. Sent with `text`; the server sends `blocks`, already split,
 * and also reports moves.
 */
export type Op =
  | { op: "replace"; at: number; hash: string; text?: string; blocks?: Block[] }
  | { op: "insert"; after: number; hash: string; text?: string; blocks?: Block[] }
  | { op: "delete"; at: number; hash: string }
  | { op: "move"; at: number; hash: string; after: number };

/** An operation the server didn't apply, because the disk changed that block too. */
export interface Conflict {
  /** The block's index in the base version. */
  at: number;
  case: "both-changed" | "deleted-outside" | "changed-outside";
  /** The disk's blocks in its place: empty when they were deleted. */
  theirs: Block[];
  /** Other base blocks a join on disk took in. */
  also?: number[];
}

/** What `PUT /api/blocks` answers: the operations from the base to the new
 *  version, and what wasn't applied. */
export interface Saved {
  version: string;
  ops: Op[];
  conflicts: Conflict[];
  /** No block of the base was left on disk, so nothing was applied. */
  rewritten: boolean;
}

/** What changed since a version: operations, or the whole list when the
 *  server no longer holds that version. */
export type Since = { version: string; editable: boolean } & ({ ops: Op[] } | { blocks: Block[] });

/** A frontmatter key changed on disk since it was read: its value there,
 *  null when it is gone. */
export interface FieldConflict {
  key: string;
  theirs: unknown;
}

export interface EntryStub {
  path: string;
  name: string;
  type: string;
  /**
   * The filename made readable, and what navigation shows: "003-watch-and-events.md"
   * becomes "Watch and events". You arrived at a file, so the tree and the
   * breadcrumb name the file.
   */
  label: string;
  /**
   * What the entry calls itself, absent when it carries no `title`. Shown on its
   * own page, and matched by search so an entry is findable by either name.
   */
  title?: string;
  /** The bundle version this entry's content last moved at. Compared against the
   *  version you last saw it at, which is what marks it as changed. */
  changedAt: number;
  /** Why the header couldn't be read, as on `Entry`; absent when it reads. */
  frontmatterError?: string;
  /** Wall-clock time of the last change, as on `Entry`. */
  updated?: string;
  /** The distinct entries it is linked with, either way: its degree on a graph. */
  links: number;
}

export interface TreeNode {
  path: string;
  name: string;
  /** `name` made readable, by the rule that names entries. Absent for the root,
   *  which has no name of its own. */
  label?: string;
  /** The folder's own index.md, absent when it has none. */
  index?: string;
  entries: EntryStub[];
  children: TreeNode[];
}

/**
 * A board a bundle declares in `[[board]]`, beyond the built-in `root`.
 */
export interface BoardConfig {
  path: string;
  /** What the URL carries, and what tells two boards over one folder apart.
   *  Declared in the config, never derived from the path. */
  id: string;
  /** What to call it on screen: the config's name, or the folder made readable. */
  name: string;
  where?: string[];
  status: string;
  columns?: string[];
  lane?: string;
}

export interface Card {
  path: string;
  label: string;
  title?: string;
  type?: string;
  /** This card's value for the board's lane field, absent when it has none. */
  lane?: string;
  /** How many entries this one waits on, and how many wait on it. Absent at
   *  zero: two opposite facts, and a card with no edges reports neither. */
  blockedBy?: number;
  blocks?: number;
  /** The first entry it waits on, named; present exactly when `blockedBy` is. */
  blocker?: string;
  /** Its degree on a graph, as on a tree stub. */
  links?: number;
  /** The entry's own tags. Not a configurable key: `tags` is the conventional
   *  name rather than one workflow's word for something. */
  tags?: string[];
}

export interface Column {
  /** The status this column holds; empty for cards carrying none. */
  value: string;
  /** True for a column the config declares, false for one that exists only
   *  because an entry has that status. Renaming the status makes the second
   *  vanish and leaves the first empty, so they cannot look the same. */
  pinned: boolean;
  cards: Card[];
}

/** A frontmatter key the board's folder uses, and what it holds. */
export interface Field {
  key: string;
  /** The distinct values, absent for a key with too many to be a choice — a
   *  title has as many as there are entries. */
  values?: string[];
  /** True for a key holding a list. It filters — `tags=bug` matches on
   *  membership — and does not group, since a column or a lane is one value. */
  list?: boolean;
}

/** What a board's settings form owns. Not `id` or `path`: those are what the
 *  board is, and changing an id breaks every link to it. */
export interface BoardSettings {
  name: string;
  status: string;
  lane: string;
  /** The field naming what an entry waits on. A workflow convention rather than
   *  something the format defines, so a bundle that says `waits_on` is right. */
  blockers: string;
  where: string[];
  columns: string[];
  /** The order the lane bands go in. Orders and adds, never filters, exactly as
   *  `columns` does. */
  lanes: string[];
}

/**
 * One folder stacked into columns.
 *
 * Assembled by the server, which already has the config decoded and the `where`
 * filters parsed. Rebuilding it here would mean a request per card just to read
 * each entry's status, and a second implementation of the column rules.
 */
export interface Board {
  path: string;
  id: string;
  name: string;
  /** The frontmatter field the columns are made of. */
  field: string;
  /** The field rows group by, absent when the board has no lanes. */
  lane?: string;
  /** The field naming what an entry waits on. */
  blockers: string;
  /** The filter deciding which entries are cards, in the `--where` spelling. */
  where: string[];
  columns: Column[];
  /** The order the lane bands go in, absent when the board has none. Ordered by
   *  the server, which is where the config that pins it is read. */
  lanes?: string[];
  /** The frontmatter keys the board.s folder uses, so choosing a field or a
   *  filter is picking from what is there. Taken before the board's own filter,
   *  which is the filter you would be replacing. */
  fields: Field[];
  /** False for the built-in `root`, which no config mentions. */
  declared: boolean;
  /** Entries under the board's path whose header couldn't be read. They have no
   *  fields, so no column can hold them; listed here instead. Always present. */
  unread: Unread[];
}

/** An entry a board couldn't place, because its header couldn't be read. */
export interface Unread {
  path: string;
  /** The filename made readable, as the tree names it. */
  label: string;
  /** Why the header couldn't be read. */
  error: string;
}

/** A graph a bundle declares. Ids are their own namespace, apart from boards'. */
export interface GraphConfig {
  path: string;
  id: string;
  name: string;
  where?: string[];
  neighbours?: boolean;
}

export interface GraphNode {
  path: string;
  label: string;
  title?: string;
  type?: string;
  /** Drawn only because a filtered entry links to it or from it: context, not
   *  what the graph is about. */
  neighbour?: boolean;
}

/**
 * Every link between two nodes, both directions together. `from` and `to` are
 * the direction of the links, and say nothing when the pair is `mutual`.
 */
export interface GraphEdge {
  from: string;
  to: string;
  mutual?: boolean;
  /** Where the links were written: "body", or the frontmatter field naming the
   *  other entry. */
  via: string[];
  count: number;
}

/** A slice of the bundle as nodes and links, assembled by the server where the
 *  links are already resolved. */
export interface Graph {
  path: string;
  id: string;
  name: string;
  where?: string[];
  neighbours: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The frontmatter keys under the graph's folder, before its filter, so
   *  choosing one is picking from what is there. */
  fields: Field[];
}

/** What a graph's settings form owns. Not `id` or `path`, for the reason a
 *  board's are not. Sent whole, so an empty `where` clears the filter. */
export interface GraphSettings {
  name: string;
  where: string[];
  neighbours: boolean;
}

/** A view about to be declared: which folder, called what, addressed how, and
 *  which of its entries it holds. An empty `where` is every entry under the
 *  path, on a board as on a graph. */
export interface Declaration {
  id: string;
  path: string;
  name: string;
  where: string[];
}

/** What a view over a folder starts as before it is declared. */
export interface Draft {
  where: string[];
  fields: Field[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The whole answer, for endpoints that say more than what went wrong: a
     *  refused pull reports the repository it left behind and the branch its
     *  work could go to. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * The header every API call carries.
 *
 * The server requires it on every `/api` request, so the name is a contract
 * with the other half: renaming it is a change on both sides, not a local one.
 */
const TOKEN_HEADER = "X-Wikishell-Token";

/**
 * What the header carries when this tab holds no token. On localhost the
 * server accepts any value: the header's presence is the protection, because a
 * page on another site cannot add it. On a network address the server answers
 * `401`, and the tab shows how to get the link.
 */
const NO_TOKEN = "local";

/**
 * What stopped this tab reading or writing the bundle, named after what happened
 * rather than after a status code, because the screens are chosen by these names.
 *
 * - `token-refused`: the API answered `401`, so this tab holds no token that this
 *   server accepts. Only a server on a network address asks for one; a restart
 *   creates a new one, which is the common case.
 * - `host-refused`: the API answered `421`, so the name in the address bar is not
 *   a loopback name (the machine's network name, or a DNS-rebinding page). The
 *   token was never the problem, so it is kept.
 * - `unreachable`: nothing is answering, or the change stream could not be
 *   reconnected within its retry budget.
 */
export type Trouble = "token-refused" | "host-refused" | "unreachable";

/** Everyone waiting to hear what stopped this tab. */
const trouble = new Set<(reason: Trouble) => void>();

/**
 * Told when this tab can no longer read or write the bundle, and why (`Trouble`).
 * What to show for each is the app's business; this only reports what happened.
 *
 * Returns a function that stops listening.
 */
export function onTrouble(handler: (reason: Trouble) => void): () => void {
  trouble.add(handler);
  return () => {
    trouble.delete(handler);
  };
}

/** Reports what stopped this tab, once, to everything listening. */
function reportTrouble(reason: Trouble) {
  for (const handler of trouble) handler(reason);
}

/**
 * The one way out to the server: every request carries the header, with this
 * tab's token or `NO_TOKEN`, and nothing the server answers is cached.
 *
 * One place rather than a header set at each call site, so the next endpoint
 * added cannot be the one that forgets it.
 */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const held = token();
  headers.set(TOKEN_HEADER, held ?? NO_TOKEN);
  // `no-store` everywhere, not only on the stream: what these endpoints serve is
  // a private wiki, and a cached answer is one the tab can be shown after the
  // server stopped agreeing to it.
  const res = await fetch(path, { cache: "no-store", ...init, headers });
  if (res.status === 401) {
    // A refusal is about the token this request sent. If the tab took a new one
    // from a pasted link while it was in flight, the refusal is old news: the
    // new token has not been tried, so it is kept and nothing is reported.
    if (token() !== held) return res;
    clearToken();
    reportTrouble("token-refused");
  } else if (res.status === 421) {
    reportTrouble("host-refused");
  }
  return res;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await request(path, { signal });
  if (!res.ok) {
    // The server answers errors as JSON; fall back to the status when whatever
    // replied was not the server.
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? res.statusText, body ?? undefined);
  }
  return res.json() as Promise<T>;
}

const put = <T,>(path: string, body: unknown, keepalive = false) => write<T>("PUT", path, body, keepalive);
const post = <T,>(path: string, body: unknown) => write<T>("POST", path, body);

/** `keepalive` lets the request finish after the page is gone: the browser
 *  takes a body of 64 KiB at most. */
async function write<T>(method: string, path: string, body: unknown, keepalive = false): Promise<T> {
  const res = await request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new ApiError(res.status, b?.error ?? res.statusText, b);
  }
  return res.json() as Promise<T>;
}

const encode = (path: string) =>
  path.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");

export const api = {
  bundle: (signal?: AbortSignal) => get<BundleInfo>("/api/bundle", signal),
  tree: (signal?: AbortSignal) => get<TreeNode>("/api/tree", signal),
  board: (path: string, signal?: AbortSignal) => get<Board>("/api/board/" + encode(path), signal),
  graph: (id: string, signal?: AbortSignal) =>
    get<Graph>("/api/graph/" + encodeURIComponent(id), signal),
  entry: (path: string, signal?: AbortSignal) =>
    // The path is carried verbatim, `.md` and all, because it *is* the bundle
    // path. Each segment is encoded so a name with a space or a '#' survives.
    get<Entry>("/api/entry/" + encode(path), signal),

  /** What changed in a page's body since a version (editor-adr.md, "Reading"). */
  blocks: (path: string, since: string, signal?: AbortSignal) =>
    get<Since>("/api/blocks/" + encode(path) + "?since=" + encodeURIComponent(since), signal),

  /**
   * A dataset's table as a file: the bytes `wiki table --format csv|json`
   * prints, and the name the server gives it. Fetched rather than linked,
   * because every /api request carries the token header and a link can't.
   */
  table: async (path: string, format: "csv" | "json") => {
    const res = await request("/api/table/" + encode(path) + "?format=" + format);
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      throw new ApiError(res.status, b?.error ?? res.statusText, b);
    }
    // The page's own name (filename*, RFC 6266) before the ASCII fallback.
    const disposition = res.headers.get("content-disposition") ?? "";
    const real = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const name =
      (real && decodeURIComponent(real)) || /filename="([^"]+)"/.exec(disposition)?.[1] || `dataset.${format}`;
    return { blob: await res.blob(), name };
  },

  /**
   * Writes block operations made against `base`, whose block hashes are
   * `baseBlocks`. The server merges them with whatever reached the disk
   * meanwhile, and answers what it couldn't apply as conflicts.
   */
  saveBlocks: (path: string, base: string, baseBlocks: string[], ops: Op[], keepalive = false) =>
    put<Saved>("/api/blocks/" + encode(path), { base, baseBlocks, ops }, keepalive),

  /**
   * Sets and unsets frontmatter fields, each guarded by the value it had when
   * read (`old`; absent means it had none). A key changed on disk meanwhile is
   * not written, and comes back as a conflict.
   */
  setFields: (path: string, set: Record<string, unknown>, old: Record<string, unknown>, unset: string[] = []) =>
    put<{ version: string; conflicts: FieldConflict[] }>("/api/fields/" + encode(path), { set, old, unset }),

  /** Creates a page with its whole file; refused with 409 when one is there. */
  createEntry: (path: string, content: string) => post<{ version: string }>("/api/entries", { path, content }),

  /**
   * A new entry's draft: its path (the title's slug, by the wiki's own rules)
   * and its whole file, which `createEntry` posts unchanged. `in` is a folder,
   * or an entry whose parts go in a folder beside it. A 409 is a taken path;
   * a 422, a title, type or place the wiki refuses; both say why.
   */
  draftEntry: (into: string, type: string, title: string, signal?: AbortSignal) =>
    get<{ path: string; content: string }>(
      "/api/entries/new?" + new URLSearchParams({ in: into, type, title }).toString(),
      signal,
    ),

  /**
   * Moves a card to another column.
   *
   * The column's value, not the field it is stored in: the board says which
   * frontmatter key its columns are made of, and it says so on the server where
   * the config is parsed. The bundle version travels with it: the server refuses
   * the move when the bundle moved on since.
   */
  moveCard: (board: string, path: string, value: string, lane: string, version: number) =>
    put<{ version: number }>("/api/card/" + encodeURIComponent(board) + "/" + encode(path), {
      value,
      lane,
      version,
    }),

  /** What a board or a graph over a folder would start as, for the form that
   *  declares one: the server's default filter, and the folder's keys. */
  draft: (kind: "board" | "graph", path: string, signal?: AbortSignal) =>
    get<Draft>("/api/draft/" + kind + "/" + encode(path), signal),

  /**
   * Declares a board, by appending it to the bundle's `wiki.toml`.
   *
   * No version guard, unlike the writes above: those are addressed by something
   * that only means anything against the content it was read from, and this
   * appends a board that did not exist.
   */
  declareBoard: (board: Declaration) =>
    post<{ version: number }>("/api/board", board),

  /**
   * Changes what a board is: its filter, its fields, its columns.
   *
   * All of them at once rather than one key at a time, because clearing a
   * setting is how you say a board has no lanes — and a partial update would
   * have to guess whether an absent key means "unchanged" or "cleared".
   */
  boardSettings: (id: string, settings: BoardSettings) =>
    put<{ version: number }>("/api/board/" + encodeURIComponent(id), settings),

  /** Declares a graph, and changes one, by the rules boards follow. */
  declareGraph: (graph: Declaration) =>
    post<{ version: number }>("/api/graph", graph),
  graphSettings: (id: string, settings: GraphSettings) =>
    put<{ version: number }>("/api/graph/" + encodeURIComponent(id), settings),

  // Git. Every one of these is asked for: nothing fetches on load, nothing
  // pushes on a timer, and the bundle belongs to whoever else is editing it.
  git: (signal?: AbortSignal) => get<GitResult>("/api/git", signal),
  gitFetch: () => post<GitResult>("/api/git/fetch", {}),
  gitPull: () => post<GitResult>("/api/git/pull", {}),
  gitPush: () => post<GitResult>("/api/git/push", {}),
  gitBranch: (name: string) => post<GitResult>("/api/git/branch", { name }),
  refresh: () => post<{ version: number }>("/api/refresh", {}),

  // The changes view (changes-view-adr.md): what isn't committed, one file's
  // diff, and the two writes, each guarded by the version the user saw.
  changes: (signal?: AbortSignal) => get<Changes>("/api/changes", signal),
  change: (path: string, signal?: AbortSignal) => get<FileDiff>("/api/changes/" + encode(path), signal),
  /** Undoes one hunk, or the whole file without `hunk`. */
  discard: (path: string, version: string, hunk?: number) =>
    post<{ version: string }>("/api/changes/discard", { path, version, hunk }),
  /** Commits the files, each at the version shown. It never pushes: pushing
   *  is `gitPush`, in the git popover. */
  commit: (message: string, files: { path: string; version: string }[]) =>
    post<Committed>("/api/commit", { message, files }),
};

/** How many reconnects in a row before giving up rather than retrying forever. */
const RECONNECT_LIMIT = 4;

/**
 * The stream's two clocks, in one place.
 *
 * `retryMs` is the first wait before reconnecting, doubled on each failure, and
 * `idleMs` is how long a connection may deliver nothing before it is treated as
 * dead. They are here rather than inline so a test can run the retry budget out
 * in milliseconds instead of a quarter of a minute; nothing else changes them.
 * `idleMs` is twice the server's 15-second heartbeat: one lost heartbeat is
 * tolerated, and a connection silent for two is presumed gone.
 */
export const streamTiming = { retryMs: 1000, idleMs: 30_000 };

/**
 * Subscribes to change notifications.
 *
 * The stream carries a version and never a payload, so this reports staleness
 * rather than delivering content: a client that missed ten events refetches once
 * and is correct again. Returns an unsubscribe function.
 *
 * A streaming `fetch` reader rather than `EventSource`, because the server wants
 * the token header on this route like on every other one and `EventSource`
 * cannot set headers. What that costs is the reconnect `EventSource` did for
 * free, so this does its own:
 *
 * - a connection that ends, fails or goes silent is reopened, with a wait that
 *   starts at `streamTiming.retryMs` and doubles;
 * - the budget is only refilled once a connection *delivers something* (a
 *   heartbeat counts), not when it merely opens, so a server that accepts and
 *   immediately closes cannot keep the loop alive;
 * - a connection that delivers nothing for `streamTiming.idleMs` is aborted and
 *   retried, because a socket can die without closing — a laptop lid, a changed
 *   Wi-Fi — and an open read would otherwise wait forever;
 * - after `RECONNECT_LIMIT` failures in a row it gives up and reports the bundle
 *   `unreachable`, instead of retrying quietly forever.
 *
 * `401` and `421` are the exception: they are answers, not failures, and there
 * is nothing to retry — `request` has already reported them and the app replaces
 * the screen. Only a network failure, a `5xx`, or a stream that ended is worth
 * another attempt.
 */
export function onVersion(handler: (version: number) => void, onReconnect?: () => void): () => void {
  const abort = new AbortController();
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The connection in hand, so unsubscribing (or an idle timeout) can end it
  // without touching a connection that has not started yet.
  let attempt: AbortController | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let connections = 0;

  const run = async (): Promise<void> => {
    attempt = new AbortController();
    const connection = attempt;
    const onAbort = () => connection.abort();
    abort.signal.addEventListener("abort", onAbort);
    try {
      const res = await request("/api/events", {
        signal: connection.signal,
        headers: { accept: "text/event-stream" },
      });
      // Already reported by `request`: the token or the address is wrong, and
      // another connection would get the same answer. The one exception is a
      // late 401 for a token the tab has since replaced, which is not reported;
      // stopping is still right, because adopting a token restarts the stream
      // (App's hashchange handler bumps `streamAttempt`).
      if (res.status === 401 || res.status === 421) return;
      if (!res.ok || !res.body) throw new ApiError(res.status, res.statusText);
      // An open connection owes us a heartbeat within the window, so the clock
      // starts here and is reset by every delivery.
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => connection.abort(), streamTiming.idleMs);
      };
      touch();
      // Connected again, after a restart maybe: the caller may look for a new build.
      if (connections++ > 0) onReconnect?.();
      for await (const version of versions(res.body, connection.signal, () => {
        // Delivering is what makes a connection real, so this is where the
        // retry budget is refilled — and where the idle clock is reset.
        failures = 0;
        touch();
      })) {
        if (abort.signal.aborted) return;
        handler(version);
      }
      // The body ended. The server closes a stream when it shuts down, so
      // connecting again is the right move; the token alone says whether that
      // works, and a restart is what makes it not.
    } catch {
      // A failure, an idle abort, or our own unsubscribe: the check below tells
      // the first two from the last.
    } finally {
      clearTimeout(idle);
      abort.signal.removeEventListener("abort", onAbort);
    }
    if (abort.signal.aborted) return;
    failures++;
    if (failures > RECONNECT_LIMIT) {
      reportTrouble("unreachable");
      return;
    }
    timer = setTimeout(run, streamTiming.retryMs * 2 ** (failures - 1));
  };

  void run();
  return () => {
    abort.abort();
    attempt?.abort();
    clearTimeout(idle);
    clearTimeout(timer);
  };
}

/**
 * The versions in an event body, one event at a time.
 *
 * Deliberately minimal: the server sends `event: version` and `data: <n>`, a
 * blank line between events, and both ends of that format are this app's.
 * Parsing all of server-sent events here would be a second interpretation of
 * something the app already owns. `\r\n\r\n` is accepted as well, because a
 * proxy is allowed to rewrite line endings and the server does not control one.
 *
 * `delivered` is called whenever bytes arrive, including a heartbeat, which is
 * what tells the caller the connection is real.
 */
async function* versions(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  delivered: () => void,
): AsyncGenerator<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  // Aborting the request is not enough on its own to settle a pending read on
  // every runtime, and a read that never settles would never report the idle
  // connection this abort is for. Cancelling the body settles it.
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      delivered();
      pending += decoder.decode(value, { stream: true });
      for (let event = cutEvent(pending); event; event = cutEvent(pending)) {
        pending = event.rest;
        const version = versionIn(event.block);
        if (version !== null) yield version;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    // Unsubscribing while a read is pending leaves it unresolved otherwise.
    cancel();
  }
}

/**
 * Splits the first complete event off `pending`, and returns what is left.
 *
 * Both blank-line endings are accepted; taking the earliest of the two keeps a
 * `\r\n` stream from being read as one long event.
 */
function cutEvent(pending: string): { block: string; rest: string } | null {
  const lf = pending.indexOf("\n\n");
  const crlf = pending.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  const crlfFirst = crlf >= 0 && (lf < 0 || crlf < lf);
  const at = crlfFirst ? crlf : lf;
  return { block: pending.slice(0, at), rest: pending.slice(at + (crlfFirst ? 4 : 2)) };
}

/** The version one event block reports, or null when it is not a version event. */
function versionIn(block: string): number | null {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
  }
  // No data is not version 0: `Number("")` is 0, and refetching on it would make
  // a malformed event look like a real change.
  if (event !== "version" || data === "") return null;
  const version = Number(data);
  return Number.isFinite(version) ? version : null;
}

/** One path a commit would carry, with git's own two-letter status: `??` is
 *  untracked, ` M` modified, `A ` added, ` D` deleted. */
export interface GitChange {
  path: string;
  code: string;
}

/** What the bundle's repository looks like, and what an action would do to it. */
export interface GitStatus {
  /** False when the bundle is not in a repository, or git is not installed. The
   *  actions are then absent rather than broken. */
  repo: boolean;
  branch: string;
  /** HEAD's short commit, "" on an unborn branch: a detached HEAD says it. */
  head: string;
  /** The upstream this branch tracks, empty when it tracks none: without one
   *  there is nothing to pull from or push to. */
  remote: string;
  /** Counted against the upstream as of the last fetch. `behind` is stale until
   *  something fetches, which only happens when a preview is opened. */
  ahead: number;
  behind: number;
  /** The commits a pull would take, newest first, as stale as `behind` and
   *  capped server-side; `behind` is the true count. */
  incoming: GitCommit[];
  /** Everything a commit would include, not only what WikiShell wrote. */
  changes: GitChange[];
  /** Files staged elsewhere in the same repository, which a sync will not
   *  commit. Said out loud because it is not going to happen: staging work in a
   *  terminal and then pressing "commit and push" looks like it covers both. */
  outside: number;
}

/** One commit, as a log line describes it. `when` is RFC 3339. */
export interface GitCommit {
  sha: string;
  subject: string;
  author: string;
  when: string;
}

export interface GitResult {
  status: GitStatus;
  error?: string;
  /** The branch offered when a pull had to be abandoned, so the way out arrives
   *  with the problem. */
  proposed?: string;
}

/** Every uncommitted change in the bundle (`GET /api/changes`). */
export interface Changes {
  /** False when the bundle isn't in git. */
  repo: boolean;
  files: ChangedFile[];
  /** Files staged outside the bundle, which a commit here never takes. */
  outside: number;
}

/** One changed file, at the `version` it was read at. */
export interface ChangedFile {
  path: string;
  /** The old path, for a rename. */
  from?: string;
  change: "new" | "modified" | "deleted" | "renamed";
  /** The file's bytes now; "" for a deleted file and for a dot file. */
  version: string;
  /** `dot`: a name starting with a dot, never shown or committed here. */
  kind: "page" | "text" | "binary" | "dot" | "link";
  title?: string;
  /** Blocks for a page, lines for text; absent when not counted. */
  added?: number;
  removed?: number;
  /** Set for a file over 2 MiB, which is listed but not diffed. */
  size?: number;
  /** Only when the mode changed: git's `100644`, `100755`, `120000`. */
  mode?: { from?: string; to: string };
}

/** One file's diff (`GET /api/changes/{path}`). */
export interface FileDiff {
  version: string;
  /** git's unified diff; absent for a binary or large file. */
  raw?: string;
  /** A page's: HEAD's blocks, and the operations from them to now. */
  blocks?: { ops: Op[]; head: Block[] };
  /** A field's `from` or `to` is null when HEAD or now lacks it. */
  fields?: { key: string; from: unknown; to: unknown }[];
  /** A page's header bytes differ from HEAD's. With no `fields`, only its
   *  layout changed: order, comments or quoting. */
  header?: boolean;
  /** What can be discarded; `hunk: n` in a discard is an index here. */
  hunks: Hunk[];
}

export type Hunk =
  | { kind: "field"; key: string }
  | { kind: "blocks" | "move"; ops: number[] }
  | { kind: "lines"; at: number };

/** What `POST /api/commit` answers. */
export interface Committed {
  committed: string[];
  refused: { path: string; reason: string }[];
  commit: string;
  status: GitStatus;
}
