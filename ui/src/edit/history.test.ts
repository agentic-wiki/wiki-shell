import { beforeAll, expect, test } from "bun:test";
import { history, undo } from "@milkdown/prose/history";
import { EditorState } from "@milkdown/prose/state";
import { createEngine, type Engine } from "@/edit/engine";
import { replaceChanged } from "@/edit/sync";

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

// An outside change to a block the user typed in is applied as only what
// differs, so the user's typing there stays undoable (editor-undo-outside.md).
test("undo walks back the user's steps through an outside change to the same block", () => {
  let state = EditorState.create({ doc: engine.parse("Mine here.\n\nTheirs.\n"), plugins: [history()] });
  state = state.apply(state.tr.insertText(" typed", 11)); // after "Mine here."
  // Outside, the same paragraph gains a word at its start.
  const theirs = engine.parse("Mine CHANGED here. typed\n\nTheirs.\n");
  const tr = state.tr.setMeta("addToHistory", false);
  replaceChanged(tr, 0, state.doc.child(0).nodeSize, [theirs.child(0)]);
  state = state.apply(tr);
  expect(engine.serialize(state.doc).trim()).toBe("Mine CHANGED here. typed\n\nTheirs.");
  undo(state, (t) => (state = state.apply(t)));
  expect(engine.serialize(state.doc).trim()).toBe("Mine CHANGED here.\n\nTheirs.");
});

test("an outside change applied as what differs gives the same page as replacing it whole", () => {
  const state = EditorState.create({ doc: engine.parse("- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nEnd.\n") });
  const theirs = engine.parse("- one\n- two and more\n- three\n\n| a | b |\n| --- | --- |\n| 1 | 22 |\n\nEnd.\n");
  const to = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
  const tr = state.tr;
  replaceChanged(tr, 0, to, [theirs.child(0), theirs.child(1)]);
  expect(tr.doc.eq(theirs)).toBe(true);
});
