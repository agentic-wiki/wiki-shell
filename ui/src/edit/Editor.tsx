import { editorViewCtx, editorViewOptionsCtx } from "@milkdown/core";
import {
  createCodeBlockCommand,
  headingIdGenerator,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand, toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import type { CmdKey } from "@milkdown/core";
import { EditorState, NodeSelection, Plugin, TextSelection } from "@milkdown/prose/state";
import { $prose, callCommand } from "@milkdown/utils";
import type { Node } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useToast } from "@/ui/Toast";
import { api, ApiError, type Entry, type EntryStub, type TreeNode } from "@/api";
import { useBundle } from "@/bundle";
import { type Command, menus } from "@/edit/menus";
import { conflicts, type Choices, type Held, heldIn, hold, SAID, settleAll, toPanel, withTheirs } from "@/edit/conflicts";
import { blockHandle } from "@/edit/handle";
import { linkCard } from "@/edit/linkcard";
import { plan, rewritten } from "@/edit/sync";
import { Saver } from "@/edit/save";
import { type Early, registerSaves, type SaveState } from "@/editing";
import { keyOf, load, type Loaded } from "@/edit/blocks";
import { createEngine, type Engine } from "@/edit/engine";
import { headingIds, views } from "@/edit/views";
import { RemoteImages } from "@/markdown/blocks";

/**
 * The page's body as an editor, drawn with the reader's markup so it takes
 * the reader's place with the same pixels (editor-adr.md, "From reader to
 * editor"). Loaded from the page's blocks; `from` skips the hoisted title,
 * which is edited where it sits.
 *
 * It mounts hidden; `onReady` says when it holds the page, and the caller
 * swaps it in for the reader in one frame.
 */
