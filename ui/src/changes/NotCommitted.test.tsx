import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { GitStatus } from "@/api";
import { NotCommitted } from "@/changes/NotCommitted";
import { GitContext } from "@/shell/GitActions";

let root: Root | undefined;
let host: HTMLElement | undefined;
const real = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  globalThis.fetch = real;
});

const status = (changes: GitStatus["changes"]) =>
  ({ repo: true, branch: "main", remote: "", ahead: 0, behind: 0, changes, outside: 0, incoming: [] }) as GitStatus;

async function mount(git: GitStatus, files: string[]) {
  const asked: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    asked.push(String(input));
    const body = { repo: true, outside: 0, files: files.map((path) => ({ path, change: "modified", version: "v", kind: "page" })) };
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <GitContext value={[git, () => {}]}>
          <NotCommitted path="/notes/a.md" />
        </GitContext>
      </MemoryRouter>,
    );
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return asked;
}

test("a page with uncommitted changes links to them in the changes view", async () => {
  await mount(status([{ path: "wiki/notes/a.md", code: " M" }]), ["/notes/a.md"]);
  const link = host!.querySelector("a")!;
  expect(link.textContent).toBe("Not committed");
  expect(link.getAttribute("href")).toBe("/changes#%2Fnotes%2Fa.md");
});

test("a page whose changes are committed shows nothing", async () => {
  await mount(status([{ path: "wiki/notes/b.md", code: " M" }]), ["/notes/b.md"]);
  expect(host!.querySelector("a")).toBeNull();
});

test("a clean repository asks nothing", async () => {
  const asked = await mount(status([]), []);
  expect(asked).toEqual([]);
  expect(host!.querySelector("a")).toBeNull();
});
