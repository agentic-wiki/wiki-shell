import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EntryStub } from "@/api";

/**
 * The editor's floating chrome (the design's §1): the `/` menu, the link
 * picker and the selection toolbar. All float over the page, never in its
 * flow, and the keyboard drives each.
 */

export interface MenuPage {
  /** The page's path, which a link's address is made relative to. */
  path: string;
  /** The bundle's entries, for the link picker. */
  entries: EntryStub[];
  /** Runs one of the editor's commands. */
  run: (command: Command) => void;
  announce: (text: string) => void;
}

/** What the menus ask of the editor, by name: Editor.tsx maps each to Milkdown. */
export type Command =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "ordered"
  | "todo"
  | "quote"
  | "code"
  | "table"
  | "divider"
  | "bold"
  | "italic"
  | "inlineCode"
  | "strike";

type Open =
  | { kind: "slash"; from: number }
  | { kind: "picker"; from: number; to: number; text: string }
  | { kind: "toolbar"; from: number; to: number }
  | null;

export const menusKey = new PluginKey("menus");

interface Item {
  label: string;
  hint: string;
  glyph: string;
  act: "callout" | "link" | Command;
}

/** The `/` menu's items, in the design's order. */
const ITEMS: Item[] = [
  { label: "Text", hint: "Plain text", glyph: "T", act: "text" },
  { label: "Heading 1", hint: "A big section heading", glyph: "H1", act: "h1" },
  { label: "Heading 2", hint: "A medium heading", glyph: "H2", act: "h2" },
  { label: "Heading 3", hint: "A small heading", glyph: "H3", act: "h3" },
  { label: "Bulleted list", hint: "A simple list", glyph: "•", act: "bullet" },
  { label: "Numbered list", hint: "A list with numbers", glyph: "1.", act: "ordered" },
  { label: "To-do list", hint: "Items to tick", glyph: "☐", act: "todo" },
  { label: "Quote", hint: "A quotation", glyph: "”", act: "quote" },
  { label: "Callout", hint: "A note, tip or warning", glyph: "!", act: "callout" },
  { label: "Code", hint: "A code block", glyph: "</>", act: "code" },
  { label: "Table", hint: "Rows and columns", glyph: "▦", act: "table" },
  { label: "Divider", hint: "A line across", glyph: "—", act: "divider" },
  { label: "Link to an entry", hint: "Pick a page of this wiki", glyph: "↗", act: "link" },
];

