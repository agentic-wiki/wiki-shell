import { afterAll, beforeAll, expect, test } from "bun:test";
import { editorViewCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { createEngine, type Engine } from "@/edit/engine";
import { views } from "@/edit/views";
import { RemoteImages } from "@/markdown/blocks";
import type { Entry } from "@/api";

const entry: Entry = {
  path: "/a.md",
  title: "A",
  type: "",
  frontmatter: {},
  body: "",
  links: [],
  frontmatterRefs: [],
  backlinks: [],
  headings: [],
  checkboxes: [],
  version: "v1",
  blocks: [],
  editable: true,
};

let engine: Engine;
let view: EditorView;
let root: HTMLElement;
beforeAll(async () => {
  root = document.createElement("div");
  document.body.append(root);
  engine = await createEngine(root, { plugins: views({ entry, destination: (p) => "/wiki" + p, images: new RemoteImages() }) });
  view = engine.editor.action((ctx) => ctx.get(editorViewCtx));
});
afterAll(() => {
  engine.editor.destroy();
  root.remove();
});

// Paste goes through ProseMirror's parser, which reads HTML in a detached
// document, and is drawn by the same views as the page: nothing it carries runs.
test("hostile paste stays inert", async () => {
  view.pasteHTML(
    '<p><a href="javascript:alert(1)">click</a> <a href="JaVaScRiPt:alert(2)">two</a> ' +
      '<img src="x" onerror="window.__pwned=1"> <img src="https://evil.example/t.png?u=1" alt="track">' +
      '<script>window.__pwned=2</script></p>',
  );
  await new Promise((r) => setTimeout(r, 0));
  const html = root.innerHTML;
  expect(root.querySelector("a[href^='javascript' i]")).toBeNull();
  expect(root.querySelector("[onerror]")).toBeNull();
  expect(root.querySelector("script")).toBeNull();
  expect(html).not.toContain("evil.example/t.png");
  expect(root.querySelector("[data-remote-image]")?.getAttribute("aria-label")).toBe("Image from evil.example, not loaded: track");
  expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  expect(view.state.doc.textContent).toContain("click");
});
