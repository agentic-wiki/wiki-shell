import type { Node } from "@milkdown/prose/model";
import { type EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "@milkdown/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/prose/view";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Entry } from "@/api";
import type { Engine } from "@/edit/engine";
import type { Case } from "@/edit/sync";
import { Markdown } from "@/markdown/Markdown";
import { marked } from "@/markdown/words";

/**
 * Places held for the user to choose (the design's §3, "The three inline
 * conflicts"), and blocks lit because they changed outside WikiShell. A held
 * place is a range of the document, mapped through every edit, with the other
 * version beside it; it is held back from saving (`withTheirs`) until chosen.
 */

export interface Held {
  id: number;
  from: number;
  to: number;
  /** The page's version of the place: empty when it was removed. */
  theirs: Node[];
  case: Case;
  /** No block of the version the editor had is left: the page was rewritten. */
  rewritten?: boolean;
  /** For a place mine deleted: the text it deleted, which theirs is marked against. */
  was?: string;
}

interface Lit {
  from: number;
  to: number;
  until: number;
  /** "Changed" or "Added"; the age is said when it is drawn. */
  label: string;
  at: number;
}

interface State {
  held: Held[];
  lit: Lit[];
}

type Meta =
  | { hold: Omit<Held, "id">[]; light: Omit<Lit, "until" | "at">[]; replace: number[] }
  | { drop: number };

export const conflictsKey = new PluginKey<State>("conflicts");

/** How long a changed block keeps its bar (the design: 60 s). */
const LIT_MS = 60_000;

let nextId = 1;

export interface Choices {
  engine: Engine;
  entry: Entry;
  destination: (bundlePath: string) => string;
  /** Says what happened, politely, to a screen reader. */
  announce: (text: string) => void;
}

export function conflicts(choices: Choices): Plugin<State> {
  return new Plugin<State>({
    key: conflictsKey,
    state: {
      init: () => ({ held: [], lit: [] }),
      apply(tr, prev) {
        const map = (n: number, bias: number) => tr.mapping.map(n, bias);
        let held = prev.held.map((h) => ({ ...h, from: map(h.from, -1), to: map(h.to, 1) }));
        const now = Date.now();
        let lit = prev.lit.filter((l) => l.until > now).map((l) => ({ ...l, from: map(l.from, 1), to: map(l.to, -1) }));
        const meta = tr.getMeta(conflictsKey) as Meta | undefined;
        if (meta && "hold" in meta) {
          held = [...held.filter((h) => !meta.replace.includes(h.id)), ...meta.hold.map((h) => ({ ...h, id: nextId++ }))];
          lit = [...lit, ...meta.light.map((l) => ({ ...l, until: now + LIT_MS, at: now }))];
        } else if (meta && "drop" in meta) {
          held = held.filter((h) => h.id !== meta.drop);
        }
        return { held, lit };
      },
    },
    props: {
      decorations(state) {
        const { held, lit } = conflictsKey.getState(state)!;
        const out: Decoration[] = [];
        for (const l of lit) {
          if (l.to > l.from) {
            state.doc.nodesBetween(l.from, l.to, (node, pos) => {
              if (pos >= l.from && pos + node.nodeSize <= l.to) {
                const said = `${l.label} outside WikiShell, ${ago(l.at)}`;
                out.push(Decoration.node(pos, pos + node.nodeSize, { "data-outside": "", "aria-description": said }));
                // The bar in the margin, which alone says it on hover and focus.
                out.push(Decoration.widget(pos + 1, () => bar(said), { side: -1, key: `bar-${pos}-${l.at}`, ignoreSelection: true }));
              }
              return false;
            });
          } else {
            // Something removed here: a mark in the margin, for a while.
            out.push(Decoration.widget(l.from, () => removedMark(l.at), { side: -1, key: `gone-${l.from}-${l.until}` }));
          }
        }
        for (const h of held) {
          state.doc.nodesBetween(h.from, h.to, (node, pos) => {
            if (pos >= h.from && pos + node.nodeSize <= h.to) out.push(Decoration.node(pos, pos + node.nodeSize, { "data-held": "" }));
            return false;
          });
          out.push(
            Decoration.widget(h.to, (view) => panel(view, h, choices), {
              side: 1,
              key: `held-${h.id}`,
              stopEvent: () => true,
              ignoreSelection: true,
              destroy: (node) => (node as HTMLElement & { unmount?: () => void }).unmount?.(),
            }),
          );
        }
        return DecorationSet.create(state.doc, out);
      },
    },
  });
}

