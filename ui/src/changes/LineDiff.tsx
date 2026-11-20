import { useMemo } from "react";
import type { Hunk } from "@/api";
import { Discard } from "@/changes/Discard";
import { diffLines, type DiffLine } from "@/changes/lines";

const LOOK: Record<DiffLine["kind"], string> = {
  hunk: "bg-panel-2 text-faint",
  add: "bg-ok/10",
  del: "bg-danger/10",
  ctx: "text-muted",
  meta: "text-faint",
};

/**
 * A file's raw diff, each line numbered on HEAD's side and the worktree's, as
 * Foreman's review page draws it. With `onDiscard`, each `@@` hunk the server
 * lists has a Discard on its header line.
 */
export function LineDiff({
  raw,
  hunks,
  onDiscard,
}: {
  raw: string;
  hunks: readonly Hunk[];
  onDiscard?: (hunk: number) => Promise<void>;
}) {
  const lines = useMemo(() => diffLines(raw), [raw]);
  // The server's hunk index for the n-th `@@` hunk, when it can be discarded.
  const index = new Map(hunks.flatMap((h, i) => (h.kind === "lines" ? [[h.at, i] as const] : [])));
  if (lines.length === 0) return <p className="text-faint px-3.5 py-2 text-[13px]">No lines changed.</p>;
  return (
    <div className="py-1 font-mono text-[12.5px] leading-[1.6]">
      {lines.map((l, i) => {
        const n = l.kind === "hunk" ? index.get(l.hunk) : undefined;
        return (
          <div key={i} className={`group/hunk grid grid-cols-[40px_40px_minmax(0,1fr)] ${LOOK[l.kind]}`}>
            <span className="text-faint pr-1.5 text-right select-none">{l.old}</span>
            <span className="text-faint pr-1.5 text-right select-none">{l.new}</span>
            <span className="flex items-start gap-2 px-2">
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">
                {l.kind === "add" && <span className="sr-only">Added: </span>}
                {l.kind === "del" && <span className="sr-only">Removed: </span>}
                {l.text || " "}
              </span>
              {n !== undefined && onDiscard && (
                <span className="font-sans opacity-0 group-hover/hunk:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  <Discard question="Discard this change?" onDiscard={() => onDiscard(n)} />
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
