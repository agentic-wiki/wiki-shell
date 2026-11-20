import { beforeAll, expect, test } from "bun:test";
import { history, undo } from "@milkdown/prose/history";
import { EditorState } from "@milkdown/prose/state";
import { createEngine, type Engine } from "@/edit/engine";

let engine: Engine;
beforeAll(async () => {
  engine = await createEngine();
});

// Undo undoes the user's own steps only (editor-adr.md, "Undo"): changes taken
// in from outside are dispatched out of history, and stay.
test("undo reverts the user's text and leaves an outside change", () => {
  let state = EditorState.create({ doc: engine.parse("Mine.\n\nTheirs.\n"), plugins: [history()] });
  state = state.apply(state.tr.insertText(" typed", 6));
  const at = state.doc.child(0).nodeSize + 8;
  state = state.apply(state.tr.insertText(" changed outside", at).setMeta("addToHistory", false));
  undo(state, (tr) => (state = state.apply(tr)));
  expect(engine.serialize(state.doc).trim()).toBe("Mine.\n\nTheirs. changed outside");
});
