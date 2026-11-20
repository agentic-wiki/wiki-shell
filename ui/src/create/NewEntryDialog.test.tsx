import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import type { BundleInfo, TreeNode } from "@/api";
import { BundleProvider } from "@/bundle";
import { NewEntryDialog } from "@/create/NewEntryDialog";
import { newEntry, titleOf, type Made } from "@/create/newEntry";

let root: Root | undefined;
let host: HTMLElement | undefined;
const real = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  globalThis.fetch = real;
});

const stub = (path: string, type: string) => ({ path, name: path.split("/").pop()!, label: path, type, changedAt: 0 });
const tree = {
  path: "/",
  name: "",
  entries: [],
  children: [
    { path: "/spec", name: "spec", entries: [stub("/spec/a.md", "spec"), stub("/spec/b.md", "spec"), stub("/spec/c.md", "note")], children: [] },
    { path: "/people", name: "people", entries: [], children: [] },
  ],
} as unknown as TreeNode;
const bundle = { id: "b", label: "Notes", editable: true, types: ["note", "spec", "person"] } as unknown as BundleInfo;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

let here = "";
function Where() {
  here = useLocation().pathname;
  return null;
}

/** The dialog on screen, against `server`; returns what was asked of it. */
async function mount(server: (url: string, init?: RequestInit) => Response) {
  const asked: { url: string; body?: unknown }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve(server(url, init));
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <BundleProvider bundle={bundle} tree={tree}>
          <Where />
          <NewEntryDialog />
        </BundleProvider>
      </MemoryRouter>,
    ),
  );
  return asked;
}

const draft = (title: string) => ({ path: "/spec/" + title.toLowerCase().replace(/\s+/g, "-") + ".md", content: `---\ntype: spec\ntitle: ${title}\n---\n` });
const wait = (ms = 300) => act(async () => new Promise((r) => setTimeout(r, ms)));
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const dialog = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='New entry']");
const button = (label: string) => [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === label)!;

test("a title shows the file it makes; Create posts the server's draft unchanged and opens it", async () => {
  const asked = await mount((url) => (url.startsWith("/api/entries/new") ? json(draft("Settlement rules")) : json({ version: "v1" }, 201)));
  let made: Made | null | undefined;
  await act(async () => void newEntry({ in: "/spec" }).then((m) => (made = m)));
  // It starts where it was asked, with the type most entries there have.
  const [where, kind] = [...dialog()!.querySelectorAll("select")];
  expect(where!.value).toBe("/spec");
  expect(kind!.value).toBe("spec");
  await type(dialog()!.querySelector("input")!, "Settlement rules");
  await wait();
  expect(dialog()!.textContent).toContain("/spec/settlement-rules.md");
  expect(asked.at(-1)!.url).toBe("/api/entries/new?in=%2Fspec&type=spec&title=Settlement+rules");
  await act(async () => button("Create").click());
  await wait(0);
  expect(asked.at(-1)).toEqual({ url: "/api/entries", body: draft("Settlement rules") });
  expect(made).toEqual({ path: "/spec/settlement-rules.md", title: "Settlement rules" });
  expect(here).toBe("/wiki/spec/settlement-rules.md");
  expect(dialog()).toBeNull();
});

test("a taken path says so, and offers to open it", async () => {
  await mount(() => json({ error: "There is already an entry at /spec/a.md.", path: "/spec/a.md" }, 409));
  await act(async () => void newEntry({ in: "/spec", title: "A" }));
  await wait();
  expect(dialog()!.textContent).toContain("There is already an entry at /spec/a.md.");
  await act(async () => button("Open it").click());
  expect(here).toBe("/wiki/spec/a.md");
  expect(dialog()).toBeNull();
});

test("a title the wiki refuses says why, and Create makes nothing", async () => {
  const asked = await mount(() => json({ error: "Use at least one letter or number in the title." }, 422));
  await act(async () => void newEntry({ in: "/people" }));
  await type(dialog()!.querySelector("input")!, "!!!");
  await wait();
  expect(dialog()!.querySelector("[role=alert]")!.textContent).toContain("Use at least one letter or number in the title.");
  await act(async () => button("Create").click());
  await wait(0);
  expect(asked.some((a) => a.url === "/api/entries")).toBe(false);
  expect(dialog()).not.toBeNull();
});

test("asked from inside a page, it offers to go beside it as a part; Cancel makes nothing", async () => {
  const asked = await mount(() => json(draft("x")));
  let made: Made | null | undefined;
  await act(async () => void newEntry({ in: "/spec/a.md" }).then((m) => (made = m)));
  const where = dialog()!.querySelector("select")!;
  expect(where.value).toBe("/spec/a.md");
  expect(where.options[0]!.textContent).toBe("Inside spec/a.md");
  await act(async () => button("Cancel").click());
  await wait(0);
  expect(made).toBeNull();
  expect(asked.some((a) => a.url === "/api/entries")).toBe(false);
});

test("a path taken between the draft and Create is said, with Open it, and nothing is made", async () => {
  await mount((url) =>
    url.startsWith("/api/entries/new")
      ? json(draft("Settlement rules"))
      : json({ error: "There is already an entry at /spec/settlement-rules.md.", path: "/spec/settlement-rules.md" }, 409),
  );
  await act(async () => void newEntry({ in: "/spec", title: "Settlement rules" }));
  await wait();
  await act(async () => button("Create").click());
  await wait(0);
  expect(dialog()!.textContent).toContain("There is already an entry at /spec/settlement-rules.md.");
  expect(button("Create").disabled).toBe(true);
  await act(async () => button("Open it").click());
  expect(here).toBe("/wiki/spec/settlement-rules.md");
});

// Revy and Dessy: the draft shown can be a keystroke behind; Create posts the
// draft of the fields as they are when it's pressed.
test("Create right after typing posts the draft of what's typed now, not the one shown", async () => {
  const asked = await mount((url) => {
    if (!url.startsWith("/api/entries/new")) return json({ version: "v1" }, 201);
    return json(draft(new URL(url, "http://x").searchParams.get("title")!));
  });
  let made: Made | null | undefined;
  await act(async () => void newEntry({ in: "/spec" }).then((m) => (made = m)));
  const title = dialog()!.querySelector("input")!;
  await type(title, "Meeting note");
  await wait();
  expect(dialog()!.textContent).toContain("/spec/meeting-note.md");
  // One more letter, and Create at once, before the shown draft catches up.
  await type(title, "Meeting notes");
  await act(async () => button("Create").click());
  await wait(0);
  expect(asked.find((a) => a.url === "/api/entries")!.body).toEqual(draft("Meeting notes"));
  expect(made).toEqual({ path: "/spec/meeting-notes.md", title: "Meeting notes" });
});

test("a missing link's title starts from the file it names", () => {
  expect(titleOf("/spec/settlement-rules.md")).toBe("Settlement rules");
  expect(titleOf("/a/b_c--d.md")).toBe("B c d");
});
