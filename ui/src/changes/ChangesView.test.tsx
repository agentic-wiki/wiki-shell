import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Block, BundleInfo, ChangedFile, Changes, FileDiff, GitStatus, TreeNode } from "@/api";
import { BundleProvider } from "@/bundle";
import { ChangesView } from "@/changes/ChangesView";
import { GitContext } from "@/shell/GitActions";
import { ToastProvider } from "@/ui/Toast";

// The changes view against a fake server: each state of Dessy's design, as
// the user sees it and does it.

let root: Root | undefined;
let host: HTMLElement | undefined;
const real = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  globalThis.fetch = real;
});

const bundle = { id: "b", label: "Notes", editable: true, types: [] } as unknown as BundleInfo;
const tree = { path: "/", entries: [], children: [] } as unknown as TreeNode;
const git = { repo: true, branch: "main", remote: "origin/main", ahead: 0, behind: 0, changes: [], outside: 0, incoming: [] } as GitStatus;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

type Server = {
  list: () => Response;
  diffs?: Record<string, () => Response>;
  post?: (path: string, body: Record<string, unknown>) => Response;
};

/** Mounts the view against `server`, and returns what it was sent. */
async function mount(server: Server, opts: { editable?: boolean; status?: GitStatus; at?: string } = {}) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      sent.push({ path: url, body });
      return Promise.resolve(server.post?.(url, body) ?? json({}));
    }
    if (url === "/api/changes") return Promise.resolve(server.list());
    if (url.startsWith("/api/changes/")) {
      const path = decodeURIComponent(url.slice("/api/changes".length));
      return Promise.resolve(server.diffs?.[path]?.() ?? json({ error: "not a changed file" }, 404));
    }
    if (url.startsWith("/api/entry/")) return Promise.resolve(json(entryOf(url.slice("/api/entry".length))));
    return Promise.resolve(json({ error: "unexpected " + url }, 500));
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[opts.at ?? "/changes"]}>
        <BundleProvider bundle={{ ...bundle, editable: opts.editable ?? true }} tree={tree}>
          <ToastProvider>
            <GitContext value={[opts.status ?? git, () => {}]}>
              <ChangesView refresh={0} />
            </GitContext>
          </ToastProvider>
        </BundleProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  return sent;
}

