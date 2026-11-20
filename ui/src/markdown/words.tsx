import type { ReactNode } from "react";
import { matches } from "@/edit/diff";

/**
 * `now`, marked against `was` word by word: a word only `now` has is
 * underlined (and read as "added"), one only `was` has is struck ("removed").
 * Shared by the editor's conflict panels and the changes view, each with its
 * own colours (`look`): colour is never the only cue, the strike and the
 * underline are.
 */
export function marked(was: string, now: string, look: keyof typeof LOOKS = "conflict"): ReactNode[] {
  const a = was.split(/(\s+)/);
  const b = now.split(/(\s+)/);
  const out: ReactNode[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  const removed = (w: string) => (
    <del key={k++} className={LOOKS[look].removed}>
      <span className="sr-only">removed </span>
      {w}
    </del>
  );
  const added = (w: string) => (
    <ins key={k++} className={LOOKS[look].added}>
      <span className="sr-only">added </span>
      {w}
    </ins>
  );
  for (const [x, y] of [...matches(a, b), [a.length, b.length] as [number, number]]) {
    // A space after each struck word, so it never runs into what follows.
    for (; i < x; i++) if (a[i]!.trim()) out.push(removed(a[i]!), " ");
    for (; j < y; j++) out.push(b[j]!.trim() ? added(b[j]!) : b[j]!);
    if (x < a.length) out.push(b[y]!);
    i = x + 1;
    j = y + 1;
  }
  return out;
}

const LOOKS = {
  conflict: { removed: "text-muted", added: "decoration-accent underline decoration-2 underline-offset-2" },
  diff: {
    removed: "decoration-danger text-muted line-through decoration-2",
    added: "bg-ok/15 decoration-ok rounded-sm underline decoration-2 underline-offset-2",
  },
};