export function Editor({
  entry,
  from,
  title,
  destination,
  onReady,
  onStatus,
  bundle,
  deleted = false,
}: {
  entry: Entry;
  from: number;
  /** The page's title, which names the editor for a screen reader. */
  title: string;
  destination: (bundlePath: string) => string;
  onReady: (editor: Mounted) => void;
  /** The save status, and how to try a failed save again. */
  onStatus: (state: SaveState, retry: () => void) => void;
  /** The bundle's id, which kept text is filed under. */
  bundle: string;
  /** The page was deleted outside: the bar offers to restore it. */
  deleted?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const status = useRef(onStatus);
  status.current = onStatus;
  const navigate = useNavigate();
  const toast = useToast();
  const { tree } = useBundle();
  const go = useRef(navigate);
  go.current = navigate;
  const said = useRef<HTMLDivElement>(null);
  // The page was deleted (or moved) outside: how to put it back.
  const [gone, setGone] = useState<null | { restore: () => Promise<"done" | "back">; back: boolean }>(null);
  // Takes in the page as it now is on disk, once the editor holds it.
  const sync = useRef<((version: string) => void) | null>(null);
  // Says the page is gone, once the editor holds it.
  const goneRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let engine: Engine | null = null;
    let saver: Saver | null = null;
    let current: EditorView | null = null;
    let unregister = () => {};
    let gone = false;
    // Every change to the document is a change to save, once the page is in.
    const changes = $prose(
      () =>
        new Plugin({
          view: () => ({
            update: (view, prev) => {
              if (saver && !view.state.doc.eq(prev.doc)) saver.changed();
              // The status counts what is still held.
              const n = heldIn(view.state).length;
              // A place let go of is a change to save, even when no text moved.
              if (saver && n < heldIn(prev).length) saver.changed();
              if (n !== heldIn(prev).length) {
                status.current(n ? { kind: "conflicts", label: toCheck(view.state), rewritten: false } : { kind: "idle" }, () =>
                  firstHeld(view),
                );
              }
            },
          }),
        }),
    );
    const leave = () => saver?.leave();
    const unsaved = (e: BeforeUnloadEvent) => {
      // The browser's own "Leave site?", the only time it is asked.
      if (saver?.pending) e.preventDefault();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", unsaved);
    const say = (text: string) => {
      if (said.current) said.current.textContent = text;
    };
    // Live changes are said once per burst (changes within 2 s are one), at
    // most every 10 s; changes in that wait join the next (the design's §3).
    let burst = 0;
    let lastSaid = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flushChanges = () => {
      const wait = lastSaid + 10_000 - Date.now();
      if (wait > 0) {
        timer = setTimeout(flushChanges, wait);
        return;
      }
      say(`${burst} ${burst === 1 ? "block" : "blocks"} changed outside WikiShell.`);
      burst = 0;
      lastSaid = Date.now();
    };
    const announce: Announce = Object.assign(say, {
      now: say,
      changes: (n: number) => {
        burst += n;
        clearTimeout(timer);
        timer = setTimeout(flushChanges, 2000);
      },
    });
    const choices: Choices = { engine: null!, entry, destination, announce: say };
    const made_ = () => choices.engine;
    (async () => {
      const made = await createEngine(root.current!, {
        attributes: {
          class: "markdown",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": title,
          spellcheck: "false",
        },
        plugins: [
          ...views({ entry, destination, images: new RemoteImages() }),
          changes,
          $prose(() => conflicts(choices)),
          $prose(() =>
            menus({
              path: entry.path,
              entries: entriesOf(tree),
              run: (command) => run(made_(), command),
              announce: say,
            }),
          ),
          $prose(() => blockHandle({ run: (command) => run(made_(), command), announce: say })),
          $prose(() =>
            linkCard({
              links: new Map(entry.links.map((l) => [l.raw, l])),
              open: (a) => open(a, (to) => go.current(to)),
              navigate: (to) => go.current(to),
              destination,
              announce,
            }),
          ),
        ],
        configure: (ctx) => {
          ctx.set(headingIdGenerator.key, headingIds(entry.headings, from, () => current?.state.doc ?? null));
          ctx.update(editorViewOptionsCtx, (o) => ({
            ...o,
            handleDOMEvents: {
              click: (view, e) => follow(view, e, (to) => go.current(to)),
              // ⌘Enter (Ctrl+Enter) opens the link under the caret: the
              // keyboard's way to follow one.
              keydown: (view, e) => {
                // In a held place: Escape selects its block, and Tab then
                // goes to its panel (the design's §3, "With a screen reader").
                if (e.key === "Escape" && selectHeld(view)) return true;
                if (e.key === "Tab" && !e.shiftKey && view.state.selection instanceof NodeSelection && toPanel(view)) {
                  e.preventDefault();
                  return true;
                }
                if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return false;
                const { node } = view.domAtPos(view.state.selection.from);
                const a = (node instanceof Element ? node : node.parentElement)?.closest("a[href]");
                if (!a) return false;
                e.preventDefault();
                open(a, (to) => go.current(to));
                return true;
              },
              // Leaving the text saves at once.
              blur: () => {
                if (saver?.pending) void saver.flush();
                return false;
              },
            },
          }));
        },
      });
      if (gone) {
        made.editor.destroy();
        return;
      }
      engine = made;
      choices.engine = made;
      const loaded = load(made, entry.body, entry.blocks, from);
      const view = made.editor.action((ctx) => ctx.get(editorViewCtx));
      current = view;
      view.updateState(EditorState.create({ doc: loaded.doc, plugins: view.state.plugins }));
      saver = new Saver({
        bundle,
        path: entry.path,
        from,
        engine: made,
        base: { version: entry.version, blocks: entry.blocks },
        loaded,
        // Held places go with the page's version: nothing held is saved.
        doc: () => withTheirs(view.state),
        api,
        onState: (state) => {
          status.current(state, () => saver?.retry());
          if (state.kind === "gone") setGone({ restore: () => restore(view, made, entry, from), back: false });
        },
      });
      let syncing: Promise<void> | null = null;
      let again = false;
      sync.current = (version) => {
        if (version === saver!.version) return;
        if (syncing) {
          again = true;
          return;
        }
        syncing = takeIn(view, made, saver!, entry.path, from, announce, (s) => {
          status.current(s, () => saver?.retry());
          if (s.kind === "gone") setGone({ restore: () => restore(view, made, entry, from), back: false });
        }).finally(() => {
          syncing = null;
          if (again) {
            again = false;
            sync.current?.("");
          }
        });
      };
      unregister = registerSaves(entry.path, () => saver!.settle());
      goneRef.current = () => setGone({ restore: () => restore(view, made, entry, from), back: false });
      ready.current({ engine: made, loaded, replay: (early) => replay(view, early) });
    })();
    return () => {
      gone = true;
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeunload", unsaved);
      clearTimeout(timer);
      // Going to another page settles what is held as nothing is lost, says
      // so, and saves what is pending, in the background.
      if (current) {
        const settled = settleAll(current);
        if (settled.length) toast(settledSaid(settled, current.state, title));
      }
      saver?.leave();
      unregister();
      sync.current = null;
      engine?.editor.destroy();
    };
    // One editor per page: an entry's later versions reach it as operations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path]);

  // A newer version of the page: what changed outside comes in.
  useEffect(() => sync.current?.(entry.version), [entry.version]);
  // Deleted outside: the bar, with the page as the user last saw it.
  useEffect(() => {
    if (deleted) goneRef.current?.();
  }, [deleted]);

  return (
    <>
      {gone && (
        <div role="status" className="bg-panel-2 text-fg mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-[13px]">
          <span aria-hidden className="bg-warn size-[7px] shrink-0 rounded-full" />
          <span className="flex-1">{gone.back ? "This page is back." : "This page was deleted outside WikiShell."}</span>
          {gone.back ? (
            <button type="button" onClick={() => window.location.reload()} className="text-accent-ink font-medium hover:underline">
              Reload
            </button>
          ) : (
            <>
              <button
                type="button"
                className="text-accent-ink font-medium hover:underline"
                onClick={async () => {
                  const result = await gone.restore();
                  if (result === "back") setGone({ ...gone, back: true });
                  else setGone(null);
                }}
              >
                Restore it
              </button>
              <button type="button" onClick={() => go.current("/wiki/")} className="text-muted font-medium hover:underline">
                Let it go
              </button>
            </>
          )}
        </div>
      )}
      <div ref={root} />
      <div ref={said} aria-live="polite" className="sr-only" />
    </>
  );
}

/**
 * Takes in the page as it now is on disk (the design's §3): saves what is
 * pending first, so the disk holds it, reads the page, and applies what
 * changed outside in one transaction, holding what touches the caret or the
 * user's own changes. The caret's line keeps its place on screen.
 */
async function takeIn(
  view: EditorView,
  engine: Engine,
  saver: Saver,
  path: string,
  from: number,
  announce: Announce,
  onState: (s: SaveState) => void,
) {
  await saver.settle();
  let fresh: Entry;
  try {
    fresh = await api.entry(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) onState({ kind: "gone" });
    return;
  }
  if (fresh.version === saver.version) return;
  const next = load(engine, fresh.body, fresh.blocks, from);
  const state = view.state;
  if (rewritten(saver.baseDoc, next.doc)) {
    const base = saver.baseDoc;
    // The new base first: whatever the dispatch sets off saves against it.
    saver.resync({ version: fresh.version, blocks: fresh.blocks }, next);
    rewrite(view, base, next.doc, announce, onState);
    return;
  }
  const steps = plan(saver.baseDoc, state.doc, next.doc, state.selection.from);
  saver.resync({ version: fresh.version, blocks: fresh.blocks }, next);
  if (steps.length === 0) return;

  const before = view.coordsAtPos(state.selection.from).top;
  const tr = state.tr;
  const lit: { from: number; to: number; label: string }[] = [];
  const held: Parameters<typeof hold>[1] = [];
  // From the end, so each step's positions are still the document's.
  for (const step of [...steps].sort((a, b) => b.from - a.from)) {
    if (step.kind === "hold") {
      held.push({ from: step.from, to: step.to, theirs: step.theirs, case: step.case, was: step.was });
      continue;
    }
    const size = step.nodes.reduce((n, node) => n + node.nodeSize, 0);
    tr.replaceWith(step.from, step.to, step.nodes);
    lit.push({ from: step.from, to: step.from + size, label: step.to > step.from ? "Changed" : "Added" });
  }
  // Positions recorded mid-way are mapped through the steps that came after.
  const mapped = (n: number, i: number, bias: number) => tr.mapping.slice(i).map(n, bias);
  // A place held already, where a newer version of it is held now, gives way.
  const replaced = heldIn(state)
    .filter((old) => held.some((h) => h.from < old.to && old.from < h.to))
    .map((old) => old.id);
  view.dispatch(
    hold(
      tr,
      held.map((h) => ({ ...h, from: tr.mapping.map(h.from, -1), to: tr.mapping.map(h.to, 1) })),
      lit.map((l, i) => ({ ...l, from: mapped(l.from, i + 1, 1), to: mapped(l.to, i + 1, -1) })),
      replaced,
    ),
  );
  // The line being typed on keeps its place on screen.
  const after = view.coordsAtPos(view.state.selection.from).top;
  if (after !== before) scroller(view.dom)?.scrollBy({ top: after - before });

  // A conflict is said at once, in its own words; live changes join the next
  // batch.
  if (held[0]) announce.now(SAID[held[0].case]);
  if (lit.length) announce.changes(lit.length);
  if (heldIn(view.state).length) {
    onState({ kind: "conflicts", label: toCheck(view.state), rewritten: false });
  }
}

/**
 * Writes the page back as the user last saw it: the body with their edits, as
 * a new file that never overwrites one (`POST /api/entries`), then its fields
 * through the server's own writer (`PUT /api/fields`), so nothing loses its
 * quoting (Audy). "back" when a file is at that path again.
 */
async function restore(view: EditorView, engine: Engine, entry: Entry, from: number): Promise<"done" | "back"> {
  const title = from > 0 ? entry.blocks[0]!.text + "\n\n" : "";
  const body = engine.serialize(withTheirs(view.state));
  try {
    await api.createEntry(entry.path, title + body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return "back";
    throw err;
  }
  if (Object.keys(entry.frontmatter).length) await api.setFields(entry.path, entry.frontmatter, {});
  return "done";
}

/**
 * The page was rewritten outside: none of what the editor had is on disk
 * (the design's §3). The disk page is shown, all lit; the blocks with text not
 * saved yet wait where the caret was, each held, for the user to keep (saved
 * into the new page) or discard. Blocks already saved aren't brought back:
 * they are in the changes view.
 */
function rewrite(view: EditorView, base: Node, disk: Node, announce: Announce, onState: (s: SaveState) => void) {
  const state = view.state;
  const saved = new Set<string>();
  base.forEach((n) => saved.add(keyOf(n)));
  const unsaved: Node[] = [];
  let caretAt = 0;
  state.doc.forEach((n, offset, i) => {
    if (!saved.has(keyOf(n))) unsaved.push(n);
    if (state.selection.from >= offset) caretAt = i;
  });
  const theirs: Node[] = [];
  disk.forEach((n) => theirs.push(n));
  const at = Math.min(caretAt, theirs.length);
  const nodes = [...theirs.slice(0, at), ...unsaved, ...theirs.slice(at)];
  const tr = state.tr.replaceWith(0, state.doc.content.size, nodes);
  // Where each node is now, to light the disk's and hold the user's.
  const lit: { from: number; to: number; label: string }[] = [];
  const held: Parameters<typeof hold>[1] = [];
  let pos = 0;
  nodes.forEach((n, i) => {
    const mine = i >= at && i < at + unsaved.length;
    if (mine) held.push({ from: pos, to: pos + n.nodeSize, theirs: [], case: "both-changed", rewritten: true });
    else lit.push({ from: pos, to: pos + n.nodeSize, label: "Changed" });
    pos += n.nodeSize;
  });
  const caret = held[0] ? held[0].to - 1 : 0;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size)), -1));
  view.dispatch(hold(tr, held, lit, heldIn(state).map((h) => h.id)));
  announce.now("This page was rewritten outside WikiShell." + (held.length ? " Your text not saved yet is kept where you were." : ""));
  onState(held.length ? { kind: "conflicts", label: "This page was rewritten outside WikiShell", rewritten: true } : { kind: "idle" });
}

