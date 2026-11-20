// The content screenshot check (editor-adr.md, "The test"): every page of the
// fixture bundle, in both themes, at 1440 and 390 px, is shot in the reader and
// in the editor at rest, and the content (the article, without the toolbar and
// the "Updated" line, which are chrome) must be the same: the same size, and at
// most BUDGET pixels apart (the corners of a rounded box anti-alias a little
// differently inside an editor, where nothing has moved). It
// also fails on any Content-Security-Policy violation, which a library that
// writes styles at runtime would cause silently (Audy's L-3).
//
// It needs the headless browser installed by Foreman's `just browser`
// (images/browser): pass the folder of one install, `current-<cpu>`.
//
//   node ui/e2e/content.mjs <wikishell binary> <browser install>
//
// The fixture bundle is this repo's backlog plus the editor's test pages
// (ui/src/edit/testdata), but footnotes.md: the reader gathers footnotes into a
// section at the end of a page, which the editor can't, so a page with
// footnotes differs (a known limit).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bin, browserDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bin || !browserDir) {
  console.error("usage: node ui/e2e/content.mjs <wikishell binary> <browser install>");
  process.exit(2);
}
const { launch, open } = await import(path.join(browserDir, "browser.mjs"));
const { PNG } = (await import(path.join(browserDir, "node_modules/pngjs/lib/png.js"))).default ?? (await import(path.join(browserDir, "node_modules/pngjs/lib/png.js")));
const pixelmatch = (await import(path.join(browserDir, "node_modules/pixelmatch/index.js"))).default;

/** How many pixels may differ: anti-aliasing, never a moved line. */
const BUDGET = 50;

const repo = path.resolve(import.meta.dirname, "../..");
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "wikishell-content-"));
const out = path.join(repo, "ui/e2e/out");
fs.cpSync(path.join(repo, "backlog"), bundle, { recursive: true });
fs.mkdirSync(path.join(bundle, "editor"));
for (const f of fs.readdirSync(path.join(repo, "ui/src/edit/testdata"))) {
  if (f.endsWith(".md") && f !== "footnotes.md") fs.copyFileSync(path.join(repo, "ui/src/edit/testdata", f), path.join(bundle, "editor", f));
}
// The backlog's wiki.toml ignores files above it; they aren't here.
fs.writeFileSync(path.join(bundle, "wiki.toml"), 'spec = "0.1"\n');

