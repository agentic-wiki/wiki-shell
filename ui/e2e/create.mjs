// New entry in a real browser, against the real binary (the design's "Create
// an entry"): from the tree's +, the dialog shows the file the server drafts,
// and Create writes it and opens it with the caret in its body; from the `/`
// menu the new page is linked where the caret was; a missing link's Create it
// makes the page it points to.
//
//   node ui/e2e/create.mjs <wikishell binary> <browser install>
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/create.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-create-"));
fs.writeFileSync(path.join(bundle, "wiki.toml"), 'spec = "0.1"\ntypes = ["note", "spec"]\n');
fs.mkdirSync(path.join(bundle, "spec"));
fs.writeFileSync(path.join(bundle, "spec/a.md"), "---\ntype: spec\n---\n\nSee [the rules](./settlement-rules.md).\n\nThe end.\n");
const port = await new Promise((ok) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const read = (p) => (fs.existsSync(path.join(bundle, p)) ? fs.readFileSync(path.join(bundle, p), "utf8") : "");

const server = spawn(bin, [bundle, "--port", String(port)], { stdio: "ignore" });
const browser = await launch();
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://localhost:${port}/`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
  const p = shot.page;
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`http://localhost:${port}/wiki/spec/a.md`, { waitUntil: "load" });
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });

  // From the tree's +, in the page's folder, with its usual type.
  await p.getByRole("button", { name: "New entry", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "New entry" });
  await dialog.getByLabel("Title").fill("Decision log two");
  await dialog.getByText("/spec/decision-log-two.md", { exact: true }).waitFor({ timeout: 3000 });
  check(true, "the dialog shows the file the server drafts");
  await dialog.getByRole("button", { name: "Create" }).click();
  await p.waitForURL(/\/wiki\/spec\/decision-log-two\.md$/);
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });
  await p.waitForTimeout(500);
  const made = read("spec/decision-log-two.md");
  check(made.includes("type: spec") && made.includes("title: Decision log two") && made.includes("tags: []"), "Create writes the drafted file: type, title and tags");
  await p.keyboard.type("First words.");
  await p.waitForTimeout(2000);
  check(read("spec/decision-log-two.md").includes("First words."), "and it opens with the caret in its body");

  // From the / menu: the new page is linked where the caret was.
  await p.goto(`http://localhost:${port}/wiki/spec/a.md`, { waitUntil: "load" });
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });
  const end = p.locator("article .ProseMirror > p").last();
  await end.click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/new entry");
  await p.keyboard.press("Enter");
  await dialog.getByLabel("Title").fill("Open questions");
  await dialog.getByText("/spec/open-questions.md", { exact: true }).waitFor({ timeout: 3000 });
  await dialog.getByRole("button", { name: "Create" }).click();
  await p.waitForURL(/open-questions\.md$/);
  await p.waitForTimeout(1500);
  check(read("spec/a.md").includes("[Open questions](./open-questions.md)"), "from the / menu, the page is linked where the caret was");

  // A missing link: Create it makes the page it points to.
  await p.goto(`http://localhost:${port}/wiki/spec/a.md`, { waitUntil: "load" });
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });
  await p.locator("article .ProseMirror a", { hasText: "the rules" }).hover();
  await p.getByRole("button", { name: "Create it" }).click();
  // It starts from the address the link names, so pressing Create at once
  // makes that very file, and the link stays as written.
  check((await dialog.getByLabel("Title").inputValue()) === "Settlement rules", "a missing link's title starts from its file name");
  await dialog.getByRole("button", { name: "Create" }).click();
  await p.waitForURL(/settlement-rules\.md$/);
  check(read("spec/settlement-rules.md").includes("type: spec"), "Create it makes the page the link points to");
  check(read("spec/a.md").includes("[the rules](./settlement-rules.md)"), "and the link is untouched");

  check(errors.length === 0, `no errors on the page${errors.length ? ": " + errors.join("; ") : ""}`);
  check(shot.refused.size === 0, "no other host was asked");
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(bundle, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "new entries are drafted by the server, written, opened and linked");
process.exit(failed ? 1 : 0);
