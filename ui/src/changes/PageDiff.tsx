import { useMemo, useState, type ReactNode } from "react";
import type { Block, Entry, FileDiff } from "@/api";
import { Discard } from "@/changes/Discard";
import { diffLines } from "@/changes/lines";
import { pageRows, withContext, type Row } from "@/changes/rows";
import { count } from "@/count";
import { Markdown } from "@/markdown/Markdown";

/**
 * A page's diff as the reader draws it (the design's "The rendered diff"):
 * its changed fields, then only its changed blocks, each with two unchanged
 * blocks around it and a fold between. Blocks are drawn by the reader's own
 * Markdown, so a remote image is the same Load chip and loads nothing first.
 * `onDiscard(n)` undoes the server's hunk n; absent, nothing can be discarded.
 */
export function PageDiff({
  diff,
  entry,
  onDiscard,
}: {
  diff: FileDiff & { blocks: NonNullable<FileDiff["blocks"]> };
  /** The page's links, so its links and images resolve as in the reader. */
  entry: Entry;
  onDiscard?: (hunk: number) => Promise<void>;
}) {
  const rows = useMemo(
    () => withContext(pageRows(diff.blocks.head, diff.blocks.ops, diff.hunks)),
    [diff],
  );
  const fieldHunk = (key: string) => diff.hunks.findIndex((h) => h.kind === "field" && h.key === key);
  // Each hunk's Discard sits on its first row.
  const first = new Set<number>();
  return (
    <div className="flex flex-col gap-0.5 py-2">
      {(diff.fields ?? []).map((f) => (
        <Change
          key={f.key}
          mark={f.from == null ? "+" : f.to == null ? "−" : "~"}
          tone={f.from == null ? "added" : f.to == null ? "removed" : "changed"}
          said={f.from == null ? "Added property" : f.to == null ? "Removed property" : "Changed property"}
          discard={onDiscard && fieldHunk(f.key) >= 0 ? () => onDiscard(fieldHunk(f.key)) : undefined}
          question="Discard this change?"
        >
          <p className="font-mono text-[13px]">
            {f.to == null ? (
              <del className="decoration-danger line-through decoration-2">
                {f.key}: {said(f.from)}
              </del>
            ) : f.from == null ? (
              <>
                + {f.key}: {said(f.to)}
              </>
            ) : (
              <>
                {f.key}: <del className="decoration-danger text-muted line-through decoration-2">{said(f.from)}</del> →{" "}
                {said(f.to)}
              </>
            )}
          </p>
        </Change>
      ))}
      {diff.header && !diff.fields?.length && <Layout raw={diff.raw ?? ""} />}
      {rows.map((r, i) => {
        if (r.kind === "fold") return <Fold key={i} rows={r.rows} entry={entry} />;
        if (r.kind === "same") return <Same key={i} block={r.block} entry={entry} />;
        const opens = !first.has(r.hunk);
        first.add(r.hunk);
        const discard = opens && onDiscard && r.hunk >= 0 ? () => onDiscard(r.hunk) : undefined;
        switch (r.kind) {
          case "added":
            return (
              <Change key={i} mark="+" tone="added" said="Added" discard={discard} question="Discard this change?">
                <Rendered block={r.block} entry={entry} />
              </Change>
            );
          case "removed":
            return (
              <Change key={i} mark="−" tone="removed" said="Removed" discard={discard} question="Discard this change?">
                <div className="text-muted line-through">
                  <Rendered block={r.block} entry={entry} />
                </div>
              </Change>
            );
          case "changed":
            return (
              <Change key={i} mark="~" tone="changed" said={`Changed: was ${r.from.text}`} discard={discard} question="Discard this change?">
                <Markdown
                  entry={{ ...entry, body: r.to.map((b) => b.text).join("\n\n"), headings: [], checkboxes: [] }}
                  was={r.from.text}
                />
              </Change>
            );
          case "moved": {
            const from = r.under === null ? "Moved from the top of the page" : `Moved from under '${r.under}'`;
            return (
              <Change key={i} mark="↕" tone="moved" said={from} discard={discard} question="Move it back?">
                <p className="text-faint text-[12px]" aria-hidden>
                  {from}
                </p>
                <Rendered block={r.block} entry={entry} />
              </Change>
            );
          }
        }
      })}
    </div>
  );
}

