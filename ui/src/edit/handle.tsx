import type { Node } from "@milkdown/prose/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Command } from "@/edit/menus";
import { Glyph } from "@/ui/IconButton";

/**
 * The block handle (the design's §1, "Blocks"): six dots in the left margin, level
 * with a block's first line, on hover, on the block with the caret, and on a
 * block selected from the keyboard (Escape). Click it, or press Enter on a
 * selected block, for its menu: Turn into, Duplicate, Move up, Move down,
 * Delete. Drag it to move the block. ⌘⇧↑ and ⌘⇧↓ move the caret's block.
 *
 * A block is a top-level node, or a list item: what the user sees as one.
 */

export interface HandlePage {
  run: (command: Command) => void;
  announce: (text: string) => void;
}

/** A block in the document: where it is, and what it is. */
interface Block {
  pos: number;
  node: Node;
}

export const handleKey = new PluginKey("handle");

const GRACE_MS = 150;

/** The block around a position: the innermost list item, else the top-level node. */
export function blockAt(doc: Node, pos: number): Block | null {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === "list_item") return { pos: $pos.before(d), node: $pos.node(d) };
  }
  if ($pos.depth === 0) {
    const node = doc.nodeAt(pos);
    return node ? { pos, node } : null;
  }
  return { pos: $pos.before(1), node: $pos.node(1) };
}

/** Moves a block one place up or down among its siblings. */
export function moveBlock(view: EditorView, block: Block, by: -1 | 1): boolean {
  const $pos = view.state.doc.resolve(block.pos);
  const parent = $pos.parent;
  const index = $pos.index();
  const other = index + by;
  if (other < 0 || other >= parent.childCount) return false;
  const sibling = parent.child(other);
  const tr = view.state.tr;
  if (by === -1) {
    const at = block.pos - sibling.nodeSize;
    tr.delete(block.pos, block.pos + block.node.nodeSize).insert(at, block.node);
    tr.setSelection(NodeSelection.create(tr.doc, at));
  } else {
    const after = block.pos + block.node.nodeSize + sibling.nodeSize;
    tr.insert(after, block.node).delete(block.pos, block.pos + block.node.nodeSize);
    tr.setSelection(NodeSelection.create(tr.doc, block.pos + sibling.nodeSize));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Moves a block to before the sibling at `to` (its index among the same parent's children). */
function moveTo(view: EditorView, block: Block, to: number) {
  const $pos = view.state.doc.resolve(block.pos);
  const parent = $pos.parent;
  const from = $pos.index();
  if (to === from || to === from + 1) return;
  const start = $pos.start();
  let at = start;
  for (let i = 0; i < to; i++) at += parent.child(i).nodeSize;
  const tr = view.state.tr.insert(at, block.node);
  const old = tr.mapping.map(block.pos, 1);
  tr.delete(old, old + block.node.nodeSize);
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, tr.mapping.slice(1).map(at))).scrollIntoView());
}