export function menus(page: MenuPage): Plugin {
  return new Plugin({
    key: menusKey,
    state: {
      init: (): Open => null,
      apply(tr, open: Open): Open {
        const meta = tr.getMeta(menusKey) as Open | "close" | undefined;
        if (meta === "close") return null;
        if (meta) return meta;
        if (!open) return null;
        if (open.kind === "toolbar") return null;
        const from = tr.mapping.map(open.from);
        return open.kind === "slash" ? { kind: "slash", from } : { ...open, from, to: tr.mapping.map(open.to) };
      },
    },
    props: {
      handleTextInput(view, from, _to, text) {
        const $from = view.state.doc.resolve(from);
        const before = $from.parent.textBetween(0, $from.parentOffset);
        const start = before === "" || /\s$/.test(before);
        if (text === "/" && start && $from.parent.type.name !== "code_block") {
          queueMicrotask(() => view.dispatch(view.state.tr.setMeta(menusKey, { kind: "slash", from })));
        } else if (text === "@" && start) {
          queueMicrotask(() => openPicker(view, from, from + 1));
        } else if (text === "[" && before.endsWith("[")) {
          // `[[` is a habit from other wikis: it opens the picker, and the
          // picker writes a standard link.
          queueMicrotask(() => openPicker(view, from - 1, from + 1));
        }
        return false;
      },
    },
    view(view) {
      const host = document.createElement("div");
      host.setAttribute("data-menus", "");
      document.body.append(host);
      const root = createRoot(host);
      let rest: ReturnType<typeof setTimeout> | undefined;
      let pointerDown = false;
      const down = () => (pointerDown = true);
      const up = () => {
        pointerDown = false;
        toolbarSoon(0);
      };
      // A selection, released: the toolbar, after a short rest for the keyboard.
      const toolbarSoon = (ms: number) => {
        clearTimeout(rest);
        rest = setTimeout(() => {
          const { empty, from, to } = view.state.selection;
          const open = menusKey.getState(view.state) as Open;
          if (!empty && !pointerDown && (!open || open.kind === "toolbar") && view.state.selection instanceof TextSelection) {
            view.dispatch(view.state.tr.setMeta(menusKey, { kind: "toolbar", from, to }));
          }
        }, ms);
      };
      // Escape hides the toolbar, and is the toolbar's alone.
      const escape = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || (menusKey.getState(view.state) as Open)?.kind !== "toolbar") return;
        e.stopPropagation();
        e.preventDefault();
        view.dispatch(view.state.tr.setMeta(menusKey, "close"));
      };
      document.addEventListener("keydown", escape, true);
      view.dom.addEventListener("mousedown", down);
      document.addEventListener("mouseup", up);
      const render = () => {
        const open = menusKey.getState(view.state) as Open;
        if (!open) return root.render(null);
        const at = view.coordsAtPos(open.from);
        if (open.kind === "slash") {
          const query = view.state.doc.textBetween(open.from + 1, view.state.selection.head);
          root.render(<Slash view={view} page={page} from={open.from} query={query} place={place(at)} />);
        } else if (open.kind === "picker") {
          root.render(<Picker view={view} page={page} open={open} place={place(at)} />);
        } else {
          root.render(<Toolbar view={view} page={page} open={open} left={at.left} top={at.top - 40} />);
        }
      };
      return {
        update(view, prev) {
          const open = menusKey.getState(view.state) as Open;
          // The slash menu closes when the caret leaves its word.
          if (open?.kind === "slash") {
            const { head } = view.state.selection;
            const $at = view.state.doc.resolve(open.from);
            const query = head > open.from ? view.state.doc.textBetween(open.from + 1, head) : null;
            if (head <= open.from || head > $at.end() || query === null || /\s\s|^\s/.test(query) || view.state.doc.textBetween(open.from, open.from + 1) !== "/") {
              view.dispatch(view.state.tr.setMeta(menusKey, "close"));
              return;
            }
          }
          if (!view.state.selection.eq(prev.selection) && !view.state.selection.empty) toolbarSoon(300);
          render();
        },
        destroy() {
          clearTimeout(rest);
          document.removeEventListener("keydown", escape, true);
          view.dom.removeEventListener("mousedown", down);
          document.removeEventListener("mouseup", up);
          queueMicrotask(() => root.unmount());
          host.remove();
        },
      };
    },
  });
}

/** Where a menu goes: under the line, or above it when there's more room
 *  there, kept between the header and (on a phone) the tab bar, at most 320
 *  px tall. */
type Place = { position: "fixed"; left: number; top?: number; bottom?: number; maxHeight: number };

const HEADER = 56;
const TAB_BAR = 72;

function place(at: { left: number; top: number; bottom: number }): Place {
  const narrow = window.matchMedia("(max-width: 780px)").matches;
  const below = window.innerHeight - (narrow ? TAB_BAR : 8) - at.bottom - 4;
  const above = at.top - HEADER - 4;
  const left = Math.max(8, Math.min(at.left, window.innerWidth - 300));
  if (below >= 200 || below >= above) return { position: "fixed", left, top: at.bottom + 4, maxHeight: Math.min(320, below) };
  return { position: "fixed", left, bottom: window.innerHeight - at.top + 4, maxHeight: Math.min(320, above) };
}

function openPicker(view: EditorView, from: number, to: number) {
  const text = view.state.doc.textBetween(from, to);
  view.dispatch(view.state.tr.setMeta(menusKey, { kind: "picker", from, to, text } satisfies Open));
}

const close = (view: EditorView) => view.dispatch(view.state.tr.setMeta(menusKey, "close"));