async function settle() {
  // The list waits out its 500 ms debounce only after the first fetch.
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

function entryOf(path: string) {
  return {
    path,
    title: "A",
    type: "note",
    frontmatter: {},
    body: "",
    links: [],
    frontmatterRefs: [],
    backlinks: [],
    headings: [],
    checkboxes: [],
    version: "v",
    blocks: [],
    editable: true,
  };
}

const page = (over: Partial<ChangedFile> = {}): ChangedFile => ({
  path: "/notes/a.md",
  change: "modified",
  version: "v1",
  kind: "page",
  title: "A",
  added: 2,
  removed: 1,
  ...over,
});
const list = (files: ChangedFile[], over: Partial<Changes> = {}) => () => json({ repo: true, files, outside: 0, ...over });

/** HEAD's page: a heading, then three paragraphs. Now: one changed, one
 *  added, the heading's field changed, and a block moved to the top. */
const head = [
  { kind: "heading", text: "# Plan", hash: "h0" },
  { kind: "paragraph", text: "First step here.", hash: "h1" },
  { kind: "paragraph", text: "Second step.", hash: "h2" },
  { kind: "paragraph", text: "Third.", hash: "h3" },
];
const pageDiff = (version = "v1"): FileDiff => ({
  version,
  raw: "diff --git a/notes/a.md b/notes/a.md\n@@ -1,3 +1,3 @@\n---\n-status: todo\n+status: done\n---\n",
  blocks: {
    head: head as Block[],
    ops: [
      { op: "move", at: 3, hash: "h3", after: -1 },
      { op: "replace", at: 1, hash: "h1", blocks: [{ kind: "paragraph", text: "First step there.", hash: "n1" }] },
      { op: "insert", after: 2, hash: "h2", blocks: [{ kind: "paragraph", text: "A new step.", hash: "n2" }] },
    ],
  },
  fields: [{ key: "status", from: "todo", to: "done" }],
  hunks: [
    { kind: "field", key: "status" },
    { kind: "move", ops: [0] },
    { kind: "blocks", ops: [1, 2] },
  ],
});

const text = () => host!.textContent ?? "";
const button = (label: string, within: ParentNode = host!) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
/** The open in-place question: its group is labelled by what it asks. */
const question = () => host!.querySelector("[role=group][aria-label$='?']")!;
const click = async (el: Element | undefined) => {
  expect(el).toBeDefined();
  await act(async () => (el as HTMLElement).click());
  await settle();
};

test("nothing to commit says so", async () => {
  await mount({ list: list([]) });
  expect(text()).toContain("No changes");
  expect(text()).toContain("show up here before they are committed");
});

test("a wiki that isn't in git says so", async () => {
  await mount({ list: () => json({ repo: false, files: [], outside: 0 }) });
  expect(text()).toContain("This wiki is not in git");
});

test("a list that can't be read offers Try again", async () => {
  let fail = true;
  await mount({ list: () => (fail ? json({ error: "git: not found" }, 500) : list([])()) });
  expect(text()).toContain("Can't read git");
  fail = false;
  await click(button("Try again"));
  expect(text()).toContain("No changes");
});

test("a page's diff is drawn by block: fields, changed words, a move, an addition", async () => {
  await mount({ list: list([page()]), diffs: { "/notes/a.md": () => json(pageDiff()) } });
  const box = host!.querySelector("section")!;
  // The field: was struck, now beside it.
  expect(box.textContent).toContain("status: todo → done");
  // The changed block, word by word.
  expect([...box.querySelectorAll("del")].map((d) => d.textContent)).toContain("removed: here.");
  expect([...box.querySelectorAll("ins")].map((d) => d.textContent)).toContain("added: there.");
  // The move, drawn at its new place only.
  expect(box.textContent).toContain("Moved from under 'Plan'");
  expect(box.textContent!.match(/Third\./g)?.length).toBe(1);
  expect(box.textContent).toContain("A new step.");
  // Screen readers hear what each change is.
  expect(box.textContent).toContain("Added: ");
  expect(box.textContent).toContain("Changed: was First step here.");
});

test("Discard asks once, focus on Cancel, then undoes the hunk at the version shown", async () => {
  const sent = await mount({
    list: list([page()]),
    diffs: { "/notes/a.md": () => json(pageDiff()) },
    post: () => json({ version: "v2" }),
  });
  // The move's Discard asks to move it back.
  const discards = [...host!.querySelectorAll("button")].filter((b) => b.textContent === "Discard");
  await click(discards[1]);
  expect(text()).toContain("Move it back?");
  expect(document.activeElement?.textContent).toBe("Cancel");
  await click(button("Discard", question()));
  expect(sent).toEqual([{ path: "/api/changes/discard", body: { path: "/notes/a.md", version: "v1", hunk: 1 } }]);
});

test("a discard refused because the file changed says so, and Show redraws it", async () => {
  let version = "v1";
  await mount({
    list: list([page()]),
    diffs: { "/notes/a.md": () => json(pageDiff(version)) },
    post: () => json({ error: "This file changed after you read it. Nothing was discarded.", version: "v2" }, 409),
  });
  await click(button("Discard changes"));
  expect(text()).toContain("Discard all changes to A?");
  await click(button("Discard", question()));
  expect(text()).toContain("This file changed after you read it. Nothing was discarded.");
  expect(document.activeElement?.textContent).toBe("Show");
  version = "v2";
  await click(document.activeElement!);
  expect(text()).not.toContain("Nothing was discarded");
});

test("a file that changes while it's read doesn't jump: Changed again, and Show", async () => {
  let version = "v1";
  const server = { list: () => list([page({ version })])(), diffs: { "/notes/a.md": () => json(pageDiff(version)) } };
  await mount(server);
  version = "v2";
  // The event stream moves the bundle's version: the list is read again.
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <BundleProvider bundle={bundle} tree={tree}>
          <ToastProvider>
            <GitContext value={[git, () => {}]}>
              <ChangesView refresh={1} />
            </GitContext>
          </ToastProvider>
        </BundleProvider>
      </MemoryRouter>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 550)));
  await settle();
  expect(text()).toContain("Changed again, just now");
  await click(button("Show"));
  expect(text()).not.toContain("Changed again");
});

