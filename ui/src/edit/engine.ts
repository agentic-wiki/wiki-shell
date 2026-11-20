import {
  Editor,
  defaultValueCtx,
  editorViewOptionsCtx,
  parserCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  schemaCtx,
  serializerCtx,
} from "@milkdown/core";
import type { Ctx, MilkdownPlugin } from "@milkdown/ctx";
import type { Node, Schema } from "@milkdown/prose/model";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { history } from "@milkdown/plugin-history";
import { $node } from "@milkdown/utils";

/**
 * Milkdown, set up as WikiShell's editor: CommonMark and GFM, parsed and
 * written by remark (the reader's parser), in the house style (`-` bullets,
 * `---` rules), plus the source block.
 */
export interface Engine {
  editor: Editor;
  schema: Schema;
  /** Markdown to a document. */
  parse: (markdown: string) => Node;
  /** A document to Markdown, ending in one line break. */
  serialize: (doc: Node) => string;
}

/**
 * A block the editor can't hold without losing a word (raw HTML, a footnote, a
 * syntax it doesn't know) is a source block: its Markdown, kept as text and
 * written back exactly as typed (editor-adr.md, "the fidelity gate").
 */
export const source = $node("source", () => ({
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  isolating: true,
  parseDOM: [{ tag: "div[data-source]", preserveWhitespace: "full" }],
  toDOM: () => ["div", { "data-source": "" }, 0],
  // Never read from Markdown: the loader makes these, block by block.
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === "source",
    runner: (state, node) => {
      state.addNode("html", undefined, node.textContent);
    },
  },
}));

/**
 * Makes the engine, mounted on `root` (a detached element when headless).
 * `attributes` go on the editable element itself, the one that holds the
 * blocks: the reader's `.markdown` styles only its direct children.
 */
export async function createEngine(
  root: HTMLElement = document.createElement("div"),
  {
    attributes = {},
    plugins = [],
    configure = () => {},
  }: {
    attributes?: Record<string, string>;
    /** The page's views and the editor's behaviour, on top of the Markdown. */
    plugins?: MilkdownPlugin[];
    configure?: (ctx: Ctx) => void;
  } = {},
): Promise<Engine> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, "");
      ctx.update(editorViewOptionsCtx, (o) => ({ ...o, attributes }));
      configure(ctx);
      ctx.update(remarkStringifyOptionsCtx, (o) => ({ ...o, bullet: "-" as const, rule: "-" as const }));
    })
    .use(commonmark)
    .use(gfm)
    .use(source)
    // The user's own steps, undone and redone (editor-adr.md, "Undo").
    // Pasted Markdown is parsed by the editor's views (views.tsx, paste),
    // never drawn into the page first.
    .use(history)
    .use(plugins)
    .create();
  const [parse, serialize, schema] = editor.action((ctx) => [
    ctx.get(parserCtx),
    ctx.get(serializerCtx),
    ctx.get(schemaCtx),
  ]);
  return { editor, schema, parse, serialize };
}
