import { Children, createContext, isValidElement, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import type { ImageSource, Target } from "@/markdown/href";
import { Glyph } from "@/ui/IconButton";

/**
 * The markup of a page's content, one component per kind, shared by the reader,
 * the editor and the changes view's rendered diff (editor-adr.md, "From reader
 * to editor"). The editor replaces the reader with the same pixels only because
 * both draw through here: a class changed in one place changes in all.
 */

/** A heading, with the `#` that links to it on hover. */
export function Heading({ level, id, children }: { level: number; id?: string; children?: ReactNode }) {
  const Tag = `h${Math.min(Math.max(level, 1), 6)}` as "h1";
  return (
    <Tag id={id || undefined} className={HEADING}>
      {children}
      {id && <HeadingAnchor id={id} />}
    </Tag>
  );
}

/** The heading's `#`: a link to the section, shown on hover. */
export function HeadingAnchor({ id }: { id: string }) {
  return (
    <a
      href={"#" + id}
      aria-label="Link to this section"
      className={ANCHOR}
    >
      #
    </a>
  );
}

/** The classes of the content's markup, shared with the editor's views. */
export const LINK = "text-accent-ink underline decoration-1 underline-offset-2";
export const MISSING = "text-muted underline decoration-dotted underline-offset-2";
export const TASK_ITEM = "flex items-start gap-2";
export const CHECKBOX = "accent-accent mt-1.5 size-3.5 shrink-0 cursor-pointer disabled:cursor-default";
export const DONE = "text-muted line-through";
export const HEADING = "group scroll-mt-16";
export const ANCHOR =
  "text-muted hover:text-accent-ink ml-2 no-underline opacity-0 transition-opacity group-hover:opacity-100";
export const TABLE = "markdown-table";
export const IMAGE = "max-w-full rounded-md";

/** How a link is drawn: the one rule, for the reader and the editor alike. */
export interface LinkProps {
  /** `a` follows; `span` is text that only looks like a link. */
  tag: "a" | "span";
  href?: string;
  /** A bundle path, which the app's router follows. */
  route?: boolean;
  className: string;
  title?: string;
  newTab: boolean;
}

/**
 * How a link to `target` is drawn. `destination` maps a bundle path to a
 * route: the reader's, or a board's when the target is one of its cards.
 */
export function linkProps(target: Target, destination: (bundlePath: string) => string, title?: string): LinkProps {
  switch (target.kind) {
    // WikiShell serves this bundle and nothing above it. As an anchor, a
    // relative href would resolve against the current route, and a click
    // would load a 404.
    case "outside":
      return { tag: "span", className: MISSING, title: `${target.link.raw} is outside this bundle`, newTab: false };
    // A file the bundle carries: a new tab, so the reader stays where it was.
    // `/raw` needs no token; the server's Host check guards it.
    case "asset":
      return {
        tag: "a",
        href: target.link.asset,
        className: LINK,
        title: `${target.link.to} — opens in a new tab`,
        newTab: true,
      };
    // Not an error: a link may point at knowledge not yet written.
    case "entry":
      return {
        tag: "a",
        href: destination(target.link.to) + (target.link.anchor ? "#" + target.link.anchor : ""),
        route: true,
        className: target.link.exists ? LINK : MISSING,
        title: target.link.exists ? title : "This entry does not exist yet",
        newTab: false,
      };
    case "web":
      return { tag: "a", href: target.href, className: LINK, title, newTab: target.newTab };
    case "text":
      return { tag: "span", className: "", newTab: false };
  }
}

/** A link, drawn by `linkProps`. */
export function PageLink({
  target,
  destination,
  title,
  children,
}: {
  target: Target;
  destination: (bundlePath: string) => string;
  /** The link's own title, `[text](url "title")`. */
  title?: string;
  children?: ReactNode;
}) {
  const p = linkProps(target, destination, title);
  if (p.tag === "span") return p.className ? <span className={p.className} title={p.title}>{children}</span> : <>{children}</>;
  if (p.route) return <RouterLink to={p.href!} className={p.className} title={p.title}>{children}</RouterLink>;
  return (
    <a href={p.href} className={p.className} title={p.title} {...(p.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  );
}

/** An image: a file of the bundle at once, another site's behind **Load**. */
export function Image({ source, alt, title }: { source: ImageSource; alt: string; title?: string }) {
  if (source.kind === "remote") return <RemoteImage url={source.url} alt={alt} />;
  if (source.kind === "none") return <>{alt}</>;
  return <img src={source.src} alt={alt} title={title} loading="lazy" className={IMAGE} />;
}

/** A table, scrolled by its wrapper (see `.markdown-table` in `index.css`). */
export function Table({ children }: { children?: ReactNode }) {
  return (
    <div className={TABLE}>
      <table>{children}</table>
    </div>
  );
}

/** A blockquote, or a callout when its author gave it a type. */
export function Quote({ callout, label, children }: { callout?: string; label?: string; children?: ReactNode }) {
  if (callout === undefined) return <blockquote>{children}</blockquote>;
  return (
    <blockquote data-callout={callout}>
      <p className="callout-label">{label}</p>
      {children}
    </blockquote>
  );
}

/** A to-do item: its box ticks on click; its text is struck once done. */
export function TaskItem({
  done,
  label,
  onToggle,
  children,
}: {
  done: boolean;
  /** The item's text, for the box's accessible name. */
  label: string;
  /** Absent when the page can't be written: the box is shown, not live. */
  onToggle?: () => void;
  children?: ReactNode;
}) {
  return (
    <li className={TASK_ITEM}>
      <input
        type="checkbox"
        checked={done}
        disabled={!onToggle}
        onChange={() => onToggle?.()}
        aria-label={label}
        className={CHECKBOX}
      />
      <span>
        {/* Only the item's own text is struck: a nested list is the items' own. */}
        <span className={done ? DONE : undefined}>{own(children)}</span>
        {nested(children)}
      </span>
    </li>
  );
}

const isList = (c: ReactNode) => isValidElement(c) && (c.type === "ul" || c.type === "ol");
const own = (children: ReactNode) => Children.toArray(children).filter((c) => !isList(c));
const nested = (children: ReactNode) => Children.toArray(children).filter(isList);

/**
 * The remote images of one page view, so **Load all** reaches every one of
 * them and no other page's. A page view gets a new store, so nothing loaded
 * here stays loaded on the next visit: remembering it would let a page fetch
 * silently later, which is what the chip protects against.
 */
export class RemoteImages {
  private count = 0;
  private all = 0;
  private listeners = new Set<() => void>();
  private snapshot = { count: 0, all: 0 };

  /** Adds an image to the page; returns how to take it off again. */
  add(): () => void {
    this.count++;
    this.emit();
    return () => {
      this.count--;
      this.emit();
    };
  }

  /** Loads every image on the page. */
  loadAll() {
    this.all++;
    this.emit();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  read = () => this.snapshot;

  private emit() {
    this.snapshot = { count: this.count, all: this.all };
    for (const l of this.listeners) l();
  }
}

export const RemoteImagesContext = createContext<RemoteImages | null>(null);

/** Alt text longer than this is cut, whole in the tooltip. */
const ALT_MAX = 40;

/**
 * A remote image, waiting for a click (the CEO, 2026-11-20; remote-images.md).
 * Until **Load**, nothing in the DOM names its address, so the browser never
 * fetches it: no `src`, no `srcset`, no preload.
 */
export function RemoteImage({ url, alt }: { url: URL; alt: string }) {
  const page = useContext(RemoteImagesContext);
  const none = { count: 1, all: 0 };
  const { count, all } = useSyncExternalStore(page?.subscribe ?? noSubscribe, page?.read ?? (() => none));
  const [state, setState] = useState<"waiting" | "loading" | "loaded" | "failed">("waiting");
  // The Load all count this image has seen: a click after it loads this one.
  const [seen] = useState(all);

  // A plain http image never loads: the page's CSP allows https images only.
  const loadable = url.protocol === "https:";
  useEffect(() => (loadable ? page?.add() : undefined), [page, loadable]);
  useEffect(() => {
    if (loadable && all > seen) setState((s) => (s === "waiting" || s === "failed" ? "loading" : s));
  }, [all, seen, loadable]);

  // `URL.host` is already the ASCII (punycode) form, so a look-alike name can't
  // pass as a known one; the path and query, where a beacon hides its data,
  // are never shown.
  const host = (url.protocol === "http:" ? "http://" : "") + url.host;
  const name = alt.trim() || "Image";
  const cut = name.length > ALT_MAX ? name.slice(0, ALT_MAX - 1) + "…" : name;

  if (state === "loading" || state === "loaded") {
    return (
      <>
        <img
          src={url.href}
          alt={alt}
          className={[
            IMAGE,
            state === "loading" ? "hidden" : "animate-wv-fade motion-reduce:animate-none",
          ].join(" ")}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
        {state === "loading" && <Chip host={host} name={cut} title={name} busy />}
      </>
    );
  }
  if (!loadable) return <Chip host={host} name={cut} title={name} httpOnly />;
  return (
    <Chip
      host={host}
      name={state === "failed" ? "Couldn't load" : cut}
      title={name}
      failed={state === "failed"}
      onLoad={() => setState("loading")}
      onLoadAll={count >= 2 ? () => page?.loadAll() : undefined}
      count={count}
    />
  );
}

const noSubscribe = () => () => {};

function Chip({
  host,
  name,
  title,
  busy = false,
  failed = false,
  httpOnly = false,
  onLoad,
  onLoadAll,
  count = 0,
}: {
  host: string;
  name: string;
  title: string;
  busy?: boolean;
  failed?: boolean;
  /** A plain http image, which can't load: no Load, and says why. */
  httpOnly?: boolean;
  onLoad?: () => void;
  onLoadAll?: () => void;
  count?: number;
}) {
  return (
    <>
      <span
        role="group"
        aria-label={
          httpOnly ? `Image: ${title}, from ${host}. Only https images load.` : `Image from ${host}, not loaded: ${title}`
        }
        data-print="hide"
        data-remote-image=""
        className="bg-panel-2 border-line inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border px-2.5 py-0.5 align-middle text-[13px] leading-5"
      >
        <Glyph size={16} className="text-muted shrink-0">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m21 16-5-5-8 8" />
        </Glyph>
        <span className="text-muted min-w-0 truncate" title={title}>
          {name}
        </span>
        <span className="text-muted font-mono break-all" aria-hidden>
          {host}
        </span>
        {httpOnly ? (
          <span className="text-faint">Only https images load</span>
        ) : busy ? (
          <span className="border-muted size-3.5 animate-wv-spin rounded-full border-2 border-t-transparent" role="status" aria-label="Loading" />
        ) : (
          <>
            <button
              type="button"
              onClick={onLoad}
              aria-label={`Load image from ${host}`}
              className="text-accent-ink relative font-medium after:absolute after:-inset-x-1 after:-inset-y-1.5 hover:underline"
            >
              {failed ? "Try again" : "Load"}
            </button>
            {onLoadAll && (
              <button
                type="button"
                onClick={onLoadAll}
                aria-label={`Load all ${count} images on this page`}
                className="text-accent-ink relative font-medium after:absolute after:-inset-x-1 after:-inset-y-1.5 hover:underline"
              >
                Load all ({count})
              </button>
            )}
          </>
        )}
        {failed && (
          <span role="status" className="sr-only">
            Couldn&apos;t load the image from {host}
          </span>
        )}
      </span>
      <span data-print="only">
        [Image: {title}, from {host}]
      </span>
    </>
  );
}