/** One block, as the reader draws it. A table row has no table to sit in
 *  alone, so it's drawn as its source. */
function Rendered({ block, entry }: { block: Block; entry: Entry }) {
  if (block.kind === "row" || block.kind === "table-head") {
    return <p className="font-mono text-[13px] whitespace-pre-wrap">{block.text}</p>;
  }
  return <Markdown entry={{ ...entry, body: block.text, headings: [], checkboxes: [] }} />;
}

const TONE = {
  added: "border-ok bg-ok/8",
  removed: "border-danger",
  changed: "border-accent",
  moved: "border-faint",
} as const;

/** A changed row: its 3px rule, its gutter mark, what a screen reader hears,
 *  and its hunk's Discard on hover or focus. */
function Change({
  mark,
  tone,
  said,
  discard,
  question,
  children,
}: {
  mark: string;
  tone: keyof typeof TONE;
  said: string;
  discard?: () => Promise<void>;
  question: string;
  children: ReactNode;
}) {
  return (
    <div className={"group/hunk relative grid grid-cols-[20px_minmax(0,1fr)] border-l-3 pr-2 " + TONE[tone]}>
      <span aria-hidden className="text-faint pt-1 text-center font-mono text-[12px] select-none">
        {mark}
      </span>
      <div className="min-w-0 py-1">
        <span className="sr-only">{said}: </span>
        {children}
      </div>
      {discard && (
        // On hover or focus over the change's top right; on a touch screen,
        // which has no hover, always there, on its own line under the change.
        <span className="absolute top-1 right-2 opacity-0 group-hover/hunk:opacity-100 focus-within:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:col-start-2 [@media(hover:none)]:justify-self-end [@media(hover:none)]:pb-1 [@media(hover:none)]:opacity-100">
          <Discard question={question} onDiscard={discard} />
        </span>
      )}
    </div>
  );
}

function Same({ block, entry }: { block: Block; entry: Entry }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] border-l-3 border-transparent pr-2">
      <span />
      <div className="min-w-0 py-1">
        <Rendered block={block} entry={entry} />
      </div>
    </div>
  );
}

/** "N unchanged blocks", opened on click. */
function Fold({ rows, entry }: { rows: Row[]; entry: Entry }) {
  const [open, setOpen] = useState(false);
  if (open) return rows.map((r, i) => r.kind === "same" && <Same key={i} block={r.block} entry={entry} />);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="text-faint hover:text-fg hover:bg-fg/5 mx-5 my-1 rounded-md py-1 text-[12px]"
    >
      {count(rows.length, "unchanged block")}
    </button>
  );
}

/**
 * A header whose layout changed but not its fields: a muted row that unfolds
 * to its raw lines. It has no Discard: Discard changes restores it exactly.
 */
function Layout({ raw }: { raw: string }) {
  const lines = useMemo(() => headerLines(raw), [raw]);
  return (
    <details className="text-muted px-5 py-1 text-[12.5px]" title="Discard changes restores it exactly.">
      <summary className="cursor-pointer">The header's layout changed (order, comments or quoting)</summary>
      <pre className="bg-panel-2 mt-1.5 overflow-x-auto rounded-md p-2 font-mono text-[12px]">
        {lines.map((l, i) => (
          <div key={i} className={l.kind === "add" ? "text-ok" : l.kind === "del" ? "text-danger" : ""}>
            {l.text}
          </div>
        ))}
      </pre>
    </details>
  );
}

/** The raw diff's lines inside the header: its first hunk, when it starts
 *  at line 1, up to the worktree's closing `---`. */
export function headerLines(raw: string) {
  const out = [];
  let fences = 0;
  for (const l of diffLines(raw)) {
    if (l.kind === "hunk") {
      if (l.hunk > 0 || !/^@@ -1[ ,]/.test(l.text)) break;
      continue;
    }
    out.push(l);
    if ((l.kind === "ctx" || l.kind === "add") && l.text.slice(1) === "---" && ++fences === 2) break;
  }
  return out;
}

/** A field's value as a line says it. */
function said(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