/**
 * Holds places, and lights what changed outside, in one transaction. `replace`
 * names places held already that the new ones take over: the newer version.
 */
export function hold(
  tr: Transaction,
  held: Omit<Held, "id">[],
  light: Omit<Lit, "until" | "at">[],
  replace: number[] = [],
): Transaction {
  return tr.setMeta(conflictsKey, { hold: held, light, replace } satisfies Meta).setMeta("addToHistory", false);
}

/** The places still held. */
export function heldIn(state: EditorState): Held[] {
  return conflictsKey.getState(state)?.held ?? [];
}

/**
 * The document as it would be saved: each held place with the page's version
 * in it, so nothing held is sent.
 */
export function withTheirs(state: EditorState): Node {
  const held = [...heldIn(state)].sort((a, b) => b.from - a.from);
  if (held.length === 0) return state.doc;
  const tr = state.tr;
  for (const h of held) tr.replaceWith(h.from, h.to, h.theirs);
  return tr.doc;
}

/**
 * Settles every place still held as leaving the page does (the design: nothing
 * is lost): both kept, a removed block kept, a deleted one restored.
 */
export function settleAll(view: EditorView): Held[] {
  const held = [...heldIn(view.state)].sort((a, b) => b.from - a.from);
  for (const h of held) choose(view, h, h.case === "both-changed" ? "both" : h.case === "deleted-outside" ? "mine" : "theirs");
  return held;
}

/** Takes the keyboard into the first held place's panel. */
export function toPanel(view: EditorView): boolean {
  const { from } = view.state.selection;
  const h = heldIn(view.state).find((x) => from >= x.from && from <= x.to);
  if (!h) return false;
  const panel = [...view.dom.querySelectorAll("[data-held-panel]")].find((p) => view.posAtDOM(p, 0) >= h.to - 1);
  const first = panel?.querySelector("button");
  if (!first) return false;
  first.focus();
  return true;
}

type Choice = "mine" | "theirs" | "both" | "drop";

function choose(view: EditorView, h: Held, choice: Choice) {
  const tr = view.state.tr.setMeta(conflictsKey, { drop: h.id } satisfies Meta);
  if (choice === "theirs") tr.replaceWith(h.from, h.to, h.theirs);
  else if (choice === "both") tr.insert(h.to, h.theirs);
  else if (choice === "drop") {
    tr.delete(h.from, h.to);
    // The caret goes to the end of the block before.
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, h.from - 1)), -1));
  }
  view.dispatch(tr);
}

const LABELS: Record<Case, string> = {
  "both-changed": "Also changed outside WikiShell, just now.",
  "deleted-outside": "Removed from here outside WikiShell, just now. Keep it?",
  "changed-outside": "You deleted this, but it was changed outside WikiShell meanwhile.",
};

/** The words a screen reader hears when each case happens (the design's §3). */
export const SAID: Record<Case, string> = {
  "both-changed":
    "The paragraph you are editing also changed outside WikiShell. Your text is kept. Press Escape, then Tab, to compare and choose.",
  "deleted-outside":
    "The paragraph you are editing was removed outside WikiShell. Your text is kept. Press Escape, then Tab, to keep it or drop it.",
  "changed-outside":
    "The paragraph you deleted was changed outside WikiShell. Press Escape, then Tab, to restore it or let it go.",
};

