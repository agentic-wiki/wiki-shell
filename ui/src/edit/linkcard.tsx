import type { Mark, Node } from "@milkdown/prose/model";
import { Plugin } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Link } from "@/api";
import { linkTarget } from "@/markdown/href";

/**
 * The link card (the design's §1 and §1b): with the caret in a link, or after
 * a 500 ms rest of the pointer on one, a small card under it says where it
 * goes, with **Open** (or **Create** for an entry not written yet), **Edit
 * link** and **Remove link**. It is how the keyboard follows a link, since
 * links in editable text are no Tab stops; ⌘Enter does it too.
 */

export interface CardPage {
  links: ReadonlyMap<string, Link>;
  /** Follows a link the way a click on it does. */
  open: (a: Element) => void;
  navigate: (to: string) => void;
  destination: (bundlePath: string) => string;
  announce: (text: string) => void;
}

/** A link in the document: its range, its mark and its text. */
interface At {
  from: number;
  to: number;
  mark: Mark;
  text: string;
}

const REST_MS = 500;
const GRACE_MS = 150;

export function linkCard(page: CardPage): Plugin {
  return new Plugin({
    view(view) {
      const host = document.createElement("div");
      host.setAttribute("data-link-card", "");
      document.body.append(host);
      const root = createRoot(host);
      let shown: At | null = null;
      let byPointer = false;
      let rest: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let announced = "";
      // The link Escape closed the card on: it stays closed until the caret
      // leaves that link.
      let dismissed: number | null = null;

      const show = (at: At | null, pointer: boolean) => {
        if (at && shown && at.from === shown.from && at.to === shown.to) return;
        shown = at;
        byPointer = pointer;
        render();
      };
      const render = () => {
        if (!shown) {
          root.render(null);
          return;
        }
        const el = view.nodeDOM(shown.from) ?? view.domAtPos(shown.from + 1).node;
        const a = (el instanceof Element ? el : el?.parentElement)?.closest("a, span") ?? view.dom;
        const rect = view.coordsAtPos(shown.from);
        root.render(
          <Card
            at={shown}
            anchor={a}
            left={rect.left}
            top={rect.bottom + 6}
            page={page}
            view={view}
            onDone={() => show(null, false)}
            onEnter={() => clearTimeout(grace)}
            onLeave={() => leave()}
          />,
        );
      };
      const leave = () => {
        clearTimeout(grace);
        if (byPointer) grace = setTimeout(() => show(caretLink(view), false), GRACE_MS);
      };
      const over = (e: MouseEvent) => {
        const a = e.target instanceof Element ? e.target.closest("a, span[class]") : null;
        clearTimeout(rest);
        if (!a || !view.dom.contains(a)) return leave();
        clearTimeout(grace);
        rest = setTimeout(() => {
          const pos = view.posAtDOM(a, 0);
          const at = linkAt(view.state.doc, pos);
          if (at) show(at, true);
        }, REST_MS);
      };
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape" && shown) {
          // This Escape is the card's: it goes no further.
          e.stopPropagation();
          e.preventDefault();
          dismissed = shown.from;
          show(null, false);
          // Back to the text from the card; focus already there stays as it is.
          if (!view.hasFocus()) view.focus();
        }
      };
      view.dom.addEventListener("mouseover", over);
      // Wherever focus is (in the card, say): before the editor's own
      // handlers, which may take Escape.
      document.addEventListener("keydown", key, true);
      return {
        update(view) {
          const at = caretLink(view);
          if (at?.from !== dismissed) dismissed = null;
          if (at && at.from === dismissed) return;
          if (at) {
            show(at, false);
            const target = page.links.get(at.mark.attrs.href);
            const label = `Link: ${at.text}, to ${target?.to || hostOf(at.mark.attrs.href)}. Press ${mac() ? "Command" : "Control"} Enter to open.`;
            if (label !== announced) page.announce((announced = label));
          } else if (!byPointer) {
            announced = "";
            show(null, false);
          } else render();
        },
        destroy() {
          view.dom.removeEventListener("mouseover", over);
          document.removeEventListener("keydown", key, true);
          clearTimeout(rest);
          clearTimeout(grace);
          queueMicrotask(() => root.unmount());
          host.remove();
        },
      };
    },
  });
}

