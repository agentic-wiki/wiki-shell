import { expect, test } from "bun:test";
import type { Link } from "@/api";
import { imageSource, linkTarget } from "@/markdown/href";

const link = (raw: string, extra: Partial<Link> = {}): Link => ({
  raw,
  to: "/notes/b.md",
  anchor: "",
  text: "",
  line: 1,
  exists: true,
  outside: false,
  ...extra,
});

const links = new Map(
  [
    link("./b.md"),
    link("./missing.md", { exists: false }),
    link("./diagram.png", { asset: "/raw/notes/diagram.png" }),
    link("../../above.md", { outside: true, to: "" }),
  ].map((l) => [l.raw, l]),
);

test("a link the server resolved goes where it resolved", () => {
  expect(linkTarget("./b.md", links).kind).toBe("entry");
  expect(linkTarget("./missing.md", links).kind).toBe("entry");
  expect(linkTarget("./diagram.png", links).kind).toBe("asset");
  expect(linkTarget("../../above.md", links).kind).toBe("outside");
});

test("http, https and mailto stay links; only another host opens a new tab", () => {
  expect(linkTarget("https://example.com/x", links)).toEqual({ kind: "web", href: "https://example.com/x", newTab: true });
  expect(linkTarget("//example.com/x", links)).toEqual({ kind: "web", href: "//example.com/x", newTab: true });
  expect(linkTarget("mailto:a@example.com", links)).toEqual({ kind: "web", href: "mailto:a@example.com", newTab: false });
  expect(linkTarget("#rules", links)).toEqual({ kind: "web", href: "#rules", newTab: false });
});

test("no spelling of a script address is ever a link", () => {
  for (const href of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    " javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    expect(linkTarget(href, links)).toEqual({ kind: "text" });
  }
  expect(linkTarget(undefined, links)).toEqual({ kind: "text" });
});

test("an image of the bundle loads from /raw; another site's waits; other schemes never load", () => {
  expect(imageSource("./diagram.png", links)).toEqual({ kind: "local", src: "/raw/notes/diagram.png" });
  expect(imageSource("./unknown.png", links)).toEqual({ kind: "local", src: "./unknown.png" });
  const remote = imageSource("https://images.example.com/team.png?u=1", links);
  expect(remote.kind).toBe("remote");
  expect(imageSource("//images.example.com/x.png", links).kind).toBe("remote");
  expect(imageSource("http://images.example.com/x.png", links).kind).toBe("remote");
  for (const src of ["data:image/png;base64,AAAA", "javascript:alert(1)", "file:///etc/passwd", ""]) {
    expect(imageSource(src, links)).toEqual({ kind: "none" });
  }
});
