import { beforeAll, expect, test } from "bun:test";
import type { Node } from "@milkdown/prose/model";
import { createEngine, type Engine } from "@/edit/engine";
import { plan, type Step } from "@/edit/sync";

let engine: Engine;
beforeAll(async () => {
  engine = await createEngine();
});

/** The plan as text: what each step does, and to which text. */
function run(base: string, mine: string, theirs: string, caretIn?: string) {
  const [b, m, t] = [base, mine, theirs].map((s) => engine.parse(s));
  const caret = caretIn ? positionOf(m!, caretIn) : -1;
  return plan(b!, m!, t!, caret).map((s) => describe(m!, s));
}

function positionOf(doc: Node, text: string): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(text)) at = pos + n.text!.indexOf(text);
    return at < 0;
  });
  return at;
}

function describe(doc: Node, s: Step): string {
  const mine = doc.textBetween(s.from, s.to, "|");
  if (s.kind === "hold") return `hold ${s.case} [${mine}] against [${s.theirs.map((n) => n.textContent).join("|")}]`;
  return `${s.kind} [${mine}] -> [${s.nodes.map((n) => n.textContent).join("|")}]`;
}

test("theirs alone, away from the caret, is applied", () => {
  expect(run("A.\n\nB.\n\nC.\n", "A.\n\nB.\n\nC.\n", "A.\n\nB!\n\nC.\n", "A.")).toEqual(["apply [B.] -> [B!]"]);
  expect(run("A.\n\nB.\n", "A.\n\nB.\n", "A.\n\nNew.\n\nB.\n")).toEqual(["apply [] -> [New.]"]);
  expect(run("A.\n\nB.\n", "A.\n\nB.\n", "A.\n")).toEqual(["apply [B.] -> []"]);
});

test("mine alone is left for the save", () => {
  expect(run("A.\n\nB.\n", "A.\n\nB, mine.\n", "A.\n\nB.\n", "mine")).toEqual([]);
  // Both changed elsewhere: theirs applied, mine kept.
  expect(run("A.\n\nB.\n", "A, mine.\n\nB.\n", "A.\n\nB, theirs.\n", "mine")).toEqual(["apply [B.] -> [B, theirs.]"]);
});

test("the caret's block is never overwritten: a change to it is held", () => {
  expect(run("A.\n\nB.\n", "A.\n\nB.\n", "A.\n\nB!\n", "B")).toEqual(["hold both-changed [B.] against [B!]"]);
  expect(run("A.\n\nB.\n", "A.\n\nB.\n", "A.\n", "B")).toEqual(["hold deleted-outside [B.] against []"]);
});

test("both changed one block, or mine removed what theirs changed: held", () => {
  expect(run("A.\n\nB.\n", "A.\n\nB, mine.\n", "A.\n\nB, theirs.\n")).toEqual([
    "hold both-changed [B, mine.] against [B, theirs.]",
  ]);
  expect(run("A.\n\nB.\n\nC.\n", "A.\n\nC.\n", "A.\n\nB, theirs.\n\nC.\n")).toEqual([
    "hold changed-outside [] against [B, theirs.]",
  ]);
});

test("in the caret's list, theirs' other items update one by one", () => {
  const base = "- one\n- two\n- three\n";
  expect(run(base, base, "- one\n- TWO\n- three\n", "one")).toEqual(["unit [two] -> [TWO]"]);
  // Its own item changed: the list is held.
  expect(run(base, base, "- ONE\n- two\n- three\n", "one")).toEqual([
    "hold both-changed [one|two|three] against [ONEtwothree]",
  ]);
  // Another shape (an item added): held too.
  expect(run(base, base, "- one\n- two\n- two and a half\n- three\n", "one")[0]).toStartWith("hold both-changed");
});

test("both inserted at one place: both kept, mine first", () => {
  expect(run("A.\n\nB.\n", "A.\n\nMine.\n\nB.\n", "A.\n\nTheirs.\n\nB.\n", "Mine")).toEqual([
    "apply [] -> [Theirs.]",
  ]);
  // Theirs goes after mine: at B's place in mine.
  const [b, m, t] = ["A.\n\nB.\n", "A.\n\nMine.\n\nB.\n", "A.\n\nTheirs.\n\nB.\n"].map((x) => engine.parse(x));
  const step = plan(b!, m!, t!, -1)[0]!;
  expect(step.from).toBe(m!.child(0).nodeSize + m!.child(1).nodeSize);
});

test("the same change on both sides is no change", () => {
  expect(run("A.\n\nB.\n", "A.\n\nB!\n", "A.\n\nB!\n", "B")).toEqual([]);
});

test("the same insertion on both sides is kept once; the rest comes in after it", () => {
  // Revy's case: mine inserted a paragraph and saved it, the base stayed old
  // (something else changed outside), and the disk now has it as theirs too.
  expect(run("A.\n\nB.\n", "A.\n\nMine.\n\nB.\n", "A.\n\nMine.\n\nB.\n", "Mine")).toEqual([]);
  expect(run("A.\n\nB.\n", "A.\n\nMine.\n\nB.\n", "A.\n\nMine.\n\nTheirs.\n\nB.\n", "Mine")).toEqual([
    "apply [] -> [Theirs.]",
  ]);
  // And with another outside change elsewhere, which comes in too.
  expect(run("A.\n\nB.\n\nC.\n", "A.\n\nMine.\n\nB.\n\nC.\n", "A.\n\nMine.\n\nB.\n\nC, theirs.\n", "Mine")).toEqual([
    "apply [C.] -> [C, theirs.]",
  ]);
});

test("theirs inserted before a node mine deleted lands where that node was", () => {
  const [b, m, t] = ["A.\n\nB.\n\nC.\n", "A.\n\nC.\n", "A.\n\nX.\n\nB.\n\nC.\n"].map((x) => engine.parse(x));
  const steps = plan(b!, m!, t!, -1);
  expect(steps.map((s) => s.kind)).toEqual(["apply"]);
  // After A, before C: not at the end of the page.
  expect(steps[0]!.from).toBe(m!.child(0).nodeSize);
});

test("edits already on disk aren't news: the base is what was saved (Archy's cases)", () => {
  // (a) Mine edited item 2 and saved it; an agent ticked item 4. The caret
  // is in item 2: item 4 comes in, nothing is held.
  const saved = "- one\n- two, mine\n- three\n- [ ] four\n";
  expect(run(saved, saved, "- one\n- two, mine\n- three\n- [x] four\n", "mine")).toEqual(["unit [four] -> [four]"]);
  // (b) Mine edited P1 and saved it; an agent edited P2 next to it.
  expect(run("P1, mine.\n\nP2.\n", "P1, mine.\n\nP2.\n", "P1, mine.\n\nP2, theirs.\n", "mine")).toEqual([
    "apply [P2.] -> [P2, theirs.]",
  ]);
});

test("theirs inserted after a node, mine deleted the next: right after it (Archy's probe)", () => {
  const [b, m, t] = ["A.\n\nB.\n\nC.\n", "A.\n\nC.\n", "A.\n\nN.\n\nB.\n\nC.\n"].map((x) => engine.parse(x));
  const steps = plan(b!, m!, t!, -1);
  expect(steps.map((s) => [s.kind, s.from])).toEqual([["apply", m!.child(0).nodeSize]]);
});

test("theirs inserted where mine deleted both neighbours: held", () => {
  expect(run("A.\n\nB.\n\nC.\n\nD.\n", "A.\n\nD.\n", "A.\n\nB.\n\nN.\n\nC.\n\nD.\n")).toEqual([
    "hold changed-outside [] against [N.]",
  ]);
});