test("a new file that isn't a page starts unticked; a dot file has no checkbox and no diff", async () => {
  await mount({
    list: list([
      page(),
      { path: "/exports/clients.csv", change: "new", version: "c1", kind: "text", added: 3, removed: 0 },
      { path: "/.env", change: "new", version: "", kind: "dot" },
    ]),
    diffs: {
      "/notes/a.md": () => json(pageDiff()),
      "/exports/clients.csv": () => json({ version: "c1", raw: "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n", hunks: [] }),
    },
  });
  const boxes = (p: string) => host!.querySelector(`section[data-path='${p}']`)!;
  expect(boxes("/exports/clients.csv").textContent).toContain("New file, not a page: tick to include.");
  expect(boxes("/.env").textContent).toContain("Not shown or committed here");
  expect(button("Discard changes", boxes("/.env"))).toBeUndefined();
  expect(text()).toContain("1 of 2 files");
  expect(text()).toContain("1 dot file is left for git.");
});

// The view only commits, upstream or not: pushing is the git popover's.
test("Commit sends each ticked file at its shown version, and only commits", async () => {
  const sent = await mount({
    list: list([page()]),
    diffs: { "/notes/a.md": () => json(pageDiff()) },
    post: () => json({ committed: ["/notes/a.md"], refused: [], commit: "abc", status: git }),
  });
  const message = host!.querySelector<HTMLInputElement>("[aria-label='Commit message']")!;
  expect(message.value).toBe("Update notes/a.md");
  expect(button("Commit & push")).toBeUndefined();
  await click(button("Commit"));
  expect(sent).toEqual([
    { path: "/api/commit", body: { message: "Update notes/a.md", files: [{ path: "/notes/a.md", version: "v1" }] } },
  ]);
  expect(document.querySelector("[role=status]")?.textContent).toBe("Committed 1 file.");
});

test("a file refused at commit is named; the others commit", async () => {
  await mount(
    {
      list: list([page(), page({ path: "/notes/b.md", title: "B" })]),
      diffs: { "/notes/a.md": () => json(pageDiff()), "/notes/b.md": () => json(pageDiff()) },
      post: () =>
        json({ committed: ["/notes/a.md"], refused: [{ path: "/notes/b.md", reason: "changed after you read it" }], commit: "abc", status: git }),
    },
    { status: { ...git, remote: "" } },
  );
  await click(button("Commit"));
  const toast = document.querySelector("[role=status]")?.textContent;
  expect(toast).toContain("Committed 1 file.");
  expect(toast).toContain("notes/b.md changed after you read it. Check it, then commit again.");
});

test("a commit a hook refuses shows the hook's output above the bar, and nothing is lost", async () => {
  await mount({
    list: list([page()]),
    diffs: { "/notes/a.md": () => json(pageDiff()) },
    post: () => json({ error: "the pre-commit hook refused the commit: lint: 2 problems" }, 500),
  });
  const message = host!.querySelector<HTMLInputElement>("[aria-label='Commit message']")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(message, "My words");
    message.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Commit"));
  expect(text()).toContain("The commit was refused by the repository's pre-commit hook.");
  expect(host!.querySelector("pre")?.textContent).toBe("lint: 2 problems");
  expect(host!.querySelector<HTMLInputElement>("[aria-label='Commit message']")!.value).toBe("My words");
});

test("a text file is diffed by line, each @@ hunk with its own Discard", async () => {
  const sent = await mount({
    list: list([{ path: "/wiki.toml", change: "modified", version: "t1", kind: "text", added: 1, removed: 1 }]),
    diffs: {
      "/wiki.toml": () =>
        json({
          version: "t1",
          raw: "diff --git a/wiki.toml b/wiki.toml\n--- a/wiki.toml\n+++ b/wiki.toml\n@@ -1,2 +1,2 @@\n spec = 1\n-x = 1\n+x = 2\n@@ -9 +9 @@\n-y\n+z\n",
          hunks: [
            { kind: "lines", at: 0 },
            { kind: "lines", at: 1 },
          ],
        }),
    },
    post: () => json({ version: "t2" }),
  });
  const discards = [...host!.querySelectorAll("button")].filter((b) => b.textContent === "Discard");
  expect(discards.length).toBe(2);
  expect(text()).toContain("+x = 2");
  await click(discards[1]);
  await click(button("Discard", question()));
  expect(sent[0]).toEqual({ path: "/api/changes/discard", body: { path: "/wiki.toml", version: "t1", hunk: 1 } });
});