const port = await freePort();
const server = spawn(bin, [bundle, "--port", String(port)], { stdio: "ignore" });
const base = `http://localhost:${port}`;
let failed = 0;
try {
  await until(() => fetch(base + "/").then((r) => r.ok, () => false));
  // CONTENT_PAGE narrows the run to one page, while working on it.
  const pages = walk(bundle)
    .map((f) => "/" + path.relative(bundle, f).split(path.sep).join("/"))
    .filter((p) => !process.env.CONTENT_PAGE || p === process.env.CONTENT_PAGE);
  const browser = await launch();
  fs.rmSync(out, { recursive: true, force: true });
  for (const page of pages) {
    for (const colorScheme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        const [reader, readerCSP] = await shoot(browser, page, { colorScheme, width }, "reader");
        const [editor, editorCSP] = await shoot(browser, page, { colorScheme, width }, "editor");
        const name = `${page.slice(1).replaceAll("/", "_")}-${colorScheme}-${width}`;
        for (const v of [...readerCSP, ...editorCSP]) {
          failed++;
          console.log(`FAIL ${name}: CSP blocked ${v}`);
        }
        const diff = compare(reader, editor);
        if (page === "/editor/kinds.md" && colorScheme === "light" && width === 1440) {
          for (const problem of await interact(browser, page, reader)) {
            failed++;
            console.log(`FAIL ${name}: ${problem}`);
          }
        }
        if (diff) {
          failed++;
          console.log(`FAIL ${name}: ${diff}`);
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(path.join(out, name + "-reader.png"), reader);
          fs.writeFileSync(path.join(out, name + "-editor.png"), editor);
        }
      }
    }
  }
  await browser.close();
  console.log(failed ? `${failed} failed: see ui/e2e/out` : `${pages.length} pages, 4 ways each: the editor's content is the reader's`);
} finally {
  server.kill();
  fs.rmSync(bundle, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

/**
 * The page's content as a PNG, in the reader (the editor's chunk held back, so
 * the reader stays) or in the editor at rest, and the CSP violations seen.
 */
async function shoot(browser, page, { colorScheme, width }, mode) {
  const shot = await open(browser, { viewport: { width, height: 900 }, colorScheme, deviceScaleFactor: 1 });
  await shot.context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  if (mode === "reader") await shot.context.route(/\/assets\/Editor-[^/]*\.js$/, () => {});
  const p = shot.page;
  await p.goto(base + "/wiki" + page, { waitUntil: "load" });
  await p.locator(mode === "editor" ? "article .ProseMirror" : "article .markdown").first().waitFor({ state: "visible" });
  await p.evaluate(() => document.fonts.ready);
  // The toolbar and the "Updated" line are chrome, and the clock moves.
  await p.evaluate(() => {
    for (const el of document.querySelectorAll("[data-chrome]")) el.style.visibility = "hidden";
  });
  // The whole article, however tall: a window as tall as it, since an element
  // is shot only as far as its scroller shows it. Only the width lays it out.
  const tall = await p.evaluate(() => {
    const a = document.querySelector("article").getBoundingClientRect();
    return Math.ceil(a.top + a.height + 200);
  });
  await p.setViewportSize({ width, height: Math.max(900, tall) });
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const png = await p.locator("article").first().screenshot({ animations: "disabled", caret: "hide" });
  const csp = await p.evaluate(() => window.__csp);
  await shot.context.close();
  return [png, csp];
}

/**
 * The editor in use, on one page: focused with the caret in a paragraph, the
 * content must still be the reader's (a source block keeps its rendering);
 * typing in a source block asks nothing of another host; Load does.
 */
async function interact(browser, page, reader) {
  const problems = [];
  const shot = await open(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "light", deviceScaleFactor: 1 });
  await shot.context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const p = shot.page;
  await p.goto(base + "/wiki" + page, { waitUntil: "load" });
  await p.locator("article .ProseMirror").waitFor({ state: "visible" });
  await p.evaluate(() => document.fonts.ready);
  const first = p.locator("article .ProseMirror > p").first();
  const box = await first.boundingBox();
  await p.mouse.click(box.x + box.width - 4, box.y + 10);
  await p.mouse.move(0, 0);
  // Only the view scrolls, never the page around it: a page that did could be
  // scrolled a whole window past the entry, onto nothing.
  if (await p.evaluate(() => document.scrollingElement.scrollHeight > innerHeight)) problems.push("the page itself scrolls");
  await p.evaluate(() => {
    for (const el of document.querySelectorAll("[data-chrome]")) el.style.visibility = "hidden";
  });
  const tall = await p.evaluate(() => {
    const a = document.querySelector("article").getBoundingClientRect();
    return Math.ceil(a.top + a.height + 200);
  });
  await p.setViewportSize({ width: 1440, height: Math.max(900, tall) });
  const focused = await p.locator("article").first().screenshot({ animations: "disabled", caret: "hide" });
  const moved = compare(reader, focused);
  if (moved) {
    problems.push(`focused, caret elsewhere: ${moved}`);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "focused-reader.png"), reader);
    fs.writeFileSync(path.join(out, "focused-editor.png"), focused);
  }

  await p.locator("[data-source] [data-source-shown]").first().click();
  await p.keyboard.type("x");
  await p.waitForTimeout(300);
  if (shot.refused.size !== 0) problems.push(`typing asked another host: ${shot.refused.size}`);
  await p.locator("[data-remote-image] button").first().click();
  await p.waitForTimeout(500);
  if (shot.refused.size !== 1) problems.push(`Load asked ${shot.refused.size} hosts, not 1`);
  for (const v of await p.evaluate(() => window.__csp)) problems.push(`CSP blocked ${v} while editing`);
  await shot.context.close();
  return problems;
}

/**
 * Null when two PNGs are the same size and within BUDGET; else what differs.
 * Within the budget, no cluster of more than 6 touching pixels and no run of
 * 3 in a row may differ: a lost underline or period is one of those, where
 * anti-aliasing is scattered single pixels.
 */
function compare(a, b) {
  const [x, y] = [PNG.sync.read(a), PNG.sync.read(b)];
  if (x.width !== y.width || x.height !== y.height) return `sizes ${x.width}x${x.height} and ${y.width}x${y.height}`;
  const n = pixelmatch(x.data, y.data, null, x.width, x.height, { threshold: 0 });
  if (n > BUDGET) return `${n} pixels differ`;
  if (n === 0) return null;
  const { width, height } = x;
  const off = new Uint8Array(width * height);
  for (let i = 0; i < off.length; i++) {
    const k = i * 4;
    off[i] = x.data[k] !== y.data[k] || x.data[k + 1] !== y.data[k + 1] || x.data[k + 2] !== y.data[k + 2] ? 1 : 0;
  }
  for (let i = 0; i + 2 < off.length; i++) {
    if (off[i] && off[i + 1] && off[i + 2] && i % width < width - 2) return `a run of 3 pixels differs at ${i % width},${Math.floor(i / width)}`;
  }
  const seen = new Uint8Array(off.length);
  for (let i = 0; i < off.length; i++) {
    if (!off[i] || seen[i]) continue;
    let size = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      size++;
      const cx = j % width;
      for (const k of [j - 1, j + 1, j - width, j + width]) {
        if (k < 0 || k >= off.length || seen[k] || !off[k]) continue;
        if ((k === j - 1 && cx === 0) || (k === j + 1 && cx === width - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    if (size > 6) return `a cluster of ${size} pixels differs at ${i % width},${Math.floor(i / width)}`;
  }
  console.log(`  ${n} scattered pixels differ (within ${BUDGET})`);
  return null;
}

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : []))
    .sort();
}

function freePort() {
  return new Promise((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("the server didn't start");
    await new Promise((r) => setTimeout(r, 100));
  }
}
