import { afterEach, expect, test } from "bun:test";
import { createRoot, type Root } from "react-dom/client";
import { StrictMode, act } from "react";
import { MemoryRouter } from "react-router";
import { Markdown } from "@/markdown/Markdown";
import type { Entry } from "@/api";

/**
 * Callouts, which are a client-only rendering rule: the marker is stripped from
 * the text and comes back as a label and a colour.
 *
 * Rendered under StrictMode on purpose. Everything the renderer matches from
 * server data is matched by source position, and the double render is what
 * caught the cursor-based version of that doing nothing at all.
 */

const blank: Entry = {
  path: "/notes/a.md",
  title: "A",
  type: "note",
  frontmatter: {},
  body: "",
  links: [],
  frontmatterRefs: [],
  backlinks: [],
  headings: [],
  checkboxes: [],
  version: "v1",
  blocks: [],
  editable: true,
};

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = undefined;
});

function render(entry: Partial<Entry> & { body: string }, onToggleCheckbox?: (line: number, done: boolean) => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <StrictMode>
        <MemoryRouter>
          <Markdown entry={{ ...blank, ...entry }} onToggleCheckbox={onToggleCheckbox} />
        </MemoryRouter>
      </StrictMode>,
    );
  });
  return host;
}

/** The one blockquote a fixture renders, and the label it carries. */
function callout(el: HTMLElement) {
  const quote = el.querySelector("blockquote")!;
  return {
    type: quote.getAttribute("data-callout"),
    label: quote.querySelector(".callout-label")?.textContent,
    text: quote.textContent ?? "",
  };
}

test("a callout takes its type from the marker and its label from the title", () => {
  const { type, label, text } = callout(
    render({ body: "> [!success] Shipped\n> The write went through.\n" }),
  );
  expect(type).toBe("success");
  expect(label).toBe("Shipped");
  expect(text).toContain("The write went through.");
  expect(text).not.toContain("[!success]");
});

// GitHub writes five uppercase words and allows no title; Obsidian writes a
// dozen lowercase ones and does. Both are in circulation, so both are one case.
test("an uppercase marker with no title is labelled by its own word", () => {
  const { type, label, text } = callout(render({ body: "> [!WARNING]\n> Here be dragons.\n" }));
  expect(type).toBe("warning");
  expect(label).toBe("Warning");
  expect(text).toContain("Here be dragons.");
});

// The point of not enumerating the types: a marker nobody listed still reads as
// an aside rather than as syntax that leaked onto the page.
test("an unrecognised marker is still a callout, under its own word", () => {
  const { type, label, text } = callout(render({ body: "> [!tldr]\n> The short version.\n" }));
  expect(type).toBe("tldr");
  expect(label).toBe("Tldr");
  expect(text).not.toContain("[!");
});

// Folding is deliberately not implemented; the suffix is recognised only so it
// cannot end up printed inside the label.
test("a fold suffix is not part of the title", () => {
  expect(callout(render({ body: "> [!note]- Later\n> Body.\n" })).label).toBe("Later");
  expect(callout(render({ body: "> [!note]+\n> Body.\n" })).label).toBe("Note");
});

test("a plain blockquote is left alone", () => {
  const quote = render({ body: "> Just a quote.\n" }).querySelector("blockquote")!;
  expect(quote.hasAttribute("data-callout")).toBe(false);
  expect(quote.querySelector(".callout-label")).toBeNull();
  expect(quote.textContent).toContain("Just a quote.");
});

// A bracket is not a marker. Without this, the rule could be "starts with `[`"
// and every quote opening on a link would grow a label.
test("a quote that merely opens with a bracket is not a callout", () => {
  const quote = render({ body: "> [not a marker] and the rest.\n" }).querySelector("blockquote")!;
  expect(quote.hasAttribute("data-callout")).toBe(false);
  expect(quote.textContent).toContain("[not a marker]");
});

/**
 * The failure this whole plugin was written to avoid. Headings and checkboxes
 * are matched by `node.position`, so a plugin that rebuilt nodes instead of
 * mutating them would drop those positions and silently unhook every checkbox
 * and anchor inside a callout — invisible in a screenshot, and only noticed
 * when a click does nothing.
 */
test("a checkbox inside a callout still reports the body line the server gave", () => {
  const toggles: { line: number; done: boolean }[] = [];
  const el = render(
    {
      body: "> [!todo] Things\n> - [ ] one\n",
      // File line 7, body line 2: the offset is the point.
      checkboxes: [{ line: 7, bodyLine: 2, done: false, text: "one" }],
    },
    (line, done) => toggles.push({ line, done }),
  );

  const box = el.querySelector<HTMLInputElement>('blockquote input[type="checkbox"]');
  expect(box).not.toBeNull();
  act(() => {
    box!.click();
  });
  // The body line the box was matched by: the tick is made from the blocks there.
  expect(toggles).toEqual([{ line: 2, done: true }]);
});

