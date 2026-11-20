import type { Block } from "@/api";

/** Where a block sits in the body: its byte range and its first line (1-based). */
export interface Span {
  start: number;
  end: number;
  line: number;
}

/**
 * Where each block sits in the body. Blocks and the gaps between them rebuild
 * the body exactly (editor-adr.md, "The block model"), so each block's text is
 * found after the one before it, and its first line counted on the way.
 * Null when they don't rebuild it, which only a page that changed between the
 * two would do.
 */
export function spans(body: string, blocks: readonly Block[]): Span[] | null {
  const out: Span[] = [];
  let at = 0;
  let line = 1;
  for (const block of blocks) {
    const start = body.indexOf(block.text, at);
    // Only blank lines may lie between two blocks.
    if (start < 0 || body.slice(at, start).trim() !== "") return null;
    for (let k = at; k < start; k++) if (body.charCodeAt(k) === 10) line++;
    out.push({ start, end: start + block.text.length, line });
    for (let k = start; k < start + block.text.length; k++) if (body.charCodeAt(k) === 10) line++;
    at = start + block.text.length;
  }
  return out;
}
