import { codeBlockSchema, headingSchema, imageSchema, linkSchema, listItemSchema } from "@milkdown/preset-commonmark";
import { tableSchema } from "@milkdown/preset-gfm";
import { Fragment, type Mark, type Node, Slice } from "@milkdown/prose/model";
import { type Command, Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  goToNextCell,
  isInTable,
} from "@milkdown/prose/tables";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@milkdown/prose/view";
import { parserCtx } from "@milkdown/core";
import { $prose, $view } from "@milkdown/utils";
import type { MilkdownPlugin } from "@milkdown/ctx";
import { common, createLowlight } from "lowlight";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Entry, Heading } from "@/api";
import { source } from "@/edit/engine";
import { ANCHOR, CHECKBOX, HEADING, Image, linkProps, TABLE, RemoteImagesContext, TASK_ITEM, type RemoteImages } from "@/markdown/blocks";
import { imageSource, linkTarget } from "@/markdown/href";
import { Markdown } from "@/markdown/Markdown";
import { tickOp } from "@/markdown/tick";

/**
 * The editor's views of the page's content, drawing the reader's markup kind
 * by kind (editor-adr.md, "Node views draw the reader's exact markup"), so the
 * editor takes the reader's place with the same pixels. The classes come from
 * `markdown/blocks.tsx`, as the reader's do.
 */

/** What the views need to know about the page. */
export interface Page {
  entry: Entry;
  /** Where a link to a bundle path goes, as in the reader. */
  destination: (bundlePath: string) => string;
  /** This page view's remote images, for Load all. */
  images: RemoteImages;
}

export function views(page: Page): MilkdownPlugin[] {
  const links = new Map(page.entry.links.map((l) => [l.raw, l]));
  return [
    // Each heading takes the server's id, in order; a new one, the slug rule's,
    // until the next save brings the server's.
    $view(headingSchema.node, () => (node) => headingView(node)),
    $view(linkSchema.mark, () => (mark) => linkView(mark, links, page.destination)),
    $view(imageSchema.node, () => (node) => imageView(node, links, page.images)),
    $view(listItemSchema.node, () => (node, view, getPos) => itemView(node, view, getPos)),
    $view(codeBlockSchema.node, () => (node) => codeView(node)),
    $view(tableSchema.node, () => (_node, view, getPos) => tableView(view, getPos)),
    $view(source, () => (node, view, getPos) => sourceView(node, view, getPos, page)),
    highlight,
    sourceFocus,
    caretBlock,
    tableCaret,
    paste(links),
  ];
}

/**
 * What is pasted (Audy's M-1). Text is parsed as Markdown straight into the
 * editor's nodes: Milkdown's own clipboard drew it into the live page first,
 * which loaded a remote image before Load. HTML is read by ProseMirror in a
 * detached document. Either way, a link to an address the link rule refuses
 * keeps its text and loses its address, so the file never carries it; and an
 * image doesn't gain its alt text as a title.
 */
function paste(links: ReadonlyMap<string, Entry["links"][number]>) {
  return $prose(
    (ctx) =>
      new Plugin({
        props: {
          clipboardTextParser(text, $context) {
            const doc = ctx.get(parserCtx)(text);
            const slice = Slice.maxOpen(doc.content);
            return $context.parent.type.spec.code ? new Slice(Fragment.from(doc.type.schema.text(text)), 0, 0) : slice;
          },
          transformPasted(slice) {
            return new Slice(clean(slice.content, links), slice.openStart, slice.openEnd);
          },
        },
      }),
  );
}

function clean(fragment: Fragment, links: ReadonlyMap<string, Entry["links"][number]>): Fragment {
  const out: Node[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const marks = node.marks.filter((m) => m.type.name !== "link" || linkTarget(m.attrs.href, links).kind !== "text");
      out.push(marks.length === node.marks.length ? node : node.mark(marks));
    } else if (node.type.name === "image" && node.attrs.title && node.attrs.title === node.attrs.alt) {
      out.push(node.type.create({ ...node.attrs, title: "" }));
    } else {
      out.push(node.copy(clean(node.content, links)));
    }
  });
  return Fragment.from(out);
}

