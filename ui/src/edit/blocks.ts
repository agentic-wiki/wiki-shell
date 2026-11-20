import { Fragment, type Node } from "@milkdown/prose/model";
import type { Block, Op } from "@/api";
import { matches } from "@/edit/diff";
import type { Engine } from "@/edit/engine";
import { spans } from "@/markdown/spans";

/**
 * How the editor's document maps onto the page's blocks (editor-adr.md, "How
 * it maps onto blocks"), both ways:
 *
 * - `load` parses the blocks into one document. A list's items and a table's
 *   rows map one to one onto item and row blocks; any other block is one node.
 *   A run that doesn't map, or loses a word on the way through the editor, is
 *   a source block: its Markdown, kept as text.
 * - `lineup` lines the edited document up against what was loaded, by content,
 *   and says what changed as block operations. An unchanged unit is no
 *   operation; a changed one is written alone, with its block's own list marker
 *   and indentation put back, so every other byte of the page stays.
 */

/** A part of the document that stands for one block, or for a source run. */
export interface Unit {
  kind: "node" | "item" | "head" | "row" | "source";
  /** What it holds: a top-level node, a list item without its nested lists,
   *  or a table row. */
  node: Node;
  /** Its content, compared to tell a changed unit from an unchanged one. */
  key: string;
  /** For an item: how deep it is nested, and the list it is in. */
  depth: number;
  list?: Node;
  /** For a row or a head: the table it is in. */
  table?: Node;
  /** Where it is in the document it was read from: the node's start and end
   *  (for an item, the end of its own content, before its nested lists), and
   *  the index of the top-level node it is in. */
  from: number;
  to: number;
  top: number;
}

export interface Loaded {
  doc: Node;
  units: Unit[];
  /** The blocks each unit stands for, by index: one, or a source run's. */
  blocks: number[][];
  /** The blocks the document holds as source. */
  source: number;
  /** The first block it holds. */
  from: number;
}

/**
 * Parses blocks `from` onward into one document. Blocks before `from` are not
 * in it (the hoisted title, edited on its own).
 */
export function load(engine: Engine, body: string, blocks: readonly Block[], from = 0): Loaded {
  const where = spans(body, blocks);
  if (!where) throw new Error("the blocks don't rebuild the body");
  const nodes: Node[] = [];
  const units: Unit[] = [];
  const map: number[][] = [];
  let source = 0;
  const labels = definitions(body);
  for (let i = from; i < blocks.length; ) {
    const j = runEnd(blocks, i);
    const text = body.slice(where[i]!.start, where[j]!.end);
    const parsed = children(engine.parse(text));
    const run = parsed.flatMap((n) => flatten(n, 0));
    const holds =
      !FORCED.has(blocks[i]!.kind) &&
      !CALLOUT.test(text) &&
      !usesReference(text, labels) &&
      !parsed.some((n) => n.type.name === "footnote_definition") &&
      run.length === j - i + 1 &&
      run.every((u, k) => fits(u.kind, blocks[i + k]!.kind)) &&
      words(engine.serialize(engine.schema.topNodeType.create(null, parsed))) === words(text);
    if (holds) {
      nodes.push(...parsed);
      run.forEach((u, k) => {
        units.push(u);
        map.push([i + k]);
      });
    } else {
      const node = engine.schema.nodes.source!.create(null, text ? engine.schema.text(text) : null);
      nodes.push(node);
      units.push(sourceUnit(node));
      map.push(range(i, j));
      source += j - i + 1;
    }
    i = j + 1;
  }
  const doc = engine.schema.topNodeType.create(null, nodes);
  return { doc, units, blocks: map, source, from };
}

/**
 * The operations that turn the loaded page into `doc`, against `blocks`, the
 * block list `loaded` was made from.
 */
