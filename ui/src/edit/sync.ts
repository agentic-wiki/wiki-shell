import type { Node } from "@milkdown/prose/model";
import { matches } from "@/edit/diff";
import { keyOf, unitsOf } from "@/edit/blocks";

/**
 * What to do with the page as it now is on disk, when it changed outside
 * WikiShell (the CEO's edit model; the design's §3). Three versions of the
 * page's top-level nodes are compared: `base`, the version the editor's
 * document was last saved against; `mine`, the document now; `theirs`, the page
 * on disk now. Where only theirs changed, away from the caret, the change is
 * applied; where only mine did, the next save sends it. Where both did, or
 * theirs changed the node the caret is in, the place is held, as a conflict,
 * for the user to choose.
 *
 * Nodes are compared whole at the top level. Inside the list or table the caret
 * is in, a change that keeps its shape is applied item by item or row by row,
 * the caret's own item never.
 */
export type Step =
  /** Replace mine's top-level nodes [from, to) with theirs' nodes. */
  | { kind: "apply"; from: number; to: number; nodes: Node[] }
  /** Replace one item's own content, or one row, at [from, to). */
  | { kind: "unit"; from: number; to: number; nodes: Node[] }
  /** Hold [from, to) of mine (empty when mine has nothing there) against
   *  theirs' nodes (empty when theirs has nothing there). */
  | { kind: "hold"; from: number; to: number; theirs: Node[]; case: Case; was?: string };

/** The three conflicts (editor-adr.md): both changed the place; theirs
 *  removed what is being typed in; mine removed what they changed. */
export type Case = "both-changed" | "deleted-outside" | "changed-outside";

export function plan(base: Node, mine: Node, theirs: Node, caret: number): Step[] {
  const b = tops(base);
  const m = tops(mine);
  const t = tops(theirs);
  const keys = (xs: Top[]) => xs.map((n) => n.key);
  const mineRuns = runs(matches(keys(b), keys(m)), b.length, m.length);
  const theirRuns = runs(matches(keys(b), keys(t)), b.length, t.length);
  // Where each base node is in mine, when mine kept it.
  const kept = new Map<number, Top>();
  for (const [x, y] of matches(keys(b), keys(m))) kept.set(x, m[y]!);
  // Where an insertion between base nodes a - 1 and a goes in mine (Archy,
  // msg-702): after a - 1 if mine kept it, and after whatever mine inserted
  // there; else before a, if mine kept that; at the start of the page, at the
  // start. Null when mine deleted both: nothing is left to anchor it.
  const before = (a: number): number | null => {
    if (kept.has(a - 1)) {
      const mineThere = mineRuns.find((q) => q.a === a && q.b === a);
      return mineThere && mineThere.d > mineThere.c ? m[mineThere.d - 1]!.to : kept.get(a - 1)!.to;
    }
    if (kept.has(a)) return kept.get(a)!.from;
    return a === 0 ? 0 : null;
  };
  const steps: Step[] = [];
  for (const r of theirRuns) {
    let F = t.slice(r.c, r.d);
    const over = mineRuns.filter((q) => overlaps(r, q));
    if (r.a === r.b) {
      // Both inserted here: what mine inserted, theirs has already (mine,
      // saved, read back); only the rest comes in, after mine's.
      const mineHere = mineRuns.filter((q) => q.a === r.a && q.b === r.a).flatMap((q) => keys(m.slice(q.c, q.d)));
      F = F.filter((n) => {
        const i = mineHere.indexOf(n.key);
        if (i < 0) return true;
        mineHere.splice(i, 1);
        return false;
      });
      if (F.length === 0) continue;
    }
    if (over.length === 0) {
      // Theirs alone: the base nodes it replaced are all still in mine.
      const at = r.a < r.b ? kept.get(r.a)!.from : before(r.a);
      if (at === null) {
        // Inserted where mine deleted both neighbours: held at the place they were.
        const near = [...kept.entries()].filter(([i]) => i < r.a).at(-1)?.[1].to ?? 0;
        steps.push({ kind: "hold", from: near, to: near, theirs: F.map((n) => n.node), case: "changed-outside" });
        continue;
      }
      const from = at;
      const to = r.a < r.b ? kept.get(r.b - 1)!.to : from;
      const caretIn = r.a < r.b && caret >= from && caret <= to;
      if (!caretIn) steps.push({ kind: "apply", from, to, nodes: F.map((n) => n.node) });
      else if (!(r.b - r.a === 1 && F.length === 1 && units(kept.get(r.a)!, F[0]!, caret, steps))) {
        steps.push({ kind: "hold", from, to, theirs: F.map((n) => n.node), case: F.length ? "both-changed" : "deleted-outside" });
      }
      continue;
    }
    // Both changed here: the same change is no change.
    const D = m.slice(Math.min(...over.map((q) => q.c)), Math.max(...over.map((q) => q.d)));
    const a = Math.min(r.a, ...over.map((q) => q.a));
    const z = Math.max(r.b, ...over.map((q) => q.b));
    if (a === r.a && z === r.b && keys(D).join("\0") === keys(F).join("\0")) continue;
    // Mine's span of it: its own nodes there, and the base nodes it kept.
    const spans = [...D, ...range(a, z - 1).flatMap((i) => (kept.has(i) ? [kept.get(i)!] : []))];
    const from = spans.length
      ? Math.min(...spans.map((n) => n.from))
      : (before(z) ?? [...kept.entries()].filter(([i]) => i < z).at(-1)?.[1].to ?? 0);
    const to = spans.length ? Math.max(...spans.map((n) => n.to)) : from;
    const kind: Case = F.length === 0 ? "deleted-outside" : spans.length === 0 ? "changed-outside" : "both-changed";
    // What mine deleted, for theirs to be marked against.
    const was = kind === "changed-outside" ? b.slice(a, z).map((n) => n.node.textContent).join("\n") : undefined;
    steps.push({ kind: "hold", from, to, theirs: F.map((n) => n.node), case: kind, was });
  }
  return steps;
}

