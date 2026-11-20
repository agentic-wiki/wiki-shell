// Text kept from an earlier visit, still waiting in the bar, survives the next
// failed save on the same page (Revy, msg-700; Audy's proof, wiki-shell
// e863019, made a regression test): each editor keeps its own.
//
//   node ui/e2e/kept_overwrite.mjs <wikishell binary> <browser install>
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/kept_overwrite.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const A = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-overwrite-"));
fs.writeFileSync(path.join(A, "wiki.toml"), 'spec = "0.1"\n');
fs.writeFileSync(path.join(A, "index.md"), '---\nokf_version: "0.1"\n---\n# Home\n\nThe starter page.\n');
const port = await new Promise((ok) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});
const serve = () => spawn(bin, [A, "--port", String(port)], { stdio: "ignore" });

const browser = await launch();
const p = (await open(browser, { viewport: { width: 1200, height: 900 } })).page;
const url = `http://127.0.0.1:${port}/wiki/index.md`;
const typeAtEnd = async (text) => {
  await p.locator("article .ProseMirror").waitFor({ state: "visible", timeout: 20000 });
  await p.locator("article .ProseMirror > p").last().click();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await p.keyboard.type(text);
};
const kept = () =>
  p.evaluate(() =>
    Object.entries(sessionStorage)
      .filter(([k]) => k.startsWith("wikishell:unsaved:"))
      .flatMap(([, v]) => JSON.parse(v).ops.map((o) => o.text)),
  );
let srv = serve();
let failed = 0;
try {
  await wait(1000);
  await p.goto(url);
  await wait(1500);
  srv.kill();
  await wait(500);
  await typeAtEnd("FIRST-KEPT paragraph.");
  await wait(4000);
  srv = serve();
  await wait(1000);
  await p.reload();
  await p.getByText("Put it back").first().waitFor({ timeout: 15000 });
  // The editor in, before the server goes again: its chunk comes from it.
  await p.locator("article .ProseMirror").waitFor({ state: "visible", timeout: 20000 });
  srv.kill();
  await wait(500);
  await typeAtEnd("SECOND paragraph.");
  await wait(4000);
  const texts = (await kept()).join(" | ");
  const ok = texts.includes("FIRST-KEPT paragraph.") && texts.includes("SECOND paragraph.");
  console.log(`${ok ? "ok  " : "FAIL"} both visits' text is kept: ${texts}`);
  if (!ok) failed++;
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(A, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
