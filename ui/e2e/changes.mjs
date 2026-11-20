// The changes view in a real browser, against the real binary and a real git
// repository (changes-view-adr.md, slice 3): opening it on a page whose diff
// holds a remote image asks no other host; a hunk is discarded in place; a new
// file that isn't a page starts unticked; Commit takes the ticked files, and
// the view empties.
//
//   node ui/e2e/changes.mjs <wikishell binary> <browser install>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/changes.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-changes-"));
const git = (...args) =>
  execFileSync("git", ["-C", bundle, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", ...args], { encoding: "utf8" });
const file = path.join(bundle, "notes/a.md");
fs.mkdirSync(path.join(bundle, "notes"));
fs.writeFileSync(path.join(bundle, "wiki.toml"), 'spec = "0.1"\n');
fs.writeFileSync(file, "---\ntype: note\nstatus: todo\n---\n\n# Plan\n\nFirst step here.\n\nSecond step.\n\nThird.\n");
const reordered = path.join(bundle, "notes/b.md");
const original = "---\ntype: note\nstatus: todo\n---\n\nBody.\n";
fs.writeFileSync(reordered, original);
git("init", "-q", "-b", "main");
git("config", "user.name", "E2E");
git("config", "user.email", "e2e@example.invalid");
git("config", "commit.gpgsign", "false"); // the server's commit follows the repo's own setting
git("add", ".");
git("commit", "-q", "-m", "start");
// The edits an agent makes: a field, a word, a block moved next to the edited
// one, a new block with a remote image, and a new file that isn't a page. The
// key reorder below comes in the same second as the commit, at the same size.
fs.writeFileSync(
  file,
  "---\ntype: note\nstatus: done\n---\n\n# Plan\n\nThird.\n\nFirst step there.\n\nSecond step.\n\n![chart](https://example.com/chart.png)\n",
);
// Only the header's layout: its keys swapped, no value changed.
fs.writeFileSync(reordered, "---\nstatus: todo\ntype: note\n---\n\nBody.\n");
fs.mkdirSync(path.join(bundle, "exports"));
fs.writeFileSync(path.join(bundle, "exports/clients.csv"), "name\nAna\n");

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
  await p.goto(`http://localhost:${port}/changes`, { waitUntil: "load" });
  const box = p.locator("section[data-path='/notes/a.md']");
  await box.locator("text=status: todo").waitFor({ timeout: 5000 });
  await p.waitForTimeout(500);

  check((await box.locator("del", { hasText: "here." }).count()) === 1, "a changed block shows its words struck and added");
  check((await box.innerText()).includes("Moved from under 'Plan'"), "a block moved next to an edited one shows as moved");
  check((await box.getByRole("button", { name: /Load/ }).count()) >= 1, "a remote image in the diff waits behind Load");
  check(shot.refused.size === 0, `opening the view asks no other host${shot.refused.size ? ": " + [...shot.refused].join(", ") : ""}`);
  const csv = p.locator("section[data-path='/exports/clients.csv']");
  check((await csv.innerText()).includes("New file, not a page: tick to include."), "a new file that isn't a page says it starts unticked");

  // On a phone, which has no hover, each change's Discard is always there,
  // under its change, never over the text; a tap asks.
  const phone = await open(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.page.goto(`http://localhost:${port}/changes`, { waitUntil: "load" });
  const field = phone.page.locator("section[data-path='/notes/a.md'] .group\\/hunk").first();
  await field.locator("text=status: todo").waitFor({ timeout: 5000 });
  const tap = field.getByRole("button", { name: "Discard", exact: true });
  const text = await field.locator("p").first().boundingBox();
  const button = await tap.boundingBox();
  check(Number(await tap.evaluate((b) => getComputedStyle(b.parentElement).opacity)) === 1, "on a phone a change's Discard shows without hover");
  check(button.y >= text.y + text.height, "under its change, not over the text");
  await tap.tap();
  check((await phone.page.getByRole("group", { name: "Discard this change?" }).count()) === 1, "and a tap asks");
  await phone.context.close();

  // A header whose layout alone changed: one muted row; Discard file restores it.
  const b = p.locator("section[data-path='/notes/b.md']");
  check((await b.innerText()).includes("The header's layout changed"), "a reordered header says its layout changed");
  await b.getByRole("button", { name: "Discard file" }).click();
  await p.getByRole("group", { name: /Discard all changes/ }).getByRole("button", { name: "Discard", exact: true }).click();
  await p.waitForTimeout(1000);
  check(fs.readFileSync(reordered, "utf8") === original, "Discard file restores it exactly");

  // Discard the field change, in place.
  await box.locator("text=status: todo").hover();
  await box.getByRole("button", { name: "Discard", exact: true }).first().click();
  await p.getByRole("group", { name: "Discard this change?" }).getByRole("button", { name: "Discard", exact: true }).click();
  await p.waitForTimeout(1000);
  check(fs.readFileSync(file, "utf8").includes("status: todo"), "Discard puts the field back on disk");
  check((await box.locator("text=status: todo").count()) === 0, "and the diff no longer shows it");

  await p.getByRole("button", { name: "Commit", exact: true }).click();
  await p.waitForTimeout(1500);
  const log = git("log", "--format=%s", "-n", "1");
  const files = git("show", "--name-only", "--format=", "HEAD").trim().split("\n");
  check(log.trim() === "Update notes/a.md", "Commit uses the proposed message");
  check(files.length === 1 && files[0] === "notes/a.md", "and takes only the ticked file");
  check(git("status", "--porcelain").includes("exports/"), "the unticked file stays uncommitted");
  check(errors.length === 0, `no errors on the page${errors.length ? ": " + errors.join("; ") : ""}`);
  check(shot.refused.size === 0, "no other host was asked");
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(bundle, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "the changes view reviews, discards and commits");
process.exit(failed ? 1 : 0);