/**
 * Marks the text block holding the caret: the one place spaces show as typed
 * (index.css) and spelling is checked, so a page never fills with squiggles.
 */
const caretBlock = $prose(
  () =>
    new Plugin({
      props: {
        decorations(state) {
          const { $from } = state.selection;
          if (!$from.parent.isTextblock || $from.depth === 0) return null;
          const at = $from.before();
          return DecorationSet.create(state.doc, [
            Decoration.node(at, at + $from.parent.nodeSize, { "data-caret": "", spellcheck: "true" }),
          ]);
        },
      },
    }),
);

/** Marks the source block holding the caret, which then shows its Markdown. */
const sourceFocus = $prose(
  () =>
    new Plugin({
      props: {
        decorations(state) {
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === "source") {
              const at = $from.before(d);
              return DecorationSet.create(state.doc, [Decoration.node(at, at + node.nodeSize, { "data-editing": "" })]);
            }
          }
          return null;
        },
      },
    }),
);

/**
 * A heading's id, as the server gave it (`entry.headings`, in page order;
 * `skip` of them are above the editor, the hoisted title): the k-th heading
 * takes the server's k-th id while its text is the same, so two headings with
 * one text keep the server's two ids. A heading that moved takes the first
 * server id for its text; a new one, the slug rule's until the next save.
 */
export function headingIds(headings: readonly Heading[], skip: number, doc: () => Node | null): (node: Node) => string {
  return (node) => {
    const text = node.textContent;
    let k = -1;
    let seen = 0;
    doc()?.descendants((n) => {
      if (k >= 0) return false;
      if (n === node) k = seen;
      else if (n.type.name === "heading") seen++;
      return n.type.name !== "heading";
    });
    const there = headings[skip + k];
    if (k >= 0 && there?.text === text) return there.id;
    return headings.find((h) => h.text === text)?.id ?? slug(text);
  };
}

/** The slug rule for a heading the server hasn't seen yet. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function headingView(node: Node): NodeView {
  const level = Math.min(Math.max(Number(node.attrs.level) || 1, 1), 6);
  const dom = document.createElement("h" + level);
  dom.className = HEADING;
  if (node.attrs.id) dom.id = node.attrs.id;
  const contentDOM = document.createElement("span");
  dom.append(contentDOM);
  if (node.attrs.id) {
    const anchor = document.createElement("a");
    anchor.href = "#" + node.attrs.id;
    anchor.setAttribute("aria-label", "Link to this section");
    anchor.contentEditable = "false";
    anchor.className = ANCHOR;
    anchor.textContent = "#";
    dom.append(anchor);
  }
  return { dom, contentDOM, ignoreMutation: (m) => !contentDOM.contains(m.target) };
}

function linkView(mark: Mark, links: ReadonlyMap<string, Entry["links"][number]>, destination: (p: string) => string) {
  const p = linkProps(linkTarget(mark.attrs.href, links), destination, mark.attrs.title || undefined);
  const dom = document.createElement(p.tag);
  if (p.href) dom.setAttribute("href", p.href);
  if (p.route) dom.setAttribute("data-route", "");
  if (p.newTab) {
    dom.setAttribute("target", "_blank");
    dom.setAttribute("rel", "noopener noreferrer");
  }
  if (p.className) dom.className = p.className;
  if (p.title) dom.title = p.title;
  return { dom };
}

/** An image, drawn by the reader's own component: a remote one is the Load
 *  chip, with no address in the DOM until clicked. */
function imageView(node: Node, links: ReadonlyMap<string, Entry["links"][number]>, images: RemoteImages): NodeView {
  const dom = document.createElement("span");
  dom.contentEditable = "false";
  const root = createRoot(dom);
  // At once, so the editor is complete when it says it's ready to take the
  // reader's place.
  flushSync(() =>
    root.render(
      <RemoteImagesContext value={images}>
        <Image source={imageSource(node.attrs.src, links)} alt={node.attrs.alt ?? ""} title={node.attrs.title || undefined} />
      </RemoteImagesContext>,
    ),
  );
  return {
    dom,
    // The chip's buttons are its own; the editor doesn't take their clicks.
    stopEvent: (e) => e.target instanceof Element && e.target.closest("button") !== null,
    ignoreMutation: () => true,
    destroy: () => unmount(root),
  };
}

