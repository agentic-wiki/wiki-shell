import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { Node } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { ApiError, type Block, type Entry, type Op, type Saved } from "@/api";
import { load } from "@/edit/blocks";
import { createEngine, type Engine } from "@/edit/engine";
import { type Clock, Saver } from "@/edit/save";
import { keptAll, putKept, type SaveState } from "@/editing";

/** The one copy kept for the page, if any. */
const kept = () => keptAll("b1", "/a.md")[0] ?? null;

let engine: Engine;
beforeAll(async () => {
  engine = await createEngine();
});
beforeEach(() => sessionStorage.clear());

const body = "One.\n\nTwo.\n";
const blocks: Block[] = [
  { kind: "paragraph", text: "One.", hash: "h0" },
  { kind: "paragraph", text: "Two.", hash: "h1" },
];

/** A clock a test moves by hand. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const clock: Clock = {
    now: () => now,
    after: (ms, fn) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((t) => t !== next);
      now = next.at;
      next.fn();
      await settle();
    }
    now = end;
    await settle();
  };
  return { clock, advance };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A page in an editor, and a server that records what it is sent. */
function setup(
  answer: (ops: Op[]) => Promise<Saved> = (ops) => Promise.resolve(written(ops)),
  entryFor: (ops: Op[]) => Entry = entryAfter,
) {
  const loaded = load(engine, body, blocks);
  let doc: Node = loaded.doc;
  const sent: { ops: Op[]; base: string; keepalive?: boolean }[] = [];
  const states: SaveState[] = [];
  const { clock, advance } = fakeClock();
  const saver = new Saver({
    bundle: "b1",
    path: "/a.md",
    from: 0,
    engine,
    base: { version: "v1", blocks },
    loaded,
    doc: () => doc,
    api: {
      saveBlocks: (_p, base, _h, ops, keepalive) => {
        sent.push({ ops, base, keepalive });
        return answer(ops);
      },
      entry: () => Promise.resolve(entryFor(sent.at(-1)!.ops)),
    },
    onState: (s) => states.push(s),
    clock,
  });
  const type = (text: string) => {
    const end = doc.child(0).nodeSize - 1;
    doc = EditorState.create({ doc }).tr.insertText(text, end, end).doc;
    saver.changed();
  };
  return { saver, sent, states, advance, type };
}

/** The server's answer when it wrote exactly `ops`, nothing else changed. */
function written(ops: Op[]): Saved {
  return { version: "v2", ops: ops.map((o) => ("text" in o ? { ...o, text: undefined, blocks: [{ kind: "paragraph", text: o.text!, hash: "x" }] } : o)) as Op[], conflicts: [], rewritten: false };
}

function entryAfter(ops: Op[]): Entry {
  const first = (ops[0] as { text: string }).text;
  return {
    path: "/a.md",
    title: "A",
    type: "",
    frontmatter: {},
    body: first + "\n\nTwo.\n",
    links: [],
    frontmatterRefs: [],
    backlinks: [],
    headings: [],
    checkboxes: [],
    version: "v2",
    blocks: [{ kind: "paragraph", text: first, hash: "n0" }, blocks[1]!],
    editable: true,
  };
}

test("a save goes 800 ms after the last change, and at least every 3 s while typing goes on", async () => {
  const { sent, advance, type } = setup();
  type("a");
  await advance(700);
  type("b");
  await advance(700);
  expect(sent).toHaveLength(0);
  await advance(100);
  expect(sent.map((s) => s.ops)).toEqual([[{ op: "replace", at: 0, hash: "h0", text: "One.ab" }]]);

  // Typing that never stops still saves every 3 s.
  for (let t = 0; t < 3000; t += 500) {
    type("c");
    await advance(500);
  }
  expect(sent).toHaveLength(2);
});

test("after a save, the next goes against the new version, with only what changed since", async () => {
  const { sent, advance, type } = setup();
  type("a");
  await advance(800);
  type("b");
  await advance(800);
  expect(sent.map((s) => s.base)).toEqual(["v1", "v2"]);
  expect(sent[1]!.ops).toEqual([{ op: "replace", at: 0, hash: "n0", text: "One.ab" }]);
});

test("a change made outside meanwhile keeps the old base, for the server to merge", async () => {
  // An agent added a block during the save: the page is not the base plus mine.
  const theirs = (ops: Op[]): Entry => {
    const e = entryAfter(ops);
    return { ...e, blocks: [...e.blocks, { kind: "paragraph", text: "Theirs.", hash: "t" }] };
  };
  const { sent, advance, type, saver } = setup(undefined, theirs);
  type("a");
  await advance(800);
  // Sync compares against what was saved, which is on disk: not the old base.
  expect(saver.baseDoc.textContent).toContain("One.a");
  type("b");
  await advance(800);
  expect(sent.map((s) => s.base)).toEqual(["v1", "v1"]);
});

