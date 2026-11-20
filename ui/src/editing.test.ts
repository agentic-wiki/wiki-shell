import { expect, test } from "bun:test";
import { registerSaves, settleSaves } from "@/editing";

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
