import { expect, test } from "bun:test";
import type { Block, Hunk, Op } from "@/api";
import { pageRows, withContext } from "@/changes/rows";
import { diffLines, fileTree, foldedAtFirst, treeOrder } from "@/changes/lines";

const b = (text: string, kind: Block["kind"] = "paragraph"): Block => ({ kind, text, hash: text });
const said = (rows: ReturnType<typeof pageRows>) =>
  rows.map((r) =>
    r.kind === "changed" ? `~${r.from.text}>${r.to.map((t) => t.text).join("+")}@${r.hunk}` : r.kind === "same" ? r.block.text : `${r.kind[0]}${r.block.text}@${r.hunk}`,
  );

test("rows walk HEAD's blocks, each operation drawn where it anchors", () => {
  const head = [b("# Top", "heading"), b("one"), b("two"), b("three")];
  const ops: Op[] = [
    { op: "insert", after: -1, hash: "", blocks: [b("first")] },
    { op: "replace", at: 1, hash: "one", blocks: [b("ONE"), b("one more")] },
    { op: "delete", at: 2, hash: "two" },
    { op: "move", at: 3, hash: "three", after: 0 },
  ];
  const hunks: Hunk[] = [
    { kind: "blocks", ops: [0] },
    { kind: "move", ops: [3] },
    { kind: "blocks", ops: [1, 2] },
  ];
  expect(said(pageRows(head, ops, hunks))).toEqual(["afirst@0", "# Top", "mthree@1", "~one>ONE+one more@2", "rtwo@2"]);
});

test("a move says the heading it was under, or the top of the page", () => {
  const head = [b("a"), b("## Plan ##", "heading"), b("c")];
  const rows = pageRows(
    head,
    [
      { op: "move", at: 0, hash: "a", after: 2 },
      { op: "move", at: 2, hash: "c", after: -1 },
    ],
    [],
  );
  expect(rows.flatMap((r) => (r.kind === "moved" ? [r.under] : []))).toEqual(["Plan", null]);
});

test("unchanged runs fold, but for two blocks of context each side", () => {
  const head = "abcdefghij".split("").map((t) => b(t));
  const rows = pageRows(head, [{ op: "delete", at: 5, hash: "f" }], [{ kind: "blocks", ops: [0] }]);
  const shown = withContext(rows).map((r) => (r.kind === "fold" ? `fold${r.rows.length}` : r.kind === "same" ? r.block.text : "-"));
  expect(shown).toEqual(["fold3", "d", "e", "-", "g", "h", "fold2"]);
});

test("diff lines are numbered on each side and tagged with their @@ hunk", () => {
  const lines = diffLines(
    "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -10,2 +10,2 @@ ctx\n keep\n-old\n+new\n@@ -40 +40,2 @@\n forty\n+more\n\\ No newline at end of file\n",
  );
  expect(lines).toEqual([
    { kind: "hunk", text: "@@ -10,2 +10,2 @@ ctx", hunk: 0 },
    { kind: "ctx", text: " keep", hunk: 0, old: 10, new: 10 },
    { kind: "del", text: "-old", hunk: 0, old: 11 },
    { kind: "add", text: "+new", hunk: 0, new: 11 },
    { kind: "hunk", text: "@@ -40 +40,2 @@", hunk: 1 },
    { kind: "ctx", text: " forty", hunk: 1, old: 40, new: 40 },
    { kind: "add", text: "+more", hunk: 1, new: 41 },
    { kind: "meta", text: "\\ No newline at end of file", hunk: 1 },
  ]);
});

test("the files are a folder tree, lone folders joined, folders first", () => {
  const files = [{ path: "/z.md" }, { path: "/notes/deep/a.md" }, { path: "/notes/deep/b.md" }, { path: "/a/x.md" }, { path: "/a/y/z.md" }];
  const names = (nodes: ReturnType<typeof fileTree<{ path: string }>>): unknown[] =>
    nodes.map((n) => (n.kind === "file" ? n.name : { [n.name]: names(n.children) }));
  expect(names(fileTree(files))).toEqual([{ a: [{ y: ["z.md"] }, "x.md"] }, { "notes/deep": ["a.md", "b.md"] }, "z.md"]);
  expect(treeOrder(files).map((f) => f.path)).toEqual(["/a/y/z.md", "/a/x.md", "/notes/deep/a.md", "/notes/deep/b.md", "/z.md"]);
});

test("generated files and large changes start folded", () => {
  expect(foldedAtFirst("/tools/bun.lock", 3)).toBeDefined();
  expect(foldedAtFirst("/notes/a.md", 501)).toBeDefined();
  expect(foldedAtFirst("/notes/a.md", 20)).toBeUndefined();
});