export function blockHandle(page: HandlePage): Plugin {
  return new Plugin({
    key: handleKey,
    props: {
      handleKeyDown(view, e) {
        const mod = e.metaKey || e.ctrlKey;
        // ⌘⇧↑ and ⌘⇧↓: the caret's block moves.
        if (mod && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          const block = selectedBlock(view);
          if (block && moveBlock(view, block, e.key === "ArrowUp" ? -1 : 1)) {
            page.announce(e.key === "ArrowUp" ? "Moved up" : "Moved down");
            return true;
          }
          return false;
        }
        // Escape in the text selects the block the caret is in: the handle
        // lights, and Enter opens its menu.
        if (e.key === "Escape" && view.state.selection instanceof TextSelection) {
          const block = blockAt(view.state.doc, view.state.selection.from);
          if (block) {
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, block.pos)));
            return true;
          }
        }
        if (e.key === "Enter" && !mod && view.state.selection instanceof NodeSelection) {
          handleOf(view)?.openMenu();
          return true;
        }
        return false;
      },
    },
    view(view) {
      const host = document.createElement("div");
      host.setAttribute("data-block-handle", "");
      document.body.append(host);
      const root = createRoot(host);
      let hovered: Block | null = null;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let menu = false;
      // The block a menu is open for: fixed while it is, whatever the pointer
      // or the caret does meanwhile.
      let menuBlock: Block | null = null;
      const setMenu = (open: boolean) => {
        menuBlock = open ? shownBlock() : null;
        menu = open && menuBlock !== null;
        render();
      };
      const handle = { openMenu: () => setMenu(true) };
      handles.set(view, handle);

      const shownBlock = (): Block | null => {
        if (menu && menuBlock) {
          const ok = menuBlock.pos <= view.state.doc.content.size && view.state.doc.nodeAt(menuBlock.pos) === menuBlock.node;
          return ok ? menuBlock : null;
        }
        if (hovered) return hovered;
        const sel = view.state.selection;
        if (!view.hasFocus() && !menu) return null;
        return sel instanceof NodeSelection ? { pos: sel.from, node: sel.node } : blockAt(view.state.doc, sel.from);
      };
      const render = () => {
        const block = shownBlock();
        if (!block || block.pos > view.state.doc.content.size || !view.state.doc.nodeAt(block.pos)) return root.render(null);
        const dom = view.nodeDOM(block.pos);
        if (!(dom instanceof HTMLElement)) return root.render(null);
        const rect = dom.getBoundingClientRect();
        const lit = view.state.selection instanceof NodeSelection && view.state.selection.from === block.pos;
        root.render(
          <Handle
            view={view}
            page={page}
            block={block}
            top={rect.top}
            left={rect.left - 28}
            lit={lit}
            menu={menu}
            onMenu={setMenu}
            onEnter={() => clearTimeout(grace)}
            onLeave={() => leave()}
          />,
        );
      };
      const leave = () => {
        clearTimeout(grace);
        if (menu) return;
        grace = setTimeout(() => {
          hovered = null;
          render();
        }, GRACE_MS);
      };
      const move = (e: MouseEvent) => {
        if (menu) return;
        const el = e.target instanceof Element ? e.target.closest("li, .ProseMirror > *") : null;
        if (!el || !view.dom.contains(el) || el === view.dom) return leave();
        clearTimeout(grace);
        let pos: number;
        try {
          pos = view.posAtDOM(el, 0);
        } catch {
          return;
        }
        const block = blockAt(view.state.doc, el.tagName === "LI" ? pos : pos - 1 < 0 ? 0 : pos - 1);
        if (block && block.pos !== hovered?.pos) {
          hovered = block;
          render();
        }
      };
      const scrolled = () => render();
      view.dom.addEventListener("mousemove", move);
      view.dom.addEventListener("mouseleave", leave);
      document.addEventListener("scroll", scrolled, true);
      return {
        update(view, prev) {
          // A changed page moves blocks: the one hovered is found again on
          // the next pointer move.
          if (!view.state.doc.eq(prev.doc)) hovered = null;
          render();
        },
        destroy() {
          clearTimeout(grace);
          view.dom.removeEventListener("mousemove", move);
          view.dom.removeEventListener("mouseleave", leave);
          document.removeEventListener("scroll", scrolled, true);
          handles.delete(view);
          queueMicrotask(() => root.unmount());
          host.remove();
        },
      };
    },
  });
}

const handles = new WeakMap<EditorView, { openMenu: () => void }>();
const handleOf = (view: EditorView) => handles.get(view);

/** The block the keyboard is on: a selected block, or the caret's. */
function selectedBlock(view: EditorView): Block | null {
  const sel = view.state.selection;
  return sel instanceof NodeSelection ? { pos: sel.from, node: sel.node } : blockAt(view.state.doc, sel.from);
}

/** What the block is now, as the Turn into item that would make it so. */
function kindOf(view: EditorView, block: { node: Node; pos: number }): Command | null {
  const n = block.node;
  switch (n.type.name) {
    case "paragraph":
      return "text";
    case "heading":
      return n.attrs.level <= 3 ? (`h${n.attrs.level}` as Command) : null;
    case "blockquote":
      return "quote";
    case "code_block":
      return "code";
    case "ordered_list":
      return "ordered";
    case "bullet_list":
      return n.firstChild?.attrs.checked != null ? "todo" : "bullet";
    case "list_item":
      if (n.attrs.checked != null) return "todo";
      return view.state.doc.resolve(block.pos).parent.type.name === "ordered_list" ? "ordered" : "bullet";
  }
  return null;
}

const TURN_INTO: [string, Command][] = [
  ["Text", "text"],
  ["Heading 1", "h1"],
  ["Heading 2", "h2"],
  ["Heading 3", "h3"],
  ["Bulleted list", "bullet"],
  ["Numbered list", "ordered"],
  ["To-do list", "todo"],
  ["Quote", "quote"],
  ["Code", "code"],
];