export function lineup(engine: Engine, loaded: Loaded, blocks: readonly Block[], doc: Node): Op[] {
  const now = unitsOf(doc);
  const pairs = matches(
    loaded.units.map((u) => u.key),
    now.map((u) => u.key),
  );
  // The loaded unit each unit of the document came from, when it kept one:
  // unchanged, or changed in place. Its block's marker and indentation are
  // what a changed item is written with.
  const from = new Map<number, number>();
  const ops: Op[] = [];
  let a = 0;
  let b = 0;
  let anchor = loaded.from - 1;
  for (const [x, y] of [...pairs, [loaded.units.length, now.length] as [number, number]]) {
    const gone = range(a, x - 1);
    const added = range(b, y - 1);
    const both = Math.min(gone.length, added.length);
    let after = anchor;
    for (let k = 0; k < both; k++) {
      const [first, ...rest] = loaded.blocks[gone[k]!]!;
      from.set(added[k]!, gone[k]!);
      const text = write(engine, now[added[k]!]!, blocks[first!]!.text, now, added[k]!, from, loaded, blocks);
      ops.push({ op: "replace", at: first!, hash: blocks[first!]!.hash, text });
      for (const r of rest) ops.push({ op: "delete", at: r, hash: blocks[r]!.hash });
      after = loaded.blocks[gone[k]!]!.at(-1)!;
    }
    for (const g of gone.slice(both)) {
      for (const r of loaded.blocks[g]!) ops.push({ op: "delete", at: r, hash: blocks[r]!.hash });
    }
    for (const n of added.slice(both)) {
      const text = write(engine, now[n]!, undefined, now, n, from, loaded, blocks);
      ops.push({ op: "insert", after, hash: after < 0 ? "" : blocks[after]!.hash, text });
    }
    if (x < loaded.units.length) {
      from.set(y, x);
      anchor = loaded.blocks[x]!.at(-1)!;
    }
    a = x + 1;
    b = y + 1;
  }
  // The server's order: by block, a replace or delete before what is inserted
  // after it. Stable, so inserts after one block keep theirs.
  const key = (op: Op) => (op.op === "insert" ? op.after * 2 + 1 : op.at * 2);
  return ops.sort((p, q) => key(p) - key(q));
}

/**
 * The loaded page moved on to a newer version, which holds exactly what `doc`
 * says: a save wrote it, and nothing else changed (the caller checks that with
 * `applied`). Blocks are mapped from the new version, and units are the
 * document's, so the next lineup sends only what changes from here. Null when
 * the two don't line up unit for unit (a source block the server split
 * differently): the caller then keeps the old base, which the server's merge
 * handles.
 */
export function rebase(engine: Engine, doc: Node, body: string, blocks: readonly Block[], from: number): Loaded | null {
  const fresh = load(engine, body, blocks, from);
  const now = unitsOf(doc);
  if (fresh.units.length !== now.length || fresh.units.some((u, k) => u.kind !== now[k]!.kind)) return null;
  return { ...fresh, doc, units: now };
}

/**
 * The block texts `ops` make of `texts`: an app's operations (with `text`,
 * one block each) or the server's (with `blocks`, and moves).
 */
export function applied(texts: readonly string[], ops: readonly Op[]): string[] {
  const replaced = new Map<number, string[]>();
  const gone = new Set<number>();
  const after = new Map<number, string[]>();
  const add = (at: number, t: string[]) => after.set(at, [...(after.get(at) ?? []), ...t]);
  const textsOf = (op: { text?: string; blocks?: Block[] }) => op.blocks?.map((b) => b.text) ?? [op.text ?? ""];
  for (const op of ops) {
    if (op.op === "replace") replaced.set(op.at, textsOf(op));
    else if (op.op === "delete") gone.add(op.at);
    else if (op.op === "insert") add(op.after, textsOf(op));
    else {
      gone.add(op.at);
      add(op.after, [texts[op.at]!]);
    }
  }
  const out = [...(after.get(-1) ?? [])];
  texts.forEach((t, i) => {
    if (replaced.has(i)) out.push(...replaced.get(i)!);
    else if (!gone.has(i)) out.push(t);
    out.push(...(after.get(i) ?? []));
  });
  return out;
}

