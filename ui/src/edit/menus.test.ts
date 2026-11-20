import { expect, test } from "bun:test";
import { relative } from "@/edit/menus";

test("a link's address is relative to its page, each segment encoded", () => {
  expect(relative("/notes/a.md", "/notes/b.md")).toBe("./b.md");
  expect(relative("/notes/deep/a.md", "/spec/x.md")).toBe("../../spec/x.md");
  expect(relative("/a.md", "/notes/b.md")).toBe("./notes/b.md");
  expect(relative("/notes/a.md", "/notes/My Notes.md")).toBe("./My%20Notes.md");
  expect(relative("/notes/a.md", "/notes/foo_(x).md")).toBe("./foo_%28x%29.md");
});
