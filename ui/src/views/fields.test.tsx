import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Entry } from "@/api";
import { AddField, FieldValue, RemoveField } from "@/views/fields";

const entry: Entry = {
  path: "/notes/a.md",
  title: "A",
  type: "task",
  frontmatter: { status: "todo" },
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
const real = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  globalThis.fetch = real;
});

/** A field on screen, and a server answering its writes with `answer`. */
function field(answer: (body: unknown) => Response) {
  const sent: unknown[] = [];
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    sent.push(body);
    return Promise.resolve(answer(body));
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <FieldValue entry={entry} field="status" value="todo">
        <span>todo</span>
      </FieldValue>,
    ),
  );
  return sent;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

async function edit(to: string, key = "Enter") {
  await act(async () => host!.querySelector("button")!.click());
  const input = host!.querySelector("input")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, to);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

test("a value is edited in place, and written guarded by the value it had", async () => {
  const sent = field(() => json({ version: "v2", conflicts: [] }));
  await edit("done");
  expect(sent).toEqual([{ set: { status: "done" }, old: { status: "todo" }, unset: [] }]);
  expect(host!.querySelector("input")).toBeNull();
});

test("a refusal says why under the field, and the typed value stays", async () => {
  field(() => json({ error: "status must be one of: backlog, todo, done" }, 422));
  await edit("nope");
  const input = host!.querySelector("input")!;
  expect(input.value).toBe("nope");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(
    "status must be one of: backlog, todo, done",
  );
});

test("a value changed outside is offered: keep mine, or use theirs", async () => {
  const sent = field((b) =>
    (b as { old: { status: string } }).old.status === "todo"
      ? json({ version: "v2", conflicts: [{ key: "status", theirs: "blocked" }] })
      : json({ version: "v3", conflicts: [] }),
  );
  await edit("done");
  expect(host!.textContent).toContain("Changed outside WikiShell to: blocked");
  await act(async () => {
    [...host!.querySelectorAll("button")].find((b) => b.textContent === "Keep mine")!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  // Keep mine writes it over theirs, guarded by theirs.
  expect(sent.at(-1)).toEqual({ set: { status: "done" }, old: { status: "blocked" }, unset: [] });
});

test("Escape puts the old value back, writing nothing", async () => {
  const sent = field(() => json({ version: "v2", conflicts: [] }));
  await edit("done", "Escape");
  expect(sent).toEqual([]);
  expect(host!.textContent).toBe("todo");
});

/** Any field component on screen, against a server answering with `answer`. */
function mount(node: React.ReactNode, answer: (body: unknown) => Response) {
  const sent: unknown[] = [];
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    sent.push(body);
    return Promise.resolve(answer(body));
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return sent;
}

const click = async (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });

test("the switch reads a change made outside", async () => {
  mount(<FieldValue entry={entry} field="draft" value={false}><span>no</span></FieldValue>, () =>
    json({ version: "v2", conflicts: [{ key: "draft", theirs: true }] }),
  );
  await click(host!.querySelector("input[role=switch]")!);
  expect(host!.textContent).toContain("Changed outside WikiShell to: true");
});

test("✕ reads a change made outside, and a refusal", async () => {
  mount(<RemoveField entry={entry} field="status" value="todo" />, () =>
    json({ version: "v2", conflicts: [{ key: "status", theirs: "done" }] }),
  );
  await click(host!.querySelector("button")!);
  expect(host!.textContent).toContain("Changed outside WikiShell to: done");
  act(() => root!.unmount());
  host!.remove();
  mount(<RemoveField entry={entry} field="type" value="task" />, () => json({ error: "type is required" }, 422));
  await click(host!.querySelector("button")!);
  expect(host!.textContent).toContain("type is required");
});

test("adding a key that is there says so, and keeps the value typed", async () => {
  mount(<AddField entry={entry} />, () => json({ version: "v2", conflicts: [{ key: "owner", theirs: "backy" }] }));
  await click(host!.querySelector("button")!);
  const [name, value] = [...host!.querySelectorAll("input")];
  await act(async () => {
    for (const [el, v] of [
      [name!, "owner"],
      [value!, "leady"],
    ] as const) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await click([...host!.querySelectorAll("button")].find((b) => b.textContent === "Add")!);
  expect(host!.textContent).toContain("owner already exists");
  expect((host!.querySelectorAll("input")[1] as HTMLInputElement).value).toBe("leady");
});

test("the guard is the value the input opened with, even when the page moved on", async () => {
  const sent = mount(<FieldValue entry={entry} field="owner" value="archy"><span>archy</span></FieldValue>, () =>
    json({ version: "v2", conflicts: [{ key: "owner", theirs: "backy" }] }),
  );
  await click(host!.querySelector("button")!);
  // The page moves on under the open input: the field now says "backy".
  act(() => root!.render(<FieldValue entry={entry} field="owner" value="backy"><span>backy</span></FieldValue>));
  const input = host!.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "leady");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(sent[0]).toEqual({ set: { owner: "leady" }, old: { owner: "archy" }, unset: [] });
  expect(host!.textContent).toContain("Changed outside WikiShell to: backy");
});

test("a list is edited one item a line, so an item keeps its comma", async () => {
  const sent = mount(
    <FieldValue entry={entry} field="owners" value={["Smith, John", "Ana"]}><span>owners</span></FieldValue>,
    () => json({ version: "v2", conflicts: [] }),
  );
  await click(host!.querySelector("button")!);
  const area = host!.querySelector("textarea")!;
  expect(area.value).toBe("Smith, John\nAna");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Smith, John\nAna\nBea");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(sent[0]).toEqual({ set: { owners: ["Smith, John", "Ana", "Bea"] }, old: { owners: ["Smith, John", "Ana"] }, unset: [] });
});

test("type is a select of wiki.toml's types", async () => {
  mount(<FieldValue entry={entry} field="type" value="task" types={["task", "note"]}><span>task</span></FieldValue>, () =>
    json({ version: "v2", conflicts: [] }),
  );
  await click(host!.querySelector("button")!);
  expect([...host!.querySelectorAll("option")].map((o) => o.value)).toEqual(["task", "note"]);
});
