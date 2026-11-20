import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Entry } from "@/api";
import { Markdown } from "@/markdown/Markdown";

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const entry = { path: "/a.md", body: "", links: [], headings: [], checkboxes: [] } as unknown as Entry;

function draw(body: string, was: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <Markdown entry={{ ...entry, body }} was={was} />
      </MemoryRouter>,
    ),
  );
  return host;
}

test("a changed block keeps its rendering, its words marked against what it was", () => {
  const el = draw("The **first** step is to read the [contract](https://example.com) now.", "The **first** step is to read the [design](https://example.com).");
  // Rendered, not source: bold and the link are elements.
  expect(el.querySelector("strong")?.textContent).toBe("first");
  expect(el.querySelector("a")?.textContent).toContain("contract");
  expect(el.textContent).not.toContain("**");
  // The marks sit on the words, inside the link where the word is.
  expect([...el.querySelectorAll("del")].map((d) => d.textContent)).toEqual(["removed: design."]);
  expect(el.querySelector("a ins")?.textContent).toBe("added: contract");
});

test("a run of added words is one mark, its spaces inside", () => {
  const el = draw("Keep this and add three new words.", "Keep this.");
  const ins = [...el.querySelectorAll("ins")].map((i) => i.textContent);
  expect(ins).toEqual(["added: this and add three new words."]);
  expect(el.querySelectorAll("del").length).toBe(1);
});