function caretLink(view: EditorView): At | null {
  const { empty, from } = view.state.selection;
  return empty ? linkAt(view.state.doc, from) : null;
}

/** The link around a position: the run of text with the same link mark. */
function linkAt(doc: Node, pos: number): At | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const start = $pos.start();
  let mark: Mark | null = null;
  let from = -1;
  let to = -1;
  let text = "";
  let offset = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const a = start + offset;
    const b = a + child.nodeSize;
    const link = child.marks.find((m) => m.type.name === "link");
    if (link && mark && link.eq(mark) && from >= 0 && a === to) {
      to = b;
      text += child.textContent;
    } else if (link && pos >= a && pos <= b) {
      mark = link;
      from = a;
      to = b;
      text = child.textContent;
    } else if (mark && to <= pos) {
      mark = null;
    } else if (mark) break;
    offset += child.nodeSize;
  }
  return mark && pos >= from && pos <= to ? { from, to, mark, text } : null;
}

function Card({
  at,
  anchor,
  left,
  top,
  page,
  view,
  onDone,
  onEnter,
  onLeave,
}: {
  at: At;
  anchor: Element;
  left: number;
  top: number;
  page: CardPage;
  view: EditorView;
  onDone: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const href = at.mark.attrs.href as string;
  const target = linkTarget(href, page.links);
  const missing = target.kind === "entry" && !target.link.exists;
  const [editing, setEditing] = useState<string | null>(null);
  const where = target.kind === "entry" || target.kind === "asset" ? target.link.to : hostOf(href);

  const remove = () => {
    view.dispatch(view.state.tr.removeMark(at.from, at.to, at.mark.type));
    onDone();
    view.focus();
  };
  const save = (next: string) => {
    view.dispatch(view.state.tr.removeMark(at.from, at.to, at.mark.type).addMark(at.from, at.to, at.mark.type.create({ ...at.mark.attrs, href: next })));
    onDone();
    view.focus();
  };
  const create = async () => {
    if (target.kind !== "entry") return;
    await api.createEntry(target.link.to, `# ${at.text}\n`).catch(() => {});
    page.navigate(page.destination(target.link.to));
  };

  return (
    <div
      role="dialog"
      aria-label={`Link to ${where}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: "fixed", left, top }}
      className="bg-elev shadow-float animate-wv-in z-80 flex max-w-[min(420px,92vw)] flex-col gap-1.5 rounded-xl px-3 py-2.5 text-[13px]"
    >
      {missing ? (
        <p className="text-muted">
          No entry at <code className="font-mono">{target.kind === "entry" ? target.link.to.slice(1) : ""}</code> yet.
        </p>
      ) : (
        <p className="text-muted truncate font-mono text-[12px]">{where}</p>
      )}
      {editing === null ? (
        <div className="flex flex-wrap gap-3">
          {missing ? (
            <button type="button" className="text-accent-ink font-medium hover:underline" onClick={create}>
              Create it
            </button>
          ) : (
            target.kind !== "text" &&
            target.kind !== "outside" && (
              <button type="button" className="text-accent-ink font-medium hover:underline" onClick={() => page.open(anchor)}>
                Open
              </button>
            )
          )}
          <button type="button" className="text-fg font-medium hover:underline" onClick={() => setEditing(href)}>
            Edit link
          </button>
          <button type="button" className="text-muted font-medium hover:underline" onClick={remove}>
            Remove link
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(editing);
          }}
        >
          <input
            autoFocus
            aria-label="Link address"
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
            className="bg-panel-2 border-line w-72 max-w-full rounded-md border px-2 py-1 font-mono text-[12.5px]"
          />
        </form>
      )}
    </div>
  );
}

function hostOf(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform);

