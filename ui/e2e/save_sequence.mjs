// The CEO's sequence (msg-1033), in a real browser on a git wiki with a
// detached HEAD: Enter, Enter, type, Enter, Enter, type, a list, a to-do
// ticked, an empty to-do, with saves landing in between. No save is refused,
// nothing is written as "<br />", and every typed word is in the file. Then a
// tab that outlives a restart onto a new build is told to reload.
//
//   node ui/e2e/save_sequence.mjs <wikishell binary> <browser install>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/save_sequence.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-sequence-"));
const git = (...a) => execFileSync("git", ["-C", bundle, ...a], { encoding: "utf8" });
fs.writeFileSync(path.join(bundle, "wiki.toml"), 'spec = "0.1"\n');
const file = path.join(bundle, "a.md");
fs.writeFileSync(file, "---\ntype: note\n---\n\nOne.\n\nTwo.\n\nThree.\n");
git("init", "-q", "-b", "main");
git("config", "user.name", "E2E");
git("config", "user.email", "e2e@example.invalid");
git("config", "commit.gpgsign", "false");
git("add", ".");
git("commit", "-q", "-m", "start");
git("checkout", "-q", "--detach");
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
const start = () => spawn(bin, [bundle, "--port", String(port)], { stdio: "ignore" });
const up = async () => {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://localhost:${port}/`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};

let server = start();
const browser = await launch();
try {
  await up();
  const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
  const p = shot.page;
  const refused = [];
  p.on("response", (r) => r.url().includes("/api/blocks/") && r.request().method() === "PUT" && r.status() >= 400 && refused.push(r.status()));
  await p.goto(`http://localhost:${port}/wiki/a.md`, { waitUntil: "load" });
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });
  await p.locator("article .ProseMirror > p").last().click();
  await p.keyboard.press("End");
  // Slow enough that saves land between the steps, as a person types.
  const k = p.keyboard;
  for (const step of [
    () => k.press("Enter"),
    () => k.press("Enter"),
    () => k.type("asdf"),
    () => k.press("Enter"),
    () => k.press("Enter"),
    () => k.type("123r"),
    () => k.press("Enter"),
    () => k.type("- qkfhqkwef"),
    () => k.press("Enter"),
    () => k.type("[ ] dfasdfasdf"),
    () => p.locator("article .ProseMirror li").last().click({ position: { x: 2, y: 8 } }),
    () => k.press("End"),
    () => k.press("Enter"),
    () => k.type("sadkfhjksadhf"),
    () => k.press("Enter"),
  ]) {
    await step();
    await p.waitForTimeout(1200);
  }
  await p.waitForTimeout(1500);
  const disk = fs.readFileSync(file, "utf8");
  check(refused.length === 0, `no save is refused${refused.length ? ": " + refused.join(", ") : ""}`);
  check(!disk.includes("<br"), "nothing is written as <br />");
  check(["asdf", "123r", "qkfhqkwef", "dfasdfasdf", "sadkfhjksadhf"].every((w) => disk.includes(w)), "every typed word is in the file");
  check((await p.locator("[data-held], [data-outside-bar]").count()) === 0, "and nothing shows as a conflict");

  // A restart onto a new build: this tab's app is now the old one.
  await p.route(`http://localhost:${port}/`, async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(/(\/assets\/index-)[^".]+/, "$1NEWBUILD");
    await route.fulfill({ response: res, body: html });
  });
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  server = start();
  await up();
  await p.getByText("WikiShell was updated while this page was open.").waitFor({ timeout: 15000 }).catch(() => {});
  check((await p.getByText("WikiShell was updated while this page was open.").count()) === 1, "a tab left open over a new build is told to reload");
  check(shot.refused.size === 0, "no other host was asked");
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(bundle, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "the CEO's sequence saves cleanly, and an old tab knows it's old");
process.exit(failed ? 1 : 0);