/** The `/` menu: filtered as the user types after the `/`, driven from the text. */
function Slash({ view, page, from, query, place }: { view: EditorView; page: MenuPage; from: number; query: string; place: Place }) {
  const items = useMemo(() => ITEMS.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())), [query]);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  // The keyboard stays in the text: these keys belong to the menu meanwhile.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (items.length ? (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length : 0));
      } else if (e.key === "Enter" && items[active]) {
        e.preventDefault();
        e.stopPropagation();
        pick(items[active]!);
      } else if (e.key === "Escape") {
        // Closed; the `/` stays as text.
        e.preventDefault();
        e.stopPropagation();
        close(view);
      } else if (e.key === " " && items.length === 0) close(view);
    };
    view.dom.addEventListener("keydown", key, true);
    return () => view.dom.removeEventListener("keydown", key, true);
  });
  const listId = "slash-menu";
  useEffect(() => {
    view.dom.setAttribute("aria-controls", listId);
    view.dom.setAttribute("aria-expanded", "true");
    view.dom.setAttribute("aria-activedescendant", items[active] ? `${listId}-${active}` : "");
    return () => {
      for (const a of ["aria-controls", "aria-expanded", "aria-activedescendant"]) view.dom.removeAttribute(a);
    };
  });

  const pick = (item: Item) => {
    const head = view.state.selection.head;
    // The `/` and what was typed after it go; the block becomes the item.
    const tr = view.state.tr.delete(from, head).setMeta(menusKey, "close");
    view.dispatch(tr);
    if (item.act === "callout") return callout(view);
    if (item.act === "link") return openPicker(view, view.state.selection.from, view.state.selection.from);
    page.run(item.act);
    view.focus();
  };

  return (
    <div
      role="listbox"
      id={listId}
      aria-label="Blocks"
      style={place}
      className="bg-elev shadow-float animate-wv-in z-80 w-70 overflow-auto rounded-xl p-1 text-[13px]"
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.length === 0 && <p className="text-faint px-2.5 py-2">No blocks match</p>}
      {items.map((item, i) => (
        <div
          key={item.label}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(item)}
          className={["flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5", i === active ? "bg-fg/6" : ""].join(" ")}
        >
          <span aria-hidden className="text-muted grid size-5 shrink-0 place-items-center text-[11px] font-semibold">
            {item.glyph}
          </span>
          <span className="min-w-0">
            <span className="text-fg block">{item.label}</span>
            <span className="text-faint block truncate text-[11.5px]">{item.hint}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A callout, as the editor holds one for now: its Markdown, opened as source
 * with the caret on its second line (the design's §1b).
 */
function callout(view: EditorView) {
  const { schema } = view.state;
  const { $from } = view.state.selection;
  const text = "> [!note]\n> ";
  const node = schema.nodes.source!.create(null, schema.text(text));
  const depth = $from.depth > 0 ? 1 : 0;
  const start = depth ? $from.before(depth) : $from.pos;
  const end = depth ? $from.after(depth) : $from.pos;
  // An empty block becomes the callout; otherwise it goes after the block.
  const empty = $from.parent.content.size === 0;
  const tr = empty ? view.state.tr.replaceWith(start, end, node) : view.state.tr.insert(end, node);
  const at = (empty ? start : end) + 1 + text.length;
  tr.setSelection(TextSelection.create(tr.doc, at));
  view.dispatch(tr);
  view.focus();
}

/** The link picker: an input, then up to 8 entries, or a web address. */
function Picker({ view, page, open, place }: { view: EditorView; page: MenuPage; open: Extract<Open, { kind: "picker" }>; place: Place }) {
  const [query, setQuery] = useState(open.text.replace(/^(@|\[\[)/, ""));
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selected = view.state.doc.textBetween(open.from, open.to);
  // Over a selection, the selection is the link's text; typed with `@` or
  // `[[`, the trigger is replaced.
  const typed = /^(@|\[\[)/.test(open.text);
  const q = query.trim().toLowerCase();
  const web = /^https?:\/\//i.test(query.trim());
  const found = web
    ? []
    : page.entries
        .filter((e) => !q || [e.label, e.title ?? "", e.path].some((s) => s.toLowerCase().includes(q)))
        .slice(0, 8);
  const options: { label: string; detail: string; href: string; text: string }[] = web
    ? [{ label: `Link to ${query.trim()}`, detail: "", href: query.trim(), text: selected && !typed ? selected : query.trim() }]
    : found.map((e) => ({
        label: e.title || e.label,
        detail: e.path.slice(1),
        href: relative(page.path, e.path),
        text: selected && !typed ? selected : e.title || e.label,
      }));

  const done = (o?: (typeof options)[number]) => {
    const tr = view.state.tr.setMeta(menusKey, "close");
    // Closed without a choice: what was typed into the picker after `@` or
    // `[[` stays, as text after it.
    if (!o && typed && query) tr.insertText(query, open.to);
    if (o) {
      const link = view.state.schema.marks.link!.create({ href: o.href, title: null });
      if (typed || open.from === open.to) {
        tr.replaceWith(open.from, open.to, view.state.schema.text(o.text, [link]));
      } else tr.addMark(open.from, open.to, link);
    }
    view.dispatch(tr);
    view.focus();
  };

  return (
    <div
      role="dialog"
      aria-label="Link to"
      style={place}
      className="bg-elev shadow-float animate-wv-in z-80 w-80 max-w-[92vw] overflow-auto rounded-xl p-1.5 text-[13px]"
    >
      <input
        ref={input}
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls="link-picker"
        aria-activedescendant={options[active] ? `link-picker-${active}` : undefined}
        aria-label="Find an entry, or paste an address"
        placeholder="Find an entry, or paste an address"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (options.length ? (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length : 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            done(options[active]);
          } else if (e.key === "Escape") {
            // What was typed (`@foo`) stays as text.
            e.preventDefault();
            done();
          }
        }}
        className="bg-panel-2 w-full rounded-lg px-2.5 py-1.5"
      />
      <div role="listbox" id="link-picker" className="mt-1">
        {options.map((o, i) => (
          <div
            key={o.href}
            id={`link-picker-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => done(o)}
            onMouseEnter={() => setActive(i)}
            className={["flex cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5", i === active ? "bg-fg/6" : ""].join(" ")}
          >
            <span className="text-fg truncate">{o.label}</span>
            {o.detail && <span className="text-faint min-w-0 truncate font-mono text-[11.5px]">{o.detail}</span>}
          </div>
        ))}
        {options.length === 0 && <p className="text-faint px-2.5 py-1.5">No entry matches</p>}
      </div>
    </div>
  );
}

/** The selection toolbar: bold, italic, code, strike, and Link. */
function Toolbar({ view, page, open, left, top }: { view: EditorView; page: MenuPage; open: Extract<Open, { kind: "toolbar" }>; left: number; top: number }) {
  const buttons: [string, string, Command | "link"][] = [
    ["B", "Bold", "bold"],
    ["I", "Italic", "italic"],
    ["</>", "Code", "inlineCode"],
    ["S", "Strike", "strike"],
    ["Link", "Link", "link"],
  ];
  return (
    <div
      role="toolbar"
      aria-label="Format"
      style={{ position: "fixed", left, top: Math.max(8, top) }}
      onMouseDown={(e) => e.preventDefault()}
      className="bg-elev shadow-float animate-wv-in z-80 flex gap-0.5 rounded-lg p-1 text-[13px]"
    >
      {buttons.map(([glyph, label, act]) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          title={label}
          onClick={() => {
            if (act === "link") return openPicker(view, open.from, open.to);
            page.run(act);
          }}
          className={["hover:bg-fg/6 text-fg rounded-md px-2 py-0.5", act === "bold" ? "font-bold" : act === "italic" ? "italic" : act === "strike" ? "line-through" : ""].join(" ")}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}

/** A bundle path made relative to the page it is written in, `./` first. */
export function relative(from: string, to: string): string {
  const a = from.split("/").slice(1, -1);
  const b = to.split("/").slice(1);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  // Each segment encoded, parentheses too, so a name with a space or a `(`
  // stays one link address.
  const enc = (seg: string) => encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return (up ? "../".repeat(up) : "./") + b.slice(i).map(enc).join("/");
}
