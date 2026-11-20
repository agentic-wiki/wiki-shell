import { expect, test } from "bun:test";
import { registerSaves, settleSaves, written } from "@/editing";

test("a reader of a page's file waits for its editor's saves; none, it doesn't wait", async () => {
  const order: string[] = [];
  const done = registerSaves("/a.md", async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push("saved");
  });
  await settleSaves("/a.md");
  order.push("read");
  await settleSaves("/b.md");
  expect(order).toEqual(["saved", "read"]);
  done();
  await settleSaves("/a.md");
  expect(order).toEqual(["saved", "read"]);
});

// Copies kept before empty blocks were left out of saves held an insert with
// no text; put back as they were, the server refused them again.
test("a kept copy is put back without its empty blocks", () => {
  expect(
    written([
      { op: "replace", at: 0, hash: "a", text: "First. typed" },
      { op: "insert", after: 0, hash: "a", text: "" },
      { op: "insert", after: 0, hash: "a", text: "Then typed." },
      { op: "replace", at: 1, hash: "b", text: "  " },
    ]),
  ).toEqual([
    { op: "replace", at: 0, hash: "a", text: "First. typed" },
    { op: "insert", after: 0, hash: "a", text: "Then typed." },
    { op: "delete", at: 1, hash: "b" },
  ]);
});
