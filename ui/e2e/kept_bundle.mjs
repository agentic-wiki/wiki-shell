// Kept text belongs to its bundle (Audy's L-1; his proof, wiki-shell 311454b,
// made a regression test). A tab keeps text whose save failed, and storage is
// per address, so another bundle served later on the same port must not be
// offered it, nor have it written into its page.
//
//   node ui/e2e/kept_bundle.mjs <wikishell binary> <browser install>
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/kept_bundle.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bundle = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-kept-"));
  fs.writeFileSync(path.join(dir, "wiki.toml"), 'spec = "0.1"\n');
  fs.writeFileSync(path.join(dir, "index.md"), '---\nokf_version: "0.1"\n---\n# Home\n\nThe same starter page.\n');
  return dir;
};
const [A, B] = [bundle(), bundle()];
const port = await new Promise((ok) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});
const serve = (dir) => spawn(bin, [dir, "--port", String(port)], { stdio: "ignore" });
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

let server = serve(A);
await wait(1000);
const browser = await launch();
try {
  const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
  const p = shot.page;
  await p.goto(`http://localhost:${port}/wiki/index.md`);
  await p.locator("article .ProseMirror").waitFor({ state: "visible", timeout: 20000 });
  server.kill(); // A stops
  await wait(500);
  await p.locator("article .ProseMirror > p").last().click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.keyboard.type("SECRET-FROM-A: the private paragraph.");
  await wait(4000); // the save fails: kept in the tab
  check((await p.evaluate(() => Object.keys(sessionStorage))).some((k) => k.startsWith("wikishell:unsaved:")), "A's failed save is kept");

  server = serve(B); // later, B on the same port, in the same tab
  await wait(1000);
  await p.reload();
  await p.locator("article .ProseMirror").waitFor({ state: "visible", timeout: 20000 });
  await wait(500);
  check((await p.getByText("Put it back").count()) === 0, "B isn't offered A's text");
  check(!fs.readFileSync(path.join(B, "index.md"), "utf8").includes("SECRET"), "B's page never gets it");
  await shot.context.close();
} finally {
  await browser.close();
  server.kill();
  for (const d of [A, B]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "kept text stays with its bundle");
process.exit(failed ? 1 : 0);