/** The kinds of block always kept as source: raw HTML renders as text, never
 *  as HTML, and the editor can't show it as the reader does. */
const FORCED = new Set<Block["kind"]>(["html"]);

/**
 * A callout is kept as source too: the reader lifts its `[!type] Title` line
 * out as a label, which the editor's blockquote can't draw with the same
 * pixels. At rest it is the reader's rendering; clicked, its Markdown.
 */
const CALLOUT = /^ {0,3}>[ \t]*\[![^\]\s]+\]/;

/**
 * The page's link reference definitions (`[label]: url`), by normalized label.
 * A block that uses one (`[text][label]`, `[label][]`, `[label]`) is source:
 * parsed alone, without its definition, its link is plain text, and written
 * back it would come out escaped, the link gone.
 */
function definitions(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/^ {0,3}\[([^\]]+)\]:/gm)) out.add(normal(m[1]!));
  return out;
}

function usesReference(text: string, labels: ReadonlySet<string>): boolean {
  if (labels.size === 0) return false;
  for (const m of text.matchAll(/\[([^\]]*)\](?:\[([^\]]*)\])?/g)) {
    const label = m[2] === undefined || m[2] === "" ? m[1]! : m[2];
    if (labels.has(normal(label))) return true;
  }
  return false;
}

/** A label as CommonMark matches it: case and runs of spaces don't count. */
const normal = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

/** Where the run that starts at block i ends: a list's items, or a table's head
 *  and rows, parse together; any other block alone. */
function runEnd(blocks: readonly Block[], i: number): number {
  const kind = blocks[i]!.kind;
  const next = kind === "item" ? "item" : kind === "table-head" ? "row" : null;
  let j = i;
  while (next && blocks[j + 1]?.kind === next) j++;
  return j;
}

/** Whether a unit of the editor's can stand for a block of that kind. */
function fits(unit: Unit["kind"], block: Block["kind"]): boolean {
  if (unit === "item") return block === "item";
  if (unit === "head") return block === "table-head";
  if (unit === "row") return block === "row";
  return block !== "item" && block !== "table-head" && block !== "row";
}

/** A node's units: a list's items, depth first; a table's rows; else itself. */
/** The units of a document, in order, with where each is. */
export function unitsOf(doc: Node): Unit[] {
  const out: Unit[] = [];
  doc.forEach((node, offset, top) => out.push(...flatten(node, 0, offset, top)));
  return out;
}

/** A node's units: a list's items, depth first; a table's rows; else itself.
 *  `pos` is where the node starts, and `top` the top-level node it is in. */