/** A list item; a to-do has the reader's box, which ticks on click. */
function itemView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement("li");
  dom.setAttribute("data-spread", String(node.attrs.spread));
  if (node.attrs.checked === null || node.attrs.checked === undefined) {
    return { dom, contentDOM: dom };
  }
  const done = Boolean(node.attrs.checked);
  dom.className = TASK_ITEM;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = done;
  box.className = CHECKBOX;
  box.contentEditable = "false";
  box.setAttribute("aria-label", node.textContent);
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("change", () => {
    const pos = getPos();
    if (pos === undefined) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !done }));
  });
  const contentDOM = document.createElement("span");
  // Only the item's own text is struck, not its nested list (index.css).
  if (done) contentDOM.setAttribute("data-done", "");
  dom.append(box, contentDOM);
  return {
    dom,
    contentDOM,
    stopEvent: (e) => e.target === box,
    ignoreMutation: (m) => m.target === box || m.target === dom,
  };
}

function codeView(node: Node): NodeView {
  const dom = document.createElement("pre");
  const contentDOM = document.createElement("code");
  contentDOM.className = "hljs" + (node.attrs.language ? " language-" + node.attrs.language : "");
  dom.append(contentDOM);
  return { dom, contentDOM };
}

/**
 * A table, scrolled by its wrapper as the reader's is, with its controls
 * floating above it, on hover or with the caret in it: rows and columns added
 * and deleted where the caret is (or at the end).
 */
function tableView(view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement("div");
  dom.setAttribute("data-table", "");
  const scroll = document.createElement("div");
  scroll.className = TABLE;
  const table = document.createElement("table");
  const contentDOM = document.createElement("tbody");
  table.append(contentDOM);
  scroll.append(table);
  const controls = document.createElement("div");
  controls.contentEditable = "false";
  controls.setAttribute("data-table-controls", "");
  controls.setAttribute("role", "toolbar");
  controls.setAttribute("aria-label", "Table");
  const actions: [string, Command][] = [
    ["Row above", addRowBefore],
    ["Row below", addRowAfter],
    ["Column left", addColumnBefore],
    ["Column right", addColumnAfter],
    ["Delete row", deleteRow],
    ["Delete column", deleteColumn],
  ];
  for (const [label, command] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      // Where the caret is in this table, or else its last cell.
      if (!isInTable(view.state)) {
        const pos = getPos();
        if (pos === undefined) return;
        const end = pos + view.state.doc.nodeAt(pos)!.nodeSize - 3;
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)));
      }
      command(view.state, view.dispatch);
      view.focus();
    });
    controls.append(button);
  }
  dom.append(controls, scroll);
  return {
    dom,
    contentDOM,
    stopEvent: (e) => controls.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => !contentDOM.contains(m.target),
  };
}

/** Marks the table holding the caret, which then shows its controls; and Tab
 *  in its last cell adds a row, as in a spreadsheet. */
const tableCaret = $prose(
  () =>
    new Plugin({
      props: {
        decorations(state) {
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === "table") {
              const at = $from.before(d);
              return DecorationSet.create(state.doc, [Decoration.node(at, at + $from.node(d).nodeSize, { "data-caret-in": "" })]);
            }
          }
          return null;
        },
        handleKeyDown(view, e) {
          if (e.key !== "Tab" || e.shiftKey || !isInTable(view.state)) return false;
          if (goToNextCell(1)(view.state)) return false;
          addRowAfter(view.state, view.dispatch);
          goToNextCell(1)(view.state, view.dispatch);
          return true;
        },
      },
    }),
);

/**
 * A source block: at rest, the reader's rendering of its Markdown; with the
 * caret in it, the Markdown itself, under "Edited as Markdown" (the design's
 * "Blocks the editor can't model").
 */