/** Runs a menu's command on the editor, through Milkdown's own commands. */
function run(engine: Engine, command: Command) {
  const call = <T,>(key: CmdKey<T>, payload?: T) => engine.editor.action(callCommand(key, payload));
  switch (command) {
    case "text":
      return call(turnIntoTextCommand.key);
    case "h1":
    case "h2":
    case "h3":
      return call(wrapInHeadingCommand.key, Number(command[1]));
    case "bullet":
      return call(wrapInBulletListCommand.key);
    case "ordered":
      return call(wrapInOrderedListCommand.key);
    case "todo": {
      call(wrapInBulletListCommand.key);
      // The item it made, as a to-do.
      const view = engine.editor.action((ctx) => ctx.get(editorViewCtx));
      const { $from } = view.state.selection;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === "list_item") {
          view.dispatch(view.state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, checked: false }));
          break;
        }
      }
      return;
    }
    case "quote":
      return call(wrapInBlockquoteCommand.key);
    case "code":
      return call(createCodeBlockCommand.key);
    case "table":
      return call(insertTableCommand.key, { row: 3, col: 2 });
    case "divider":
      return call(insertHrCommand.key);
    case "bold":
      return call(toggleStrongCommand.key);
    case "italic":
      return call(toggleEmphasisCommand.key);
    case "inlineCode":
      return call(toggleInlineCodeCommand.key);
    case "strike":
      return call(toggleStrikethroughCommand.key);
  }
}

