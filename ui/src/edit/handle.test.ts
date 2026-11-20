import { beforeAll, expect, test } from "bun:test";
import { EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { createEngine, type Engine } from "@/edit/engine";
import { blockAt, moveBlock } from "@/edit/handle";

let engine: Engine;
beforeAll(async () => {
  engine = await createEngine();
});

/** Just enough of a view to dispatch to. */
function viewOf(markdown: string) {
  const view = { state: EditorState.create({ doc: engine.parse(markdown) }) } as unknown as EditorView & { state: EditorState };
  (view as { dispatch: (tr: unknown) => void }).dispatch = (tr) => {
    (view as { state: EditorState }).state = view.state.apply(tr as never);
  };
  return view;
}

const text = (v: EditorView) => engine.serialize(v.state.doc).trim();

test("a block moves up and down among its siblings, and not past the ends", () => {
  const v = viewOf("One.\n\nTwo.\n\nThree.\n");
  const two = blockAt(v.state.doc, v.state.doc.child(0).nodeSize + 1)!;
  expect(two.node.textContent).toBe("Two.");
  expect(moveBlock(v, two, -1)).toBe(true);
  expect(text(v)).toBe("Two.\n\nOne.\n\nThree.");
  expect(moveBlock(v, blockAt(v.state.doc, 1)!, -1)).toBe(false);
  expect(moveBlock(v, blockAt(v.state.doc, 1)!, 1)).toBe(true);
  expect(text(v)).toBe("One.\n\nTwo.\n\nThree.");
});

test("a list item is a block of its own, moved within its list", () => {
  const v = viewOf("- a\n- b\n- c\n");
  let pos = -1;
  v.state.doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text === "c") pos = p;
    return pos < 0;
  });
  const c = blockAt(v.state.doc, pos)!;
  expect(c.node.type.name).toBe("list_item");
  moveBlock(v, c, -1);
  expect(text(v)).toBe("- a\n- c\n- b");
});