function sourceView(node: Node, view: EditorView, getPos: () => number | undefined, page: Page): NodeView {
  const dom = document.createElement("div");
  dom.setAttribute("data-source", "");
  const shown = document.createElement("div");
  shown.contentEditable = "false";
  shown.setAttribute("data-source-shown", "");
  const label = document.createElement("div");
  label.contentEditable = "false";
  label.className = "text-faint mb-1 text-[11.5px]";
  label.textContent = "Edited as Markdown";
  const contentDOM = document.createElement("pre");
  contentDOM.setAttribute("data-source-text", "");
  dom.append(shown, label, contentDOM);
  const root = createRoot(shown);
  // The page's to-do boxes on this block's lines, as the reader has them: the
  // block's first line is found in the page as it was loaded.
  const at = page.entry.body.indexOf(node.textContent);
  const first = at < 0 ? -1 : page.entry.body.slice(0, at).split("\n").length;
  const boxes = (text: string) => {
    const lines = text.split("\n").length;
    return page.entry.checkboxes
      .filter((c) => first > 0 && c.bodyLine >= first && c.bodyLine < first + lines)
      .map((c) => ({ ...c, bodyLine: c.bodyLine - first + 1 }));
  };
  // The page's link definitions, which draw nothing, so a reference link in
  // this block resolves as in the reader.
  const definitions = page.entry.body
    .split("\n")
    .filter((l) => /^ {0,3}\[[^\]^][^\]]*\]:/.test(l))
    .map((l) => "\n\n" + l)
    .join("");
  // A tick flips the box in the block's Markdown, as any edit of it would.
  const tick = (bodyLine: number, done: boolean) => {
    const pos = getPos();
    if (pos === undefined) return;
    const op = tickOp({ body: node.textContent, blocks: [{ kind: "quote", text: node.textContent, hash: "" }] }, bodyLine, done);
    if (!op || op.op !== "replace" || op.text === undefined) return;
    view.dispatch(view.state.tr.replaceWith(pos + 1, pos + node.nodeSize - 1, view.state.schema.text(op.text)));
  };
  const render = (text: string) =>
    flushSync(() =>
      root.render(
        // The reader's own renderer, on this block alone. It draws router
        // links, so it needs a router of its own: a click on a link is handled
        // by the editor, which follows it through the app's.
        <MemoryRouter>
          <Markdown
            entry={{ ...page.entry, body: text + definitions, headings: [], checkboxes: boxes(text) }}
            destination={page.destination}
            onToggleCheckbox={page.entry.editable ? tick : undefined}
          />
        </MemoryRouter>,
      ),
    );
  render(node.textContent);
  shown.addEventListener("mousedown", (e) => {
    // A click on the rendering opens the source, with the caret at its end;
    // a link or a box keeps its reader behaviour.
    if (e.target instanceof Element && e.target.closest("a, input")) return;
    e.preventDefault();
    const pos = getPos();
    if (pos === undefined) return;
    view.dispatch(view.state.tr.setSelection(selectionAt(view, pos + node.nodeSize - 1)));
    view.focus();
  });
  return {
    dom,
    contentDOM,
    update(next) {
      if (next.type !== node.type) return false;
      if (next.textContent !== node.textContent) render(next.textContent);
      node = next;
      return true;
    },
    stopEvent: (e) => shown.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => !contentDOM.contains(m.target),
    destroy: () => unmount(root),
  };
}

function selectionAt(view: EditorView, pos: number) {
  const Selection = view.state.selection.constructor as typeof import("@milkdown/prose/state").Selection;
  return Selection.near(view.state.doc.resolve(pos), -1);
}

/** Unmounts a root after the current render, which may be the one removing it. */
function unmount(root: Root) {
  queueMicrotask(() => root.unmount());
}

/**
 * Code highlighting as decorations, by the reader's grammars and rule: the
 * block's language when it names one lowlight knows, else detected. Only the
 * code blocks a change touched are highlighted again, and an unlabelled
 * block's language is detected once per text.
 */
const lowlight = createLowlight(common);

/** What the highlighter needs of lowlight. */
export interface Highlighter {
  registered: (lang: string) => boolean;
  highlight: (lang: string, code: string) => unknown;
  highlightAuto: (code: string) => { data?: { language?: string } };
}

interface Lit {
  set: DecorationSet;
  /** The language detected for each unlabelled code block, by where it starts
   *  (mapped through every change); null when none was found. */
  langs: Map<number, string | null>;
}

const highlightKey = new PluginKey<Lit>("highlight");

