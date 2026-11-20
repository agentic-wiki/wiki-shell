// Text kept in the tab before empty blocks were left out of saves (the CEO's
// "Put it back fails too"): a kept copy holding an insert with no text is put
// back without it, and saves.
//
//   node ui/e2e/kept_empty.mjs <wikishell binary> <browser install>
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/kept_empty.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-kept-empty-"));
fs.writeFileSync(path.join(bundle, "wiki.toml"), 'spec = "0.1"\n');
const file = path.join(bundle, "a.md");
fs.writeFileSync(file, "---\ntype: note\n---\n\nFirst paragraph.\n\nSecond paragraph.\n");
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
  const api = (p) => fetch(`http://localhost:${port}${p}`, { headers: { "X-Wikishell-Token": "e2e" } }).then((r) => r.json());
  const { id } = await api("/api/bundle");
  const entry = await api("/api/entry/a.md");
  // The copy an editor kept before the fix: the user typed, pressed Enter, and
  // typed in the new block; the save had also carried the empty block Enter made.
  const kept = {
    bundle: id,
    session: "before-the-fix",
    seq: 1,
    base: entry.version,
    baseBlocks: entry.blocks.map((b) => b.hash),
    ops: [
      { op: "replace", at: 0, hash: entry.blocks[0].hash, text: "First paragraph. typed" },
      { op: "insert", after: 0, hash: entry.blocks[0].hash, text: "" },
      { op: "insert", after: 0, hash: entry.blocks[0].hash, text: "Then typed." },
    ],
    at: Date.now(),
  };
  const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
  const p = shot.page;
  const refused = [];
  p.on("response", (r) => r.url().includes("/api/blocks/") && r.request().method() === "PUT" && r.status() >= 400 && refused.push(r.status()));
  await shot.context.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [`wikishell:unsaved:${id}:/a.md:${kept.session}`, JSON.stringify(kept)]);
  await p.goto(`http://localhost:${port}/wiki/a.md`, { waitUntil: "load" });
  await p.getByRole("button", { name: "Put it back" }).click();
  await p.waitForTimeout(1500);
  const disk = fs.readFileSync(file, "utf8");
  check(refused.length === 0, `Put it back is not refused${refused.length ? ": " + refused.join(", ") : ""}`);
  check(disk.includes("First paragraph. typed\n\nThen typed.\n\nSecond paragraph."), "the kept text reaches the file, without the empty block");
  check((await p.getByText("Put it back").count()) === 0, "and the banner goes");
  check(shot.refused.size === 0, "no other host was asked");
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(bundle, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "text kept before the fix is put back and saved");
process.exit(failed ? 1 : 0);
