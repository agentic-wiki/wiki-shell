import type { Emphasis, Parent, Root, Text } from "mdast";
import type { Processor } from "unified";
import { matches } from "@/edit/diff";

/**
 * Marks a block's words against what it was, inside the rendered block (the
 * changes view's changed blocks): a run of added words is one `<ins>`, the
 * words removed at one place one `<del>`, each saying "added" or "removed" to
 * a screen reader. Only text runs are compared, so the block keeps its
 * rendering (bold, links, code) and the marks sit on its words. `was` is the
 * block's old Markdown, read by the same parser.
 */
export function remarkWordMarks(this: Processor, was: string) {
  return (tree: Root) => {
    const runs = texts(tree);
    if (runs.length === 0) return;
    // Every word and space of the new block, with the text node it is in.
    const now: { word: string; run: number; added: boolean }[] = [];
    runs.forEach((t, run) => {
      for (const word of t.node.value.split(/(\s+)/)) if (word) now.push({ word, run, added: false });
    });
    const old = texts(this.parse(was) as Root)
      .map((t) => t.node.value)
      .join("")
      .split(/(\s+)/)
      .filter(Boolean);

    // What each new word is, and the words removed before each one.
    const removed = new Map<number, string>();
    let i = 0;
    let j = 0;
    for (const [x, y] of [...matches(old, now.map((w) => w.word)), [old.length, now.length] as [number, number]]) {
      const gone = old.slice(i, x).filter((w) => w.trim());
      if (gone.length) removed.set(j, gone.join(" "));
      for (; j < y; j++) now[j]!.added = now[j]!.word.trim() !== "";
      i = x + 1;
      j = y + 1;
    }
    // A space between two added words of one run joins them in one mark.
    now.forEach((w, k) => {
      const [a, b] = [now[k - 1], now[k + 1]];
      if (!w.word.trim() && a?.added && b?.added && a.run === w.run && b.run === w.run) w.added = true;
    });

    // Each text node becomes its pieces, in place: other nodes keep their
    // positions, which the reader matches headings and checkboxes by.
    const pieces: (Text | Emphasis)[][] = runs.map(() => []);
    const push = (run: number, kind: "same" | "ins" | "del", value: string) => {
      const list = pieces[run]!;
      const last = list.at(-1);
      if (last && kindOf(last) === kind) (last.type === "text" ? last : (last.children[1] as Text)).value += value;
      else list.push(kind === "same" ? { type: "text", value } : mark(kind, value));
    };
    now.forEach((w, k) => {
      const gone = removed.get(k);
      // A space after the removed words, so they never run into what follows.
      if (gone) push(w.run, "del", gone), push(w.run, "same", " ");
      push(w.run, w.added ? "ins" : "same", w.word);
    });
    const tail = removed.get(now.length);
    if (tail) push(runs.length - 1, "del", tail);
    for (let r = runs.length - 1; r >= 0; r--) {
      const { node, parent } = runs[r]!;
      parent.children.splice(parent.children.indexOf(node as never), 1, ...(pieces[r] as never[]));
    }
  };
}

const LOOK = {
  ins: "bg-ok/15 decoration-ok rounded-sm underline decoration-2 underline-offset-2",
  del: "decoration-danger text-muted line-through decoration-2",
};

/** An `<ins>` or `<del>` around `value`, with what a screen reader hears. */
function mark(kind: "ins" | "del", value: string): Emphasis {
  return {
    type: "emphasis",
    data: { hName: kind, hProperties: { className: [LOOK[kind]] } },
    children: [
      { type: "text", value: kind === "ins" ? "added: " : "removed: ", data: { hName: "span", hProperties: { className: ["sr-only"] } } },
      { type: "text", value },
    ],
  };
}

const kindOf = (n: Text | Emphasis) => (n.type === "text" ? "same" : (n.data?.hName as "ins" | "del"));

/** The text nodes of a tree, in reading order, each with its parent. */
function texts(tree: Root): { node: Text; parent: Parent }[] {
  const out: { node: Text; parent: Parent }[] = [];
  const walk = (node: Parent) => {
    for (const child of node.children) {
      if (child.type === "text") out.push({ node: child, parent: node });
      else if ("children" in child) walk(child as Parent);
    }
  };
  walk(tree);
  return out;
}