/** How long typing in a code block rests before its language is detected again. */
const REDETECT_MS = 1000;

export function highlighting(ll: Highlighter = lowlight): Plugin<Lit> {
  // Decorations for the code blocks in [from, to); `fresh` re-detects the
  // unlabelled ones, which otherwise keep the language last found for them.
  const decorate = (doc: Node, from: number, to: number, langs: Map<number, string | null>, fresh: boolean) => {
    const out: Decoration[] = [];
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name !== "code_block") return true;
      const label = node.attrs.language as string;
      if (label && ll.registered(label)) {
        walk(ll.highlight(label, node.textContent) as HastNode, pos + 1, out);
      } else if (fresh || !langs.has(pos)) {
        const auto = ll.highlightAuto(node.textContent);
        langs.set(pos, auto.data?.language ?? null);
        if (auto.data?.language) walk(auto as HastNode, pos + 1, out);
      } else {
        // The language found for it last; none found: plain text, as the
        // reader's detection draws it.
        const lang = langs.get(pos);
        if (lang) walk(ll.highlight(lang, node.textContent) as HastNode, pos + 1, out);
      }
      return false;
    });
    return out;
  };
  return new Plugin<Lit>({
    key: highlightKey,
    state: {
      init: (_, state) => {
        const langs = new Map<number, string | null>();
        return { set: DecorationSet.create(state.doc, decorate(state.doc, 0, state.doc.content.size, langs, true)), langs };
      },
      apply: (tr, prev) => {
        const redetect = tr.getMeta(highlightKey) as number[] | undefined;
        if (!tr.docChanged && !redetect) return prev;
        let set = prev.set.map(tr.mapping, tr.doc);
        const langs = new Map<number, string | null>();
        for (const [pos, lang] of prev.langs) langs.set(tr.mapping.map(pos), lang);
        const ranges: [number, number, boolean][] = (redetect ?? []).map((p) => [p, p + 1, true]);
        tr.mapping.maps.forEach((map, i) =>
          map.forEach((_s, _e, from, to) => {
            const rest = tr.mapping.slice(i + 1);
            ranges.push([rest.map(from, -1), rest.map(to, 1), false]);
          }),
        );
        for (const [from, to, fresh] of ranges) {
          tr.doc.nodesBetween(Math.max(0, from), Math.min(tr.doc.content.size, to), (node, pos) => {
            if (node.type.name !== "code_block") return true;
            const end = pos + node.nodeSize;
            set = set.remove(set.find(pos, end)).add(tr.doc, decorate(tr.doc, pos, end, langs, fresh));
            return false;
          });
        }
        return { set, langs };
      },
    },
    view: () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        update(view, prev) {
          if (view.state.doc.eq(prev.doc)) return;
          // Once typing rests, the unlabelled blocks it touched are detected again.
          clearTimeout(timer);
          timer = setTimeout(() => {
            const touched: number[] = [];
            const { $from } = view.state.selection;
            for (let d = $from.depth; d > 0; d--) {
              const n = $from.node(d);
              if (n.type.name === "code_block" && !(n.attrs.language && ll.registered(n.attrs.language))) touched.push($from.before(d));
            }
            if (touched.length) view.dispatch(view.state.tr.setMeta(highlightKey, touched).setMeta("addToHistory", false));
          }, REDETECT_MS);
        },
        destroy: () => clearTimeout(timer),
      };
    },
    props: {
      decorations(state) {
        return this.getState(state)?.set;
      },
    },
  });
}

const highlight = $prose(() => highlighting());

/** Decorations for a highlighted tree, starting at `at`. */
function walk(tree: HastNode, at: number, out: Decoration[]) {
  const visit = (n: HastNode, classes: string[]) => {
    if (n.type === "text") {
      const end = at + n.value.length;
      if (classes.length) out.push(Decoration.inline(at, end, { class: classes.join(" ") }));
      at = end;
      return;
    }
    const own = n.type === "element" ? ((n.properties?.className as string[] | undefined) ?? []) : [];
    for (const c of n.children ?? []) visit(c, [...classes, ...own]);
  };
  visit(tree, []);
}

type HastNode = {
  type: string;
  value: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};
