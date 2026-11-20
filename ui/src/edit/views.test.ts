import { beforeAll, expect, test } from "bun:test";
import { EditorState } from "@milkdown/prose/state";
import { createEngine, type Engine } from "@/edit/engine";
import { highlighting } from "@/edit/views";

let engine: Engine;
beforeAll(async () => {
  engine = await createEngine();
});

/** A lowlight that counts its calls, and finds nothing. */
function counting() {
  const calls: string[] = [];
  const empty = { type: "root", children: [] };
  return {
    calls,
    ll: {
      registered: (lang: string) => lang === "go",
      highlight: (lang: string, code: string) => (calls.push(`${lang}:${code}`), empty),
      highlightAuto: (code: string) => (calls.push(`auto:${code}`), { ...empty, data: { language: "go" } }),
    },
  };
}

test("only the code a change touched is highlighted again; detection once per text", () => {
  const { calls, ll } = counting();
  const doc = engine.parse("Some text.\n\n```go\na := 1\n```\n\n```\nb := 2\n```\n");
  let state = EditorState.create({ doc, plugins: [highlighting(ll)] });
  expect(calls).toEqual(["go:a := 1", "auto:b := 2"]);

  // Typing in the paragraph: no highlighting at all.
  calls.length = 0;
  state = state.apply(state.tr.insertText("!", 5));
  expect(calls).toEqual([]);

  // Typing in the first code block: that block only.
  const inCode = state.doc.child(0).nodeSize + 1;
  state = state.apply(state.tr.insertText("x", inCode));
  expect(calls).toEqual(["go:xa := 1"]);

  // Typing in the unlabelled block: its language, found once, is kept while
  // the text changes; no detection per keystroke.
  calls.length = 0;
  const second = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize + 1;
  for (let i = 0; i < 10; i++) state = state.apply(state.tr.insertText("y", second));
  expect(calls.filter((c) => c.startsWith("auto:"))).toHaveLength(0);
  expect(calls).toHaveLength(10);
});