/**
 * A side's changes against the base: each run of base nodes [a, b) replaced by
 * that side's nodes [c, d). An insertion has a === b.
 */
interface Run {
  a: number;
  b: number;
  c: number;
  d: number;
}

function runs(pairs: [number, number][], n: number, m: number): Run[] {
  const out: Run[] = [];
  let x = 0;
  let y = 0;
  for (const [i, j] of [...pairs, [n, m] as [number, number]]) {
    if (i > x || j > y) out.push({ a: x, b: i, c: y, d: j });
    x = i + 1;
    y = j + 1;
  }
  return out;
}

/** Whether two runs touch the same base nodes. Two insertions at one place
 *  don't: both are kept, mine first (the CEO's rule). */
function overlaps(r: Run, q: Run): boolean {
  if (r.a < r.b && q.a < q.b) return r.a < q.b && q.a < r.b;
  if (r.a === r.b && q.a === q.b) return false;
  if (r.a === r.b) return q.a < r.a && r.a < q.b;
  return r.a < q.a && q.a < r.b;
}

interface Top {
  node: Node;
  key: string;
  from: number;
  to: number;
}

function tops(doc: Node): Top[] {
  const out: Top[] = [];
  doc.forEach((node, offset) =>
    out.push({ node, key: keyOf(node), from: offset, to: offset + node.nodeSize }),
  );
  return out;
}

/**
 * Theirs' changes inside the list or table holding the caret, unit by unit,
 * when its shape is the same: as many items or rows, of the same kinds, at the
 * same depths. False when it isn't, or the caret's own unit changed.
 */
function units(mine: Top, theirs: Top, caret: number, steps: Step[]): boolean {
  const doc = (top: Top) => top.node.type.schema.topNodeType.create(null, [top.node]);
  const m = unitsOf(doc(mine));
  const t = unitsOf(doc(theirs));
  if (m.length !== t.length || m.some((u, k) => u.kind !== t[k]!.kind || u.depth !== t[k]!.depth)) return false;
  const found: Step[] = [];
  for (const [k, u] of m.entries()) {
    if (u.key === t[k]!.key) continue;
    const from = mine.from + u.from;
    const to = mine.from + u.to;
    if (caret >= from && caret <= to) return false;
    // An item's own content (its paragraphs, not its nested list); a row whole.
    const nodes: Node[] = [];
    if (u.kind === "item") {
      t[k]!.node.forEach((c) => nodes.push(c));
      found.push({ kind: "unit", from: from + 1, to, nodes });
    } else found.push({ kind: "unit", from, to, nodes: [t[k]!.node] });
  }
  steps.push(...found);
  return true;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = from; k <= to; k++) out.push(k);
  return out;
}

/** Whether theirs keeps none of the base's top-level nodes: the page was
 *  rewritten outside (editor-adr.md, "The page rewritten"). */
export function rewritten(base: Node, theirs: Node): boolean {
  const b = tops(base);
  return b.length > 0 && matches(b.map((n) => n.key), tops(theirs).map((n) => n.key)).length === 0;
}