/** Every entry of the bundle, for the link picker. */
function entriesOf(tree: TreeNode): EntryStub[] {
  return [...tree.entries, ...tree.children.flatMap(entriesOf)];
}

/** The announcer: `now` for what is said at once, `changes` for live
 *  changes, said in batches. */
type Announce = ((text: string) => void) & { now: (text: string) => void; changes: (n: number) => void };

/** Selects the block of the held place the caret is in. */
function selectHeld(view: EditorView): boolean {
  const { from } = view.state.selection;
  const h = heldIn(view.state).find((x) => from >= x.from && from <= x.to && x.to > x.from);
  if (!h) return false;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, h.from)));
  return true;
}

/** What leaving the page did with the places held (the design's §3). */
function settledSaid(held: Held[], state: EditorState, title: string): string {
  const kind = (h: Held) => KINDS[(h.theirs[0] ?? state.doc.nodeAt(h.from))?.type.name ?? ""] ?? "block";
  const n = (c: Held["case"]) => held.filter((h) => h.case === c);
  const counted = (hs: Held[]) => `${hs.length} ${kind(hs[0]!)}${hs.length === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (n("both-changed").length) parts.push(`Kept both versions of ${counted(n("both-changed"))} in ${title}.`);
  if (n("deleted-outside").length) parts.push(`Kept ${counted(n("deleted-outside"))} that was removed outside WikiShell, in ${title}.`);
  if (n("changed-outside").length) parts.push(`Restored ${counted(n("changed-outside"))} changed outside WikiShell, in ${title}.`);
  return parts.join(" ");
}

/**
 * What the save status says is held, by kind: "1 paragraph to check",
 * "2 table rows to check", "3 changes to check" when they're of more than one.
 */
function toCheck(state: EditorState): string {
  const kinds = heldIn(state).map((h) => {
    // A place mine deleted is named by the version that was changed outside.
    const node = h.to > h.from ? state.doc.nodeAt(h.from) : h.theirs[0];
    return KINDS[node?.type.name ?? ""] ?? "block";
  });
  const n = kinds.length;
  const one = kinds.every((k) => k === kinds[0]) ? kinds[0]! : null;
  return one ? `${n} ${one}${n === 1 ? "" : "s"} to check` : `${n} changes to check`;
}

const KINDS: Record<string, string> = {
  paragraph: "paragraph",
  heading: "heading",
  bullet_list: "list",
  ordered_list: "list",
  list_item: "list item",
  table: "table",
  table_row: "table row",
  code_block: "code block",
  blockquote: "quote",
};

/** Takes the caret to the first place held, and shows it. */
function firstHeld(view: EditorView) {
  const first = [...heldIn(view.state)].sort((a, b) => a.from - b.from)[0];
  if (!first) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(first.from))).scrollIntoView());
  view.focus();
}

/** The element that scrolls the page the editor is in. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement as HTMLElement | null;
}

/** An editor holding a page. */
export interface Mounted {
  engine: Engine;
  loaded: Loaded;
  /** Puts the caret where the reader was clicked and types what was held.
   *  Called once the editor is on screen, where positions mean something. */
  replay: (early: Early) => void;
}

function replay(view: EditorView, early: Early) {
  if (!early.point) return;
  const at = view.posAtCoords({ left: early.point.x, top: early.point.y });
  if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
  view.focus();
  for (const key of early.keys) {
    if (key === "Enter" || key === "Backspace") {
      const e = new KeyboardEvent("keydown", { key });
      view.someProp("handleKeyDown", (f) => f(view, e));
    } else {
      const { from, to } = view.state.selection;
      if (!view.someProp("handleTextInput", (f) => f(view, from, to, key, () => view.state.tr.insertText(key, from, to)))) {
        view.dispatch(view.state.tr.insertText(key, from, to));
      }
    }
  }
}

/**
 * A click on a link follows it, as in the reader: a browser doesn't follow a
 * link inside editable text. A modified click (a new tab) is the browser's.
 * True when it was a link, so the editor leaves the click alone.
 */
function follow(_view: EditorView, e: MouseEvent, navigate: (to: string) => void): boolean {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!a || a.closest("[data-source-text]")) return false;
  e.preventDefault();
  open(a, navigate);
  return true;
}

/** Follows a link the editor drew: a bundle path through the app's router. */
function open(a: Element, navigate: (to: string) => void) {
  const href = a.getAttribute("href")!;
  if (a.hasAttribute("data-route")) navigate(href);
  else if (a.getAttribute("target") === "_blank") window.open(href, "_blank", "noopener,noreferrer");
  else window.location.assign(href);
}