test("read-only on a network address: the diffs, with no checkbox, no Discard and no commit bar", async () => {
  await mount({ list: list([page()]), diffs: { "/notes/a.md": () => json(pageDiff()) } }, { editable: false });
  expect(text()).toContain("status: todo → done");
  expect(host!.querySelector("input[type=checkbox]")).toBeNull();
  expect([...host!.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Discard"))).toBe(false);
  expect(host!.querySelector("[aria-label='Commit message']")).toBeNull();
  expect(text()).toContain("WikiShell was started without --edit on this address.");
});

test("files staged outside the wiki are named as work this won't commit", async () => {
  await mount({ list: list([page()], { outside: 2 }), diffs: { "/notes/a.md": () => json(pageDiff()) } });
  expect(text()).toContain("2 staged files elsewhere in this repository are outside the wiki");
});

test("a header whose layout alone changed is one muted row, unfolding to its lines", async () => {
  await mount({
    list: list([page({ added: 0, removed: 0 })]),
    diffs: {
      "/notes/a.md": () =>
        json({
          version: "v1",
          raw: "diff --git a/notes/a.md b/notes/a.md\n@@ -1,4 +1,4 @@\n ---\n-type: note\n status: todo\n+type: note\n ---\n \n",
          blocks: { head: [], ops: [] },
          fields: [],
          header: true,
          hunks: [],
        }),
    },
  });
  const row = host!.querySelector("details")!;
  expect(row.querySelector("summary")!.textContent).toBe("The header's layout changed (order, comments or quoting)");
  expect(row.getAttribute("title")).toBe("Discard changes restores it exactly.");
  expect([...row.querySelectorAll("pre > div")].map((d) => d.textContent)).toEqual([" ---", "-type: note", " status: todo", "+type: note", " ---"]);
});

test("a file that arrives after the view opened starts unticked, and says so", async () => {
  let files = [page()];
  const server = {
    list: () => list(files)(),
    diffs: { "/notes/a.md": () => json(pageDiff()), "/notes/b.md": () => json(pageDiff()) },
  };
  await mount(server);
  files = [page(), page({ path: "/notes/b.md", title: "B" })];
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <BundleProvider bundle={bundle} tree={tree}>
          <ToastProvider>
            <GitContext value={[git, () => {}]}>
              <ChangesView refresh={1} />
            </GitContext>
          </ToastProvider>
        </BundleProvider>
      </MemoryRouter>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 550)));
  await settle();
  const b = host!.querySelector("section[data-path='/notes/b.md']")!;
  expect(b.textContent).toContain("Arrived after you opened this: tick to include.");
  expect(host!.querySelector("[aria-label='notes/b.md, modified, arrived after you opened this']")).not.toBeNull();
  expect(text()).toContain("1 of 2 files");
});

test("following a page's chip lands on its box, focused", async () => {
  await mount(
    { list: list([page(), page({ path: "/notes/b.md", title: "B" })]), diffs: { "/notes/a.md": () => json(pageDiff()), "/notes/b.md": () => json(pageDiff()) } },
    { at: "/changes#%2Fnotes%2Fb.md" },
  );
  expect((document.activeElement as HTMLElement).dataset.path).toBe("/notes/b.md");
});

test("a file that isn't a page names its path once, and a mode-only change says so", async () => {
  await mount({
    list: list([{ path: "/run.sh", change: "modified", version: "r1", kind: "text", added: 0, removed: 0, mode: { from: "100644", to: "100755" } }]),
    diffs: { "/run.sh": () => json({ version: "r1", raw: "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n", hunks: [] }) },
  });
  const box = host!.querySelector("section")!;
  expect(box.textContent!.match(/run\.sh/g)?.length).toBe(1);
  expect(box.textContent!.match(/Now executable/g)?.length).toBe(1);
  expect(box.textContent).toContain("Only the file's mode changed. Change it back with chmod.");
});
