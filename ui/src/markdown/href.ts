import type { Link } from "@/api";

/**
 * The one rule for what a link or an image in a page may be (editor-adr.md,
 * "Security", Audy's L-1), so a page can never run code through an address.
 * Every component that draws a URL from a page goes through here: the reader
 * (Markdown.tsx turns react-markdown's own filter off for that reason), the
 * editor's link and image views, and so what is pasted, which the editor
 * draws with the same views.
 *
 * A bundle path is whatever the server resolved in `entry.links`; anything else
 * is parsed as a URL first, then judged by its scheme. Parsing first is what
 * catches the spellings a prefix check misses: `JaVaScRiPt:`, `java\tscript:`.
 * (Entities, `&#106;avascript:`, are decoded by the Markdown parser before an
 * address gets here.)
 */
export type Target =
  /** An entry of the bundle, existing or not yet written. */
  | { kind: "entry"; link: Link }
  /** A file of the bundle that isn't an entry, fetched from `/raw`. */
  | { kind: "asset"; link: Link }
  /** A path above the bundle root, which WikiShell doesn't serve. */
  | { kind: "outside"; link: Link }
  /** An http, https or mailto address, or a fragment of this page. */
  | { kind: "web"; href: string; newTab: boolean }
  /** Anything else: drawn as text, never as a link. */
  | { kind: "text" };

/** Where a link's href goes. `links` is `entry.links` keyed by `raw`. */
export function linkTarget(href: string | undefined, links: ReadonlyMap<string, Link>): Target {
  if (href === undefined) return { kind: "text" };
  const link = links.get(href);
  if (link?.outside) return { kind: "outside", link };
  if (link?.asset) return { kind: "asset", link };
  if (link) return { kind: "entry", link };
  const url = parse(href);
  if (!url) return { kind: "text" };
  if (url.protocol === "mailto:") return { kind: "web", href, newTab: false };
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "text" };
  // Only an address naming a host leaves the app; a fragment or a relative
  // path the server didn't resolve stays as authored, in this tab.
  return { kind: "web", href, newTab: external(href) };
}

/**
 * Where an image's src comes from. A file of the bundle loads at once, from
 * `/raw`; one from another site waits for a click (the remote-image chip); any
 * other scheme (`data:`, `file:`, `javascript:`) is never loaded.
 */
export type ImageSource =
  | { kind: "local"; src: string }
  | { kind: "remote"; url: URL }
  | { kind: "none" };

export function imageSource(src: string | undefined, links: ReadonlyMap<string, Link>): ImageSource {
  if (!src) return { kind: "none" };
  const asset = links.get(src)?.asset;
  if (asset) return { kind: "local", src: asset };
  const url = parse(src);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return { kind: "none" };
  // A relative path the server didn't resolve: as authored, from this server.
  // Anything naming a host, `//host/x.png` included, is another site's.
  return external(src) ? { kind: "remote", url } : { kind: "local", src };
}

/**
 * Whether an address names its own host: a scheme, or `//`. Read from the
 * address as the URL parser reads it, which drops tabs and line breaks
 * anywhere and leading spaces and control characters.
 */
function external(href: string): boolean {
  const s = href.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "");
  return /^[a-z][a-z0-9+.-]*:/i.test(s) || /^[\\/]{2}/.test(s);
}

/** A URL resolved against a base that is never a real page, so a relative
 *  address parses without borrowing anything from the current one. */
function parse(href: string): URL | null {
  try {
    return new URL(href, BASE);
  } catch {
    return null;
  }
}

const BASE = new URL("http://relative.invalid/");
