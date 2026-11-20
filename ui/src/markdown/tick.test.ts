import { expect, test } from "bun:test";
import type { Block } from "@/api";
import { tickOp } from "@/markdown/tick";

/** A page and its blocks, as the server splits them (the hashes are labels). */
function page(body: string, kinds: [Block["kind"], string][]) {
  return { body, blocks: kinds.map(([kind, text], i): Block => ({ kind, text, hash: "h" + i })) };
}

const list = page("Intro.\n\n- [ ] one\n- [X] two\n  more of two\n\n1) [ ] three\n", [
  ["paragraph", "Intro."],
  ["item", "- [ ] one"],
  ["item", "- [X] two\n  more of two"],
  ["item", "1) [ ] three"],
]);

test("a tick replaces the item's block with one character changed", () => {
  expect(tickOp(list, 3, true)).toEqual({ op: "replace", at: 1, hash: "h1", text: "- [x] one" });
  expect(tickOp(list, 4, false)).toEqual({ op: "replace", at: 2, hash: "h2", text: "- [ ] two\n  more of two" });
  expect(tickOp(list, 7, true)).toEqual({ op: "replace", at: 3, hash: "h3", text: "1) [x] three" });
});

test("nothing to send when the box is already so, or the line holds no box", () => {
  expect(tickOp(list, 3, false)).toBeNull();
  expect(tickOp(list, 4, true)).toBeNull();
  expect(tickOp(list, 1, true)).toBeNull();
  expect(tickOp(list, 5, true)).toBeNull(); // the continuation line of an item
  expect(tickOp(list, 2, true)).toBeNull(); // a gap
  expect(tickOp(list, 99, true)).toBeNull();
});

test("a to-do in a callout ticks inside the quote block", () => {
  const callout = page("> [!todo] Things\n> - [ ] one\n>  - [ ] two\n", [["quote", "> [!todo] Things\n> - [ ] one\n>  - [ ] two"]]);
  expect(tickOp(callout, 2, true)).toEqual({
    op: "replace",
    at: 0,
    hash: "h0",
    text: "> [!todo] Things\n> - [x] one\n>  - [ ] two",
  });
  expect(tickOp(callout, 3, true)?.op).toBe("replace");
  expect(tickOp(callout, 1, true)).toBeNull();
});

test("identical items are told apart by their line", () => {
  const twins = page("- [ ] same\n- [ ] same\n", [
    ["item", "- [ ] same"],
    ["item", "- [ ] same"],
  ]);
  expect(tickOp(twins, 2, true)).toEqual({ op: "replace", at: 1, hash: "h1", text: "- [x] same" });
});