function flatten(node: Node, depth: number, pos = 0, top = 0): Unit[] {
  const name = node.type.name;
  if (name === "bullet_list" || name === "ordered_list") {
    const out: Unit[] = [];
    node.forEach((item, off) => {
      const at = pos + 1 + off;
      const own: Node[] = [];
      const nested: [Node, number][] = [];
      let end = at + item.nodeSize - 1;
      item.forEach((c, o) => {
        if (isList(c)) {
          if (nested.length === 0) end = at + 1 + o;
          nested.push([c, at + 1 + o]);
        } else own.push(c);
      });
      const mine = item.copy(Fragment.from(own));
      // A list's numbering and spacing follow from where an item is, not from
      // what it says: they are not part of its content.
      const { label: _label, spread: _spread, ...attrs } = item.attrs;
      out.push({
        kind: "item",
        node: mine,
        key: JSON.stringify({ list: name, depth, attrs, content: own.map(keyOf) }),
        depth,
        list: node,
        from: at,
        to: end,
        top,
      });
      for (const [n, p] of nested) out.push(...flatten(n, depth + 1, p, top));
    });
    return out;
  }
  if (name === "table") {
    const out: Unit[] = [];
    // The editor's schema gives a table at least one row under its head, so a
    // table that is only a head gets an empty one, which is no row of the
    // page. Any other empty row, one the user added, is.
    const filler = node.childCount === 2 && node.child(1).textContent.trim() === "";
    node.forEach((row, off, i) => {
      if (filler && i === 1) return;
      out.push({
        kind: row.type.name === "table_header_row" ? "head" : "row",
        node: row,
        key: JSON.stringify(row.toJSON()),
        depth: 0,
        table: node,
        from: pos + 1 + off,
        to: pos + 1 + off + row.nodeSize,
        top,
      });
    });
    return out;
  }
  if (name === "source") return [{ ...sourceUnit(node), from: pos, to: pos + node.nodeSize, top }];
  // An empty paragraph, the one Enter makes (or one holding only spaces and
  // hard breaks, whose Markdown is just as blank), has no Markdown: it is no block
  // of the page until it holds text. Sent as one, the server refused the whole
  // save (an insert needs text), and every pause after Enter looked like a
  // conflict. Emptied, a paragraph is a delete.
  if (name === "paragraph" && blank(node)) return [];
  return [{ kind: "node", node, key: keyOf(node), depth: 0, from: pos, to: pos + node.nodeSize, top }];
}

/** A paragraph of only spaces and hard breaks: no text, and nothing else
 *  inline (an image alone is a block). */
function blank(node: Node): boolean {
  let only = true;
  node.forEach((c) => {
    if (!(c.isText || c.type.name === "hardbreak")) only = false;
  });
  return only && node.textContent.trim() === "";
}

/**
 * A node's content, as a string to compare. A heading's id is left out: the
 * editor sets it from the page's headings, and it is never written.
 */
export function keyOf(node: Node): string {
  return JSON.stringify(node.toJSON(), (k, v) => (k === "attrs" && v && "id" in v ? { ...v, id: undefined } : v));
}

function sourceUnit(node: Node): Unit {
  return { kind: "source", node, key: "source:" + node.textContent, depth: 0, from: 0, to: node.nodeSize, top: 0 };
}

const isList = (n: Node) => n.type.name === "bullet_list" || n.type.name === "ordered_list";

/**
 * A unit as Markdown, for its block. `original` is the text of the block it
 * replaces, whose marker and indentation it keeps; a new item takes its
 * neighbour's.
 */
function write(
  engine: Engine,
  unit: Unit,
  original: string | undefined,
  now: Unit[],
  index: number,
  from: Map<number, number>,
  loaded: Loaded,
  blocks: readonly Block[],
): string {
  const { schema, serialize } = engine;
  const md = (nodes: Node[]) => serialize(schema.topNodeType.create(null, nodes)).replace(/\n+$/, "");
  switch (unit.kind) {
    case "source":
      return unit.node.textContent;
    case "node":
      return unescapeCallout(md([unit.node]));
    case "item": {
      const list = unit.list!.type.create(unit.list!.attrs, [unit.node]);
      const prefix = original ? MARKER.exec(original) : itemPrefix(unit, now, index, from, loaded, blocks);
      return reindent(md([list]), prefix);
    }
    case "head":
    case "row":
      return writeRow(engine, unit, original);
  }
}

/** A list marker with its indentation and the space after it. */
const MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;

/**
 * The prefix a new item takes: that of the item before it at its depth, the
 * number one on for an ordered list, or else under its parent's content.
 */