const REWRITTEN = "This page was rewritten outside WikiShell.";

const BUTTONS: Record<Case, [string, Choice, string][]> = {
  "both-changed": [
    ["Keep mine", "mine", "Kept yours"],
    ["Use theirs", "theirs", "Used the other version"],
    ["Keep both", "both", "Kept both: the other version is the next block"],
  ],
  "deleted-outside": [
    ["Keep it", "mine", "Kept"],
    ["Drop it", "drop", "Dropped"],
  ],
  "changed-outside": [
    ["Restore it", "theirs", "Restored"],
    ["Let it go", "mine", "Let go"],
  ],
};

/** The panel under a held place: what happened, the other version, the choices. */
function panel(view: EditorView, h: Held, { engine, entry, destination, announce }: Choices): HTMLElement {
  const dom = document.createElement("div");
  dom.contentEditable = "false";
  dom.setAttribute("data-held-panel", "");
  const theirs = h.theirs.length ? engine.serialize(engine.schema.topNodeType.create(null, h.theirs)) : "";
  const mine = h.to > h.from ? view.state.doc.textBetween(h.from, h.to, "\n") : (h.was ?? "");
  const label = h.rewritten ? REWRITTEN : LABELS[h.case];
  const buttons: [string, Choice, string][] = h.rewritten
    ? [
        ["Keep mine", "mine", "Kept yours"],
        ["Discard mine", "drop", "Discarded yours"],
      ]
    : BUTTONS[h.case];
  const root = createRoot(dom);
  (dom as HTMLElement & { unmount?: () => void }).unmount = () => queueMicrotask(() => root.unmount());
  flushSync(() =>
    root.render(
      <div role="group" aria-label={label} className="bg-panel-2 mt-2 rounded-xl px-3.5 py-3 text-[13.5px]">
        <p className="text-faint mb-2 text-[12px]">{label}</p>
        {theirs &&
          (mine ? (
            // Against mine, word by word: what theirs removed struck, what it
            // added underlined, never by colour alone.
            <p className="mb-3 leading-relaxed whitespace-pre-wrap">{marked(mine, h.theirs.map((n) => n.textContent).join("\n"))}</p>
          ) : (
            <div className="mb-3 opacity-90">
              <MemoryRouter>
                <Markdown entry={{ ...entry, body: theirs, headings: [], checkboxes: [] }} destination={destination} />
              </MemoryRouter>
            </div>
          ))}
        <div className="flex flex-wrap gap-2">
          {buttons.map(([label, choice, done]) => (
            <button
              key={label}
              type="button"
              className="bg-elev border-line hover:bg-fg/5 rounded-lg border px-2.5 py-1 font-medium"
              onClick={() => {
                const current = heldIn(view.state).find((x) => x.id === h.id);
                if (!current) return;
                choose(view, current, choice);
                announce(done);
                view.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>,
    ),
  );
  return dom;
}

function bar(said: string): HTMLElement {
  const el = document.createElement("span");
  el.setAttribute("data-outside-bar", "");
  el.contentEditable = "false";
  el.tabIndex = 0;
  el.title = said;
  el.setAttribute("aria-label", said);
  return el;
}

/** Where a block was deleted outside: a line in the margin, a text line
 *  tall, that says so on hover and on focus. */
function removedMark(at: number): HTMLElement {
  const mark = document.createElement("span");
  mark.setAttribute("data-removed", "");
  mark.contentEditable = "false";
  const line = document.createElement("span");
  line.tabIndex = 0;
  line.title = `A block was deleted here outside WikiShell, ${ago(at)}`;
  line.setAttribute("aria-label", line.title);
  mark.append(line);
  return mark;
}

function ago(at: number): string {
  const min = Math.floor((Date.now() - at) / 60_000);
  return min < 1 ? "just now" : `${min} min ago`;
}