test("one save in flight; a change meanwhile is saved after it", async () => {
  let release!: () => void;
  const { sent, advance, type } = setup((ops) => new Promise((r) => (release = () => r(written(ops)))));
  type("a");
  await advance(800);
  type("b");
  await advance(5000);
  expect(sent).toHaveLength(1);
  release();
  await settle();
  await advance(800);
  expect(sent).toHaveLength(2);
});

test("a failed save is kept in the tab and retried; a refusal says why and waits", async () => {
  let fail: unknown = new TypeError("fetch failed");
  const { sent, states, advance, type, saver } = setup((ops) => (fail ? Promise.reject(fail) : Promise.resolve(written(ops))));
  type("a");
  await advance(800);
  expect(states.at(-1)).toEqual({
    kind: "failed",
    reason: "Not saved: WikiShell is not running, or this computer is offline. Your text is kept in this tab.",
  });
  expect(kept()?.ops).toEqual([{ op: "replace", at: 0, hash: "h0", text: "One.a" }]);
  await advance(2000);
  expect(sent).toHaveLength(2);
  fail = null;
  await advance(5000);
  expect(sent).toHaveLength(3);
  expect(states.at(-1)?.kind).toBe("saved");
  expect(kept()).toBeNull();

  fail = new ApiError(422, "status must be one of: todo, done");
  type("b");
  await advance(800);
  expect(states.at(-1)).toEqual({ kind: "failed", reason: "Not saved: status must be one of: todo, done" });
  await advance(60_000);
  expect(sent).toHaveLength(4);
  fail = null;
  saver.retry();
  await advance(0);
  expect(sent).toHaveLength(5);
});

test("leaving saves at once, with keepalive, keeping the text until it lands", async () => {
  const { sent, type, saver } = setup();
  type("a");
  saver.leave();
  expect(sent.map((s) => s.keepalive)).toEqual([true]);
  expect(kept()).not.toBeNull();
  await settle();
  expect(kept()).toBeNull();

  // Past 64 KiB, in bytes, keepalive can't carry it.
  type("é".repeat(40 * 1024));
  saver.leave();
  expect(sent.at(-1)!.keepalive).toBe(false);
});

test("a deleted page is said so", async () => {
  const { states, advance, type } = setup(() => Promise.reject(new ApiError(404, "no entry")));
  type("a");
  await advance(800);
  expect(states.at(-1)).toEqual({ kind: "gone" });
});

test("leaving while a save is in flight keeps the newer text, even when that save then lands", async () => {
  let release!: () => void;
  const { type, saver, advance } = setup((ops) => new Promise((r) => (release = () => r(written(ops)))));
  type("a");
  await advance(800);
  type("b");
  saver.leave();
  release();
  await settle();
  await settle();
  expect(kept()?.ops).toEqual([{ op: "replace", at: 0, hash: "h0", text: "One.ab" }]);
});

test("a save sent on leaving that never answers leaves its text kept", async () => {
  const { sent, type, saver } = setup(() => new Promise(() => {}));
  type("a");
  saver.leave();
  expect(sent.map((s) => s.keepalive)).toEqual([true]);
  expect(kept()?.ops).toEqual([{ op: "replace", at: 0, hash: "h0", text: "One.a" }]);
});

test("kept text belongs to its bundle", () => {
  putKept({ bundle: "b1", session: "s", seq: 1, base: "v", baseBlocks: [], ops: [], at: 0 }, "/a.md");
  expect(keptAll("b2", "/a.md")).toEqual([]);
  expect(keptAll("b1", "/a.md")).toHaveLength(1);
});

test("a new editor's kept text never replaces an earlier one's", async () => {
  // Kept by an editor before a reload, during an outage.
  putKept({ bundle: "b1", session: "before", seq: 1, base: "v1", baseBlocks: ["h0", "h1"], ops: [{ op: "replace", at: 0, hash: "h0", text: "Earlier." }], at: 0 }, "/a.md");
  const { type, advance } = setup(() => Promise.reject(new TypeError("offline")));
  type("a");
  await advance(800);
  expect(keptAll("b1", "/a.md").map((k) => (k.ops[0] as { text: string }).text)).toEqual(["Earlier.", "One.a"]);
});
