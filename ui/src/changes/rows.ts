import type { Block, Hunk, Op } from "@/api";

/**
 * A page's diff as the rows the rendered view draws, top to bottom: HEAD's
 * blocks walked in order, with the server's operations (DiffBlocks, HEAD to
 * now) applied where they anchor. `hunk` is the row's index in the server's
 * hunk list, the one a discard names.
 */
export type Row =
  | { kind: "same"; block: Block }
  | { kind: "added"; block: Block; hunk: number }
  | { kind: "removed"; block: Block; hunk: number }
  /** A replace: HEAD's block, and what took its place. */
  | { kind: "changed"; from: Block; to: Block[]; hunk: number }
  /** Moved here unchanged; `under` is the heading it was under, null at the top. */
  | { kind: "moved"; block: Block; under: string | null; hunk: number };

export function pageRows(head: readonly Block[], ops: readonly Op[], hunks: readonly Hunk[]): Row[] {
  const hunkOf = new Map<number, number>();
  hunks.forEach((h, i) => {
    if (h.kind === "blocks" || h.kind === "move") for (const o of h.ops) hunkOf.set(o, i);
  });
  const at = new Map<number, number>(); // a HEAD block → its replace, delete or move
  const after = new Map<number, number[]>(); // a HEAD block → what's inserted or moved after it
  ops.forEach((o, i) => {
    if (o.op !== "insert") at.set(o.at, i);
    if (o.op === "insert" || o.op === "move") after.set(o.after, [...(after.get(o.after) ?? []), i]);
  });

  const rows: Row[] = [];
  const following = (b: number) => {
    for (const i of after.get(b) ?? []) {
      const o = ops[i]!;
      const hunk = hunkOf.get(i) ?? -1;
      if (o.op === "move") rows.push({ kind: "moved", block: head[o.at]!, under: headingAbove(head, o.at), hunk });
      else if (o.op === "insert") for (const block of o.blocks ?? []) rows.push({ kind: "added", block, hunk });
    }
  };
  following(-1);
  head.forEach((block, b) => {
    const i = at.get(b);
    const o = i === undefined ? undefined : ops[i];
    const hunk = i === undefined ? -1 : (hunkOf.get(i) ?? -1);
    if (!o) rows.push({ kind: "same", block });
    else if (o.op === "replace") rows.push({ kind: "changed", from: block, to: o.blocks ?? [], hunk });
    else if (o.op === "delete") rows.push({ kind: "removed", block, hunk });
    // A move draws nothing at its old place.
    following(b);
  });
  return rows;
}

/** The text of the last heading before HEAD's block `b`, or null. */
function headingAbove(head: readonly Block[], b: number): string | null {
  for (let i = b - 1; i >= 0; i--) {
    const h = head[i]!;
    if (h.kind === "heading") return h.text.replace(/^#+\s*/, "").replace(/\s+#+\s*$/, "").trim();
  }
  return null;
}

/** A run of unchanged rows, folded: "N unchanged blocks". */
export type Fold = { kind: "fold"; rows: Row[] };

/** Rows with every unchanged run folded but the `context` blocks next to a
 *  change. A page with no change folds whole. */
export function withContext(rows: readonly Row[], context = 2): (Row | Fold)[] {
  const out: (Row | Fold)[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== "same") {
      out.push(rows[i++]!);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === "same") j++;
    const keepBefore = i === 0 ? 0 : context; // after a change
    const keepAfter = j === rows.length ? 0 : context; // before a change
    if (j - i <= keepBefore + keepAfter + 1) out.push(...rows.slice(i, j));
    else {
      out.push(...rows.slice(i, i + keepBefore));
      out.push({ kind: "fold", rows: rows.slice(i + keepBefore, j - keepAfter) });
      out.push(...rows.slice(j - keepAfter, j));
    }
    i = j;
  }
  return out;
}
