// Editing in a real browser (the design's §1): the `/` menu turns a block,
// the link picker writes a standard relative link, Callout opens as source,
// the selection toolbar shows on a selection, and a table grows by its
// controls and by Tab in its last cell; each reaches the file.
//
//   node ui/e2e/editing.mjs <wikishell binary> <browser install>
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/editing.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-editing-"));
fs.writeFileSync(path.join(bundle, "wiki.toml"), 'spec = "0.1"\n');
fs.mkdirSync(path.join(bundle, "notes"));
const file = path.join(bundle, "notes/a.md");
fs.writeFileSync(file, "---\ntype: note\n---\n\nA paragraph.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
fs.writeFileSync(path.join(bundle, "notes/target.md"), "---\ntype: note\ntitle: The target page\n---\n\nHere.\n");
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
const disk = () => fs.readFileSync(file, "utf8");

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
  await p.goto(`http://localhost:${port}/wiki/notes/a.md`, { waitUntil: "load" });
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });
  const para = p.locator("article .ProseMirror > p").first();
  const box = await para.boundingBox();
  await p.mouse.click(box.x + box.width - 2, box.y + box.height - 6);
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");

  await p.keyboard.type("/head");
  check((await p.locator("#slash-menu [role=option]").count()) === 3, "/ opens the menu, filtered as typed");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("Enter");
  await p.keyboard.type("A heading");
  check((await p.locator("article .ProseMirror h2", { hasText: "A heading" }).count()) === 1, "Enter picks: the block is a heading");

  await p.keyboard.press("Enter");
  await p.keyboard.type("See @target");
  await p.locator("#link-picker").waitFor({ timeout: 2000 }).catch(() => {});
  await p.keyboard.press("Enter");
  // Drawn with its address as written until the page is read again, which
  // resolves it; it goes where it should either way.
  check((await p.locator("article .ProseMirror a", { hasText: "The target page" }).getAttribute("href")) === "./target.md", "@ picks an entry, by its title");

  await p.keyboard.press("Enter");
  // Escape in the picker leaves @ and what was typed, as text.
  await p.keyboard.type("@nothing");
  await p.locator("#link-picker").waitFor({ timeout: 2000 }).catch(() => {});
  await p.keyboard.press("Escape");
  check((await p.locator("article .ProseMirror > p", { hasText: "@nothing" }).count()) === 1, "Escape in the picker leaves what was typed");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/callout");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Careful");
  check((await p.locator("[data-source][data-editing] [data-source-text]").innerText()).includes("> [!note]\n> Careful"), "Callout opens as source, caret on its second line");

  await p.keyboard.press("Escape");
  await p.locator("article .ProseMirror h2").dblclick();
  await p.waitForTimeout(500);
  check((await p.locator("[role=toolbar][aria-label=Format]").count()) === 1, "a selection shows the toolbar");
  await p.getByRole("button", { name: "Bold" }).click();

  const t = p.locator("article [data-table]");
  await t.hover();
  await p.getByRole("button", { name: "Row below" }).click();
  await t.locator("tr").last().locator("td").last().click();
  await p.keyboard.type("x");
  await p.keyboard.press("Tab");
  await p.keyboard.type("y");
  check((await t.locator("tr").count()) === 4, "the table grows by its controls, and by Tab in its last cell");

  // The block handle: hover shows it; its menu moves a block; ⌘⇧↑ moves
  // the caret's block; dragging it moves a block.
  const first = p.locator("article .ProseMirror > p").first();
  await first.hover();
  const handle = p.getByRole("button", { name: "Block menu" });
  check((await handle.count()) === 1, "hovering a block shows its handle");
  check((await handle.locator("svg circle").count()) === 6, "the handle is drawn, six dots");
  await handle.click();
  check((await p.locator("[role=menuitem][aria-current]").innerText()).trim() === "Text", "its menu marks what the block is now");
  await p.getByRole("menuitem", { name: "Move down" }).click();
  check((await p.locator("article .ProseMirror > *").first().innerText()).includes("A heading"), "its menu moves the block");
  await first.click();
  await p.keyboard.press(process.platform === "darwin" ? "Meta+Shift+ArrowUp" : "Control+Shift+ArrowUp");
  check((await p.locator("article .ProseMirror > *").first().innerText()) === "A paragraph.", "Ctrl/Cmd+Shift+Up moves it back");
  await p.locator("article .ProseMirror > p").first().hover();
  const hb = await handle.boundingBox();
  const target = await p.locator("article .ProseMirror > h2").boundingBox();
  await p.mouse.move(hb.x + 5, hb.y + 5);
  await p.mouse.down();
  await p.mouse.move(hb.x + 5, target.y + target.height - 2, { steps: 8 });
  await p.mouse.up();
  check((await p.locator("article .ProseMirror > *").first().innerText()).includes("A heading"), "dragging the handle moves the block");

  await p.waitForTimeout(2000);
  const d = disk();
  // A double click selects one word: that word is made bold.
  check(d.includes("## A **heading**"), "the heading, its word made bold, is in the file");
  check(d.includes("[The target page](./target.md)"), "the link is a standard relative link in the file");
  check(d.includes("> [!note]\n> Careful"), "the callout is in the file");
  check(d.includes("| y |"), "the new rows are in the file");
  check(errors.length === 0, `no errors on the page${errors.length ? ": " + errors.join("; ") : ""}`);
  check(shot.refused.size === 0, "no other host was asked");
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(bundle, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "editing works, and every change reaches the file");
process.exit(failed ? 1 : 0);
