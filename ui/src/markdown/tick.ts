import type { Entry, Op } from "@/api";
import { spans } from "@/markdown/spans";

/**
 * The operation that ticks or unticks the to-do item on a body line: a replace
 * of the block holding it with exactly the one character between its brackets
 * changed (editor-adr.md, "Ticking a checkbox is a block replace"). Anchored by
 * the block's content, it merges with an outside edit like any other save,
 * where a line number would go stale.
 *
 * The block is the item itself, or a quote or callout the item sits in.
 * Null when no to-do item is on that line, or it is already in that state.
 */
export function tickOp(entry: Pick<Entry, "body" | "blocks">, bodyLine: number, done: boolean): Op | null {
  const where = spans(entry.body, entry.blocks);
  if (!where) return null;
  for (const [i, block] of entry.blocks.entries()) {
    const lines = block.text.split("\n");
    const n = bodyLine - where[i]!.line;
    if (n < 0) return null;
    if (n >= lines.length) continue;
    const box = BOX.exec(lines[n]!);
    if (!box || (box[2] !== " ") === done) return null;
    const mark = box[1]!.length;
    lines[n] = lines[n]!.slice(0, mark) + (done ? "x" : " ") + lines[n]!.slice(mark + 1);
    return { op: "replace", at: i, hash: block.hash, text: lines.join("\n") };
  }
  return null;
}

/** A to-do item's marker and box, up to the character inside the brackets,
 *  inside any number of quote markers. */
const BOX = /^([ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\]/;
