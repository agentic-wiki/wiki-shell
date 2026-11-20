// Changes made outside WikiShell, while a page is open in the editor (the
// design's §3), in a real browser against the real binary: a change to
// another block comes in live and lit; a change to the block with the caret is
// held, with a panel, and nothing typed in it is saved until a choice; Keep
// mine writes it, Use theirs takes the other version.
//
//   node ui/e2e/outside.mjs <wikishell binary> <browser install>
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/outside.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));

const page =
  "---\ntype: note\n---\n\nFirst paragraph, where the caret goes.\n\nSecond paragraph, changed by an agent.\n\nThird paragraph.\n";
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-outside-"));
fs.writeFileSync(path.join(bundle, "wiki.toml"), 'spec = "0.1"\n');
const file = path.join(bundle, "a.md");
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
const edit = (from, to) => fs.writeFileSync(file, disk().replace(from, to));

const server = spawn(bin, [bundle, "--port", String(port)], { stdio: "ignore" });
const browser = await launch();
try {
  for (const choice of ["Use theirs", "Keep mine"]) {
    fs.writeFileSync(file, page);
    const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
    const p = shot.page;
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://localhost:${port}/`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await p.goto(`http://localhost:${port}/wiki/a.md`, { waitUntil: "load" });
    await p.locator("article .ProseMirror").waitFor({ state: "visible" });
    const first = p.locator("article .ProseMirror > p").first();
    const box = await first.boundingBox();
    await p.mouse.click(box.x + 4, box.y + 10);

    edit("Second paragraph, changed", "Second paragraph, CHANGED");
    await p.waitForTimeout(2000);
    check((await p.locator("article .ProseMirror > p").nth(1).innerText()).includes("CHANGED"), "another block's change comes in live");
    check((await p.locator("[data-outside]").count()) === 1, "and is lit");

    edit("First paragraph", "First paragraph, theirs,");
    await p.waitForTimeout(2000);
    check((await p.locator("[data-held]").count()) === 1, "the caret's block is held");
    check(!(await first.innerText()).includes("theirs"), "its text isn't overwritten");
    await p.keyboard.type("MINE ");
    await p.waitForTimeout(2000);
    check(!disk().includes("MINE") && disk().includes("theirs"), "nothing typed in a held block is saved");

    await p.locator("[data-held-panel] button", { hasText: choice }).click();
    await p.waitForTimeout(2000);
    if (choice === "Keep mine") check(disk().includes("MINE") && !disk().includes("theirs"), "Keep mine writes mine");
    else check(disk().includes("theirs") && !disk().includes("MINE"), "Use theirs takes the other version");
    check(disk().includes("CHANGED"), "the other block's outside change is kept");
    check(shot.refused.size === 0, "no other host was asked");
    await shot.context.close();
  }
  // The link card: the keyboard follows a link through it.
  fs.writeFileSync(path.join(bundle, "b.md"), "---\ntype: note\n---\n\nAnother page.\n");
  fs.writeFileSync(file, page + "\nSee [the page](./b.md) and [a missing one](./nope.md).\n");
  const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
  const p = shot.page;
  await p.goto(`http://localhost:${port}/wiki/a.md`, { waitUntil: "load" });
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });
  const link = p.locator("article .ProseMirror a", { hasText: "the page" });
  const box = await link.boundingBox();
  await p.mouse.click(box.x - 3, box.y + box.height / 2);
  await p.keyboard.press("ArrowRight");
  await p.keyboard.press("ArrowRight");
  const card = p.locator("[data-link-card] [role=dialog]");
  await card.waitFor({ timeout: 2000 }).catch(() => {});
  check((await card.innerText().catch(() => "")).includes("Open"), "the caret in a link shows its card, Open first");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(200);
  check((await card.count()) === 0, "Escape closes it");
  await p.keyboard.press("ArrowLeft");
  await p.keyboard.press("ArrowRight");
  await p.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await p.waitForTimeout(500);
  check(p.url().endsWith("/wiki/b.md"), "Ctrl/Cmd+Enter follows it");
  await p.goBack();
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });
  const missing = p.locator("article .ProseMirror [title='This entry does not exist yet']");
  const mb = await missing.boundingBox();
  await p.mouse.move(mb.x + 5, mb.y + 5);
  await p.waitForTimeout(900);
  check((await card.innerText().catch(() => "")).includes("Create it"), "a missing entry's card offers Create it");
  await shot.context.close();
  // Rewritten outside: the disk page shows, all lit; only the text not saved
  // yet waits at the caret, and Keep mine saves just it into the new page.
  {
    fs.writeFileSync(file, page);
    const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
    const p = shot.page;
    await p.goto(`http://localhost:${port}/wiki/a.md`, { waitUntil: "load" });
    await p.locator("article .ProseMirror").waitFor({ state: "visible" });
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    const third = p.locator("article .ProseMirror > p").nth(2);
    const box = await third.boundingBox();
    await p.mouse.click(box.x + box.width - 2, box.y + 10);
    await p.keyboard.press("End");
    await p.keyboard.press("Enter");
    await p.keyboard.type("Unsaved line.");
    fs.writeFileSync(file, "---\ntype: note\n---\n\nA whole new page.\n\nWritten by an agent.\n");
    await p.waitForTimeout(3500);
    const text = await p.locator("article .ProseMirror").innerText();
    check(text.includes("A whole new page.") && !text.includes("First paragraph"), "a rewritten page shows the disk's page");
    check((await p.locator("[data-held]").count()) === 1, "only the unsaved block waits");
    check((await p.getByText("This page was rewritten outside WikiShell").count()) > 0, "labelled as rewritten");
    await p.locator("[data-held-panel] button", { hasText: "Keep mine" }).click();
    await p.waitForTimeout(2000);
    const d = disk();
    check(d.includes("A whole new page.") && d.includes("Unsaved line.") && !d.includes("First paragraph"), "Keep mine saves just it into the new page");
    check(errors.length === 0, `no errors on the page${errors.length ? ": " + errors.join("; ") : ""}`);
    await shot.context.close();
  }

  // Deleted outside while open: the page stays, with the bar, and Restore it
  // writes it back, fields and all.
  {
    fs.writeFileSync(file, page);
    const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
    const p = shot.page;
    await p.goto(`http://localhost:${port}/wiki/a.md`, { waitUntil: "load" });
    await p.locator("article .ProseMirror").waitFor({ state: "visible" });
    const first = p.locator("article .ProseMirror > p").first();
    const box = await first.boundingBox();
    await p.mouse.click(box.x + 4, box.y + 10);
    await p.keyboard.type("Kept ");
    await p.waitForTimeout(1500);
    fs.rmSync(file);
    await p.waitForTimeout(3000);
    check((await p.getByText("This page was deleted outside WikiShell.").count()) > 0, "a deleted page says so above the body");
    check((await p.locator("article .ProseMirror").count()) === 1, "and the editor stays, with the text");
    await p.getByRole("button", { name: "Restore it" }).click();
    await p.waitForTimeout(1500);
    const back = fs.existsSync(file) ? disk() : "";
    check(back.includes("Kept First paragraph") && back.includes("type: note"), "Restore it writes it back, fields and all");
    await shot.context.close();
  }
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(bundle, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "changes made outside are taken in, and the caret's block is never overwritten");
process.exit(failed ? 1 : 0);
