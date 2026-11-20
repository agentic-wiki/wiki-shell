import { beforeAll, expect, test } from "bun:test";
import type { Node } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import type { Block, Op } from "@/api";
import { lineup, load } from "@/edit/blocks";
import { createEngine, type Engine } from "@/edit/engine";
import corpus from "./testdata/corpus.json";

/**
 * The editor's side of "a page saved unchanged stays byte-identical": over the
 * corpus (this repo's backlog, `wiki init --full`'s pages and a page of every
 * kind, split by wiki itself), an unchanged page saves no operation, and a
 * one-word edit is one replace of the block it was made in.
 */

const pages = corpus as { path: string; body: string; blocks: Block[] }[];
let engine: Engine;
beforeAll(async () => {
  engine = await createEngine();
});

/** A text without its backslash escapes. */
const unescaped = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");

test("an unchanged page saves no operation; only raw HTML, footnotes, callouts and reference links are source", () => {
  let source = 0;
  let total = 0;
  for (const page of pages) {
    const loaded = load(engine, page.body, page.blocks);
    expect({ path: page.path, ops: lineup(engine, loaded, page.blocks, loaded.doc) }).toEqual({
      path: page.path,
      ops: [],
    });
    source += loaded.source;
    total += page.blocks.length;
  }
  // Raw HTML, footnotes and callouts are always source; anything else on the
  // corpus maps.
  const kept = pages
    .flatMap((p) => p.blocks)
    .filter(
      (b) =>
        b.kind === "html" ||
        b.text.includes("[^") ||
        /^> \[!/.test(b.text) ||
        // kinds.md's reference links, and their definitions.
        b.text.includes("[reference link][docs]") ||
        b.text.startsWith("[docs]:"),
    ).length;
  expect({ source, total }).toEqual({ source: kept, total });
});

/** Replaces the first word of four letters or more in the first node `pick`
 *  chooses, inside a text node. */
function editWord(doc: Node, pick: (node: Node, parent: Node | null) => boolean): { doc: Node; word: string } | null {
  let hit: { from: number; to: number; word: string } | null = null;
  doc.descendants((node, pos, parent) => {
    if (hit) return false;
    if (!pick(node, parent)) return true;
    node.descendants((child, at) => {
      if (hit || !child.isText || child.marks.length > 0) return !hit;
      const m = /\p{L}{4,}/u.exec(child.text!);
      if (m) hit = { from: pos + 1 + at + m.index, to: pos + 1 + at + m.index + m[0].length, word: m[0] };
      return false;
    });
    return !hit;
  });
  if (!hit) return null;
  const { from, to, word } = hit;
  return { doc: EditorState.create({ doc }).tr.insertText("EDITED", from, to).doc, word };
}

const kinds: [string, (node: Node, parent: Node | null) => boolean][] = [
  ["paragraph", (n, p) => n.type.name === "paragraph" && p?.type.name === "doc"],
  ["item", (n) => n.type.name === "list_item"],
  ["row", (n) => n.type.name === "table_row"],
];

for (const [kind, pick] of kinds) {
  test(`a one-word edit in a ${kind} is one replace of its block, with every other word kept`, () => {
    let tried = 0;
    let identical = 0;
    for (const page of pages) {
      const loaded = load(engine, page.body, page.blocks);
      const edit = editWord(loaded.doc, pick);
      if (!edit) continue;
      const ops = lineup(engine, loaded, page.blocks, edit.doc);
      expect({ path: page.path, ops: ops.map((o) => o.op) }).toEqual({ path: page.path, ops: ["replace"] });
      const op = ops[0] as Extract<Op, { op: "replace" }>;
      const before = page.blocks[op.at]!.text;
      // Only where the word says which occurrence it was.
      if (before.split(edit.word).length !== 2) continue;
      tried++;
      expect(op.hash).toBe(page.blocks[op.at]!.hash);
      // Only the user's change is written: the block comes back as it was but
      // for the word, at most with a backslash escape added (a link's `(`).
      const want = before.replace(edit.word, "EDITED");
      expect({ path: page.path, text: unescaped(op.text!) }).toEqual({ path: page.path, text: unescaped(want) });
      if (op.text === want) identical++;
    }
    expect(tried).toBeGreaterThan(kind === "row" ? 3 : 20);
    // Byte for byte, but for the word: the house style already holds on most
    // blocks, and a block that differs only differs in its own bytes.
    console.log(`${kind}: ${identical} of ${tried} edits byte-identical but for the word`);
  });
}

/**
 * A page, its blocks as the server would split it (one per `\n\n`-separated
 * chunk, or per line in a list or table), and what lineup sends once the
 * editor holds `after`. Typing until the document is `after` is modelled by
 * parsing it: an untouched unit parses the same.
 */
function save(body: string, blocks: [Block["kind"], string][], after: string, from = 0): Op[] {
  const bs = blocks.map(([kind, text], i): Block => ({ kind, text, hash: "h" + i }));
  const loaded = load(engine, body, bs, from);
  return lineup(engine, loaded, bs, engine.parse(after));
}

test("a new paragraph is an insert after the block before it", () => {
  expect(save("One.\n\nTwo.\n", [["paragraph", "One."], ["paragraph", "Two."]], "One.\n\nNew.\n\nTwo.\n")).toEqual([
    { op: "insert", after: 0, hash: "h0", text: "New." },
  ]);
  expect(save("One.\n", [["paragraph", "One."]], "First.\n\nOne.\n")).toEqual([
    { op: "insert", after: -1, hash: "", text: "First." },
  ]);
});

test("a deleted block is a delete; a changed one a replace", () => {
  expect(save("# A\n\nOne.\n\nTwo.\n", [["heading", "# A"], ["paragraph", "One."], ["paragraph", "Two."]], "One.\n\nTwo!\n")).toEqual([
    { op: "delete", at: 0, hash: "h0" },
    { op: "replace", at: 2, hash: "h2", text: "Two!" },
  ]);
});

test("an item keeps its own marker, number and indentation", () => {
  const body = "* one\n* two\n    * deep\n\n3) three\n4) four\n";
  const blocks: [Block["kind"], string][] = [
    ["item", "* one"],
    ["item", "* two"],
    ["item", "    * deep"],
    ["item", "3) three"],
    ["item", "4) four"],
  ];
  expect(save(body, blocks, "- one\n- two\n  - deeper\n\n3. three\n4. FOUR\n")).toEqual([
    { op: "replace", at: 2, hash: "h2", text: "    * deeper" },
    { op: "replace", at: 4, hash: "h4", text: "4) FOUR" },
  ]);
});

test("a new item takes its neighbour's marker, one number on", () => {
  const body = "* one\n* two\n\n3) three\n";
  const blocks: [Block["kind"], string][] = [
    ["item", "* one"],
    ["item", "* two"],
    ["item", "3) three"],
  ];
  expect(save(body, blocks, "- one\n- two\n- added\n\n3. three\n4. more\n")).toEqual([
    { op: "insert", after: 1, hash: "h1", text: "* added" },
    { op: "insert", after: 2, hash: "h2", text: "4) more" },
  ]);
});

test("a ticked to-do keeps its marker; a callout keeps its type", () => {
  expect(save("+ [ ] do it\n", [["item", "+ [ ] do it"]], "- [x] do it\n")).toEqual([
    { op: "replace", at: 0, hash: "h0", text: "+ [x] do it" },
  ]);
  expect(save("> [!note] Hi\n> there\n", [["quote", "> [!note] Hi\n> there"]], "> [!note] Hi\n> there, you\n")).toEqual([
    { op: "replace", at: 0, hash: "h0", text: "> [!note] Hi\n> there, you" },
  ]);
});

test("a table row is written alone, in the table's style; the head keeps its delimiter", () => {
  const body = "| a | b |\n| :-- | --: |\n| 1 | 2 |\n";
  const blocks: [Block["kind"], string][] = [
    ["table-head", "| a | b |\n| :-- | --: |"],
    ["row", "| 1 | 2 |"],
  ];
  expect(save(body, blocks, "| a | b |\n| :-- | --: |\n| 1 | 2 |\n| x\\|y | 3 |\n")).toEqual([
    { op: "insert", after: 1, hash: "h1", text: "| x\\|y | 3 |" },
  ]);
  expect(save(body, blocks, "| A | b |\n| :-- | --: |\n| 1 | 2 |\n")).toEqual([
    { op: "replace", at: 0, hash: "h0", text: "| A | b |\n| :-- | --: |" },
  ]);
  expect(save(body, blocks, "| a | b |\n| :-: | --: |\n| 1 | 2 |\n")[0]).toEqual({
    op: "replace",
    at: 0,
    hash: "h0",
    text: "| a | b |\n| :---: | ---: |",
  });
});

test("with the title hoisted, the body starts after it", () => {
  const body = "# Title\n\nOne.\n";
  expect(save(body, [["heading", "# Title"], ["paragraph", "One."]], "Zero.\n\nOne.\n", 1)).toEqual([
    { op: "insert", after: 0, hash: "h0", text: "Zero." },
  ]);
});

test("a block using a reference link is source, so an edit keeps the link as written", () => {
  const body = "See [the docs][docs] and [more].\n\n[docs]: https://example.com\n[more]: ./more.md\n";
  const blocks: Block[] = [
    { kind: "paragraph", text: "See [the docs][docs] and [more].", hash: "h0" },
    { kind: "paragraph", text: "[docs]: https://example.com\n[more]: ./more.md", hash: "h1" },
  ];
  const loaded = load(engine, body, blocks);
  expect(loaded.source).toBe(2);
  // Typing in its Markdown writes exactly what was typed.
  const edit = editWord(loaded.doc, (n) => n.type.name === "source");
  const ops = lineup(engine, loaded, blocks, edit!.doc);
  expect(ops).toEqual([{ op: "replace", at: 0, hash: "h0", text: "See [the EDITED][docs] and [more]." }]);
});

test("an empty row the user adds is kept; a head-only table's filler row isn't a row", () => {
  const body = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const blocks: Block[] = [
    { kind: "table-head", text: "| a | b |\n| --- | --- |", hash: "h0" },
    { kind: "row", text: "| 1 | 2 |", hash: "h1" },
  ];
  const loaded = load(engine, body, blocks);
  const after = engine.parse("| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n");
  expect(lineup(engine, loaded, blocks, after)).toEqual([{ op: "insert", after: 1, hash: "h1", text: "|  |  |" }]);

  const head = load(engine, "| a |\n| --- |\n", [{ kind: "table-head", text: "| a |\n| --- |", hash: "h0" }]);
  expect(head.source).toBe(0);
  expect(lineup(engine, head, [{ kind: "table-head", text: "| a |\n| --- |", hash: "h0" }], head.doc)).toEqual([]);
});