function Handle({
  view,
  page,
  block,
  top,
  left,
  lit,
  menu,
  onMenu,
  onEnter,
  onLeave,
}: {
  view: EditorView;
  page: HandlePage;
  block: Block;
  top: number;
  left: number;
  lit: boolean;
  menu: boolean;
  onMenu: (open: boolean) => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const [drop, setDrop] = useState<number | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const kind = kindOf(view, block);
  useEffect(() => {
    if (menu) first.current?.focus();
  }, [menu]);

  // Where a drag would put the block: before the sibling under the pointer.
  const target = (y: number): { index: number; line: number } | null => {
    const $pos = view.state.doc.resolve(block.pos);
    const parent = $pos.parent;
    let at = $pos.start();
    for (let i = 0; i < parent.childCount; i++) {
      const dom = view.nodeDOM(at);
      if (dom instanceof HTMLElement) {
        const r = dom.getBoundingClientRect();
        if (y < r.top + r.height / 2) return { index: i, line: r.top - 2 };
        if (i === parent.childCount - 1) return { index: i + 1, line: r.bottom + 2 };
      }
      at += parent.child(i).nodeSize;
    }
    return null;
  };

  const act = (fn: () => void, said: string) => {
    fn();
    onMenu(false);
    page.announce(said);
    view.focus();
  };
  const caretIn = () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(block.pos + 1))));
  };

  return (
    <>
      <button
        type="button"
        aria-label="Block menu"
        aria-haspopup="menu"
        aria-expanded={menu}
        title="Click for the block's menu; drag to move it"
        style={{ position: "fixed", top: top + 4, left }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onMenu(!menu)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const startY = e.clientY;
          let moved = false;
          const onMove = (m: PointerEvent) => {
            if (!moved && Math.abs(m.clientY - startY) < 4) return;
            moved = true;
            setDrop(target(m.clientY)?.line ?? null);
          };
          const onUp = (u: PointerEvent) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setDrop(null);
            if (!moved) return;
            const t = target(u.clientY);
            if (t) moveTo(view, block, t.index);
            page.announce("Moved");
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
        className={[
          "z-70 grid h-6 w-4.5 cursor-grab place-items-center rounded select-none",
          lit ? "text-fg bg-fg/6" : "text-faint hover:text-fg",
        ].join(" ")}
      >
        {/* Drawn, not typed: no font has the same dots everywhere. */}
        <Glyph size={18}>
          {[9, 15].flatMap((x) => [6, 12, 18].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r={1.5} fill="currentColor" stroke="none" />))}
        </Glyph>
      </button>
      {drop !== null && (
        <div
          aria-hidden
          style={{ position: "fixed", top: drop, left: left + 28, width: view.dom.clientWidth }}
          className="bg-accent z-70 h-0.5 rounded-full"
        />
      )}
      {menu && (
        <div
          role="menu"
          aria-label="Block"
          style={{ position: "fixed", top: top + 30, left }}
          onMouseEnter={onEnter}
          onKeyDown={(e) => {
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onMenu(false);
              view.focus();
            }
          }}
          className="bg-elev shadow-float animate-wv-in z-80 w-56 rounded-xl p-1 text-[13px]"
        >
          <p className="text-faint px-2.5 pt-1 pb-0.5 text-[11.5px]">Turn into</p>
          {TURN_INTO.map(([label, command], i) => {
            const current = command === kind;
            return (
              <button
                key={label}
                ref={i === 0 ? first : undefined}
                type="button"
                role="menuitem"
                aria-current={current || undefined}
                onClick={() => act(() => (caretIn(), page.run(command)), `Turned into ${label.toLowerCase()}`)}
                className={[
                  "hover:bg-fg/6 focus:bg-fg/6 flex w-full items-center rounded-lg px-2.5 py-1 text-left outline-none",
                  current ? "text-fg" : "text-muted",
                ].join(" ")}
              >
                <span className="flex-1">{label}</span>
                {current && (
                  <Glyph size={14}>
                    <path d="M5 12l5 5L20 7" />
                  </Glyph>
                )}
              </button>
            );
          })}
          <div className="bg-line my-1 h-px" />
          {(
            [
              ["Duplicate", () => view.dispatch(view.state.tr.insert(block.pos + block.node.nodeSize, block.node)), "Duplicated"],
              ["Move up", () => moveBlock(view, block, -1), "Moved up"],
              ["Move down", () => moveBlock(view, block, 1), "Moved down"],
              ["Delete", () => view.dispatch(view.state.tr.delete(block.pos, block.pos + block.node.nodeSize)), "Deleted"],
            ] as [string, () => void, string][]
          ).map(([label, fn, said]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              onClick={() => act(fn, said)}
              className={[
                "hover:bg-fg/6 focus:bg-fg/6 block w-full rounded-lg px-2.5 py-1 text-left outline-none",
                label === "Delete" ? "text-danger" : "",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