function itemPrefix(
  unit: Unit,
  now: Unit[],
  index: number,
  from: Map<number, number>,
  loaded: Loaded,
  blocks: readonly Block[],
): RegExpExecArray | null {
  const ordered = unit.list!.type.name === "ordered_list";
  for (let k = index - 1; k >= 0; k--) {
    const u = now[k]!;
    if (u.kind !== "item" || u.depth < unit.depth) {
      // The parent, or the start of the list: under its content, or at the margin.
      const parent = u.kind === "item" && from.has(k) ? MARKER.exec(blocks[loaded.blocks[from.get(k)!]![0]!]!.text) : null;
      const indent = parent ? parent[1]! + " ".repeat(parent[2]!.length + parent[3]!.length) : "";
      return MARKER.exec(indent + (ordered ? "1." : "-") + " ");
    }
    if (u.depth === unit.depth && from.has(k)) {
      const m = MARKER.exec(blocks[loaded.blocks[from.get(k)!]![0]!]!.text);
      if (!m) break;
      const num = /^\d+/.exec(m[2]!);
      return MARKER.exec(m[1]! + (num && ordered ? String(Number(num[0]) + 1) + m[2]!.slice(num[0].length) : m[2]!) + m[3]!);
    }
  }
  return MARKER.exec((ordered ? "1." : "-") + " ");
}

/** An item as the serializer wrote it, at the margin, moved under `prefix`. */
function reindent(text: string, prefix: RegExpExecArray | null): string {
  const lines = text.split("\n");
  const own = MARKER.exec(lines[0]!);
  if (!own || !prefix) return text;
  const width = own[0].length;
  const pad = prefix[1]! + " ".repeat(prefix[2]!.length + (prefix[3]!.length || 1));
  return lines
    .map((line, i) => {
      if (i === 0) return prefix[1]! + prefix[2]! + (prefix[3] || " ") + line.slice(width);
      const content = line.startsWith(" ".repeat(width)) ? line.slice(width) : line.trimStart();
      return content ? pad + content : "";
    })
    .join("\n");
}

/** A table row (or the head: its row and the delimiter row), alone. */
function writeRow(engine: Engine, unit: Unit, original: string | undefined): string {
  const { schema, serialize } = engine;
  const cells: string[] = [];
  const aligns: (string | null)[] = [];
  unit.node.forEach((cell) => {
    const text = serialize(schema.topNodeType.create(null, children(cell)))
      .replace(/\n+$/, "")
      .replace(/\n/g, " ")
      .replace(/(?<!\\)\|/g, "\\|");
    cells.push(text);
    aligns.push((cell.attrs.alignment as string | null) ?? null);
  });
  const first = original?.split("\n")[0];
  const lead = first === undefined || /^\s*\|/.test(first);
  const trail = first === undefined || /\|\s*$/.test(first);
  const row = (lead ? "| " : "") + cells.join(" | ") + (trail ? " |" : "");
  if (unit.kind === "row") return row;
  const delimiter = original?.split("\n")[1];
  const kept = delimiter && sameAligns(delimiter, aligns) ? delimiter : null;
  const made = (lead ? "| " : "") + aligns.map(alignCell).join(" | ") + (trail ? " |" : "");
  return row + "\n" + (kept ?? made);
}

function alignCell(a: string | null): string {
  return a === "left" ? ":---" : a === "center" ? ":---:" : a === "right" ? "---:" : "---";
}

/** Whether a delimiter row says the same alignments, column for column. */
function sameAligns(delimiter: string, aligns: (string | null)[]): boolean {
  const cols = delimiter
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
  if (cols.length !== aligns.length) return false;
  return cols.every((c, i) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    const said = l && r ? "center" : l ? "left" : r ? "right" : null;
    return said === aligns[i];
  });
}

/** The serializer escapes a callout's `[!type]` as text; put it back. */
function unescapeCallout(text: string): string {
  return text.replace(/^((?:> ?)+)\\\[!/, "$1[!");
}

/**
 * The words of some Markdown, sorted: what the fidelity gate compares. Escapes
 * and punctuation don't count; a lost or changed word does.
 */
function words(markdown: string): string {
  return markdown
    .replace(/\\(.)/g, "$1")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  node.forEach((c) => out.push(c));
  return out;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = from; k <= to; k++) out.push(k);
  return out;
}