test("a heading after a callout still gets its server-given id", () => {
  const el = render({
    body: "> [!note] Aside\n> Quoted.\n\n# After\n",
    headings: [{ level: 1, text: "After", id: "after", line: 8, bodyLine: 4 }],
  });
  expect(el.querySelector("h1")?.id).toBe("after");
});

// Legal in both dialects. It only has to not break.
test("a callout nested in a callout renders both", () => {
  const el = render({ body: "> [!warning] Outer\n> > [!bug] Inner\n> > Careful.\n" });
  const types = [...el.querySelectorAll("blockquote")].map((q) => q.getAttribute("data-callout"));
  expect(types).toEqual(["warning", "bug"]);
  expect(el.textContent).not.toContain("[!");
});

// A heading with no letter or digit has an empty id from wiki: it renders
// with no id attribute and no anchor link, not as id="".
test("a heading with an empty id gets no id attribute", () => {
  const el = render({
    body: "# ???\n",
    headings: [{ level: 1, text: "???", id: "", line: 4, bodyLine: 1 }],
  });
  const h = el.querySelector("h1")!;
  expect(h.hasAttribute("id")).toBe(false);
  expect(h.querySelector("a")).toBeNull();
});

// The link rule, in the reader: an address that could run code is text.
test("a script address is drawn as text, in any spelling", () => {
  const el = render({
    body:
      "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](&#106;avascript:alert(1)) " +
      "[d](data:text/html,x) [e](https://example.com/) [f](mailto:a@example.com)\n",
  });
  const anchors = [...el.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(anchors).toEqual([
    ["e", "https://example.com/"],
    ["f", "mailto:a@example.com"],
  ]);
  expect(el.textContent).toContain("a b c d");
  // Another site opens in a new tab, and learns nothing about this one.
  expect(el.querySelector("a[href^='https']")?.getAttribute("rel")).toBe("noopener noreferrer");
});

// Remote images wait for a click (M-3): until then, nothing names the address.
test("a remote image is a chip with its host, and no address in the page until Load", () => {
  const el = render({
    body: "![Team photo](https://images.example.com/team.png?u=42) and ![](https://cdn.example.org/x.png)\n",
  });
  expect(el.querySelector("img")).toBeNull();
  expect(el.innerHTML).not.toContain("team.png");
  expect(el.innerHTML).not.toContain("u=42");
  expect(el.querySelector("link[rel=preload]")).toBeNull();
  const chips = [...el.querySelectorAll("[data-remote-image]")];
  expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual([
    "Image from images.example.com, not loaded: Team photo",
    "Image from cdn.example.org, not loaded: Image",
  ]);

  // Load loads that one image.
  act(() => chips[0]!.querySelector<HTMLButtonElement>("button[aria-label^='Load image']")!.click());
  expect([...el.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
    "https://images.example.com/team.png?u=42",
  ]);

  // Load all loads the rest of this page's.
  const all = el.querySelector<HTMLButtonElement>("button[aria-label='Load all 2 images on this page']")!;
  act(() => all.click());
  expect(el.querySelectorAll("img")).toHaveLength(2);
});

test("an image of the bundle loads at once, and one with another scheme never", () => {
  const el = render({
    body: "![d](./d.png) ![x](data:image/png;base64,AAAA)\n",
    links: [{ raw: "./d.png", to: "/notes/d.png", anchor: "", text: "", line: 1, exists: true, outside: false, asset: "/raw/notes/d.png" }],
  });
  expect([...el.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["/raw/notes/d.png"]);
  expect(el.textContent).toContain("x");
});

test("a done to-do strikes its own text, not its nested list", () => {
  const el = render({
    body: "- [x] done\n  - nested\n",
    checkboxes: [{ line: 1, bodyLine: 1, done: true, text: "done" }],
  });
  const struck = [...el.querySelectorAll(".line-through")].map((s) => s.textContent?.trim());
  expect(struck).toEqual(["done"]);
  expect(el.querySelector(".line-through ul")).toBeNull();
});

test("a plain http image can't load, and says so", () => {
  // `//host` is fetched with the page's own scheme, which is http here.
  const el = render({ body: "![Old](http://old.example.com/a.png) ![](//cdn.example.org/x.png) ![New](https://new.example.com/b.png)\n" });
  const chips = [...el.querySelectorAll("[data-remote-image]")];
  expect(chips[0]!.getAttribute("aria-label")).toBe("Image: Old, from http://old.example.com. Only https images load.");
  expect(chips[0]!.querySelector("button")).toBeNull();
  expect(chips[0]!.textContent).toContain("Only https images load");
  expect(chips[1]!.getAttribute("aria-label")).toBe("Image: Image, from http://cdn.example.org. Only https images load.");
  // Load all counts only what can load: one, so it isn't offered.
  expect(el.querySelector("button[aria-label^='Load all']")).toBeNull();
});
