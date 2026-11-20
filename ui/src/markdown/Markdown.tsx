import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { remarkCallout } from "./callout";
import type { Entry } from "@/api";
import { Heading, Image, PageLink, Quote, RemoteImages, RemoteImagesContext, Table, TaskItem } from "@/markdown/blocks";
import { imageSource, linkTarget } from "@/markdown/href";

/** The source position react-markdown attaches to every node it renders. */
type WithNode = { node?: { position?: { start?: { line?: number } } } };

const lineOf = (props: unknown): number | undefined =>
  (props as WithNode)?.node?.position?.start?.line;

/**
 * Renders an entry's markdown.
 *
 * The two engine rules it needs arrive as data and are applied by lookup, never
 * re-derived: an href is resolved by finding it in `entry.links`, and a heading
 * takes its id from `entry.headings`. Getting either subtly wrong is invisible —
 * a link that quietly 404s, an anchor `wiki check` calls valid that never
 * scrolls — which is why neither is computed here.
 *
 * Everything is matched by **source line**, not by walking the document and
 * counting. Counting assumes the renderer visits nodes in source order exactly
 * once, which is not a promise React makes: a double render under StrictMode is
 * enough to exhaust a cursor and silently drop every id. Positions are exact and
 * order-independent, and the server already sends a line with each heading and
 * checkbox.
 */
export function Markdown({
  entry,
  onToggleCheckbox,
  destination = (path) => "/wiki" + path,
}: {
  entry: Entry;
  /** Ticks or unticks the to-do item on that body line; absent when the page
   *  can't be written. */
  onToggleCheckbox?: (bodyLine: number, done: boolean) => void;
  /**
   * Where a link to a bundle path should go. The reader sends you to the entry;
   * a board sends you to the card when the target is one of its own, so
   * following a link inside a card does not throw away the board you are
   * reading it on.
   *
   * A function rather than a flag, because the caller is the only one that
   * knows what is on screen behind this. Resolution still happens by lookup in
   * `entry.links` — this only decides what to do with the answer.
   */
  destination?: (bundlePath: string) => string;
}) {
  // Keyed by the href exactly as written, which is what the renderer hands back.
  const links = useMemo(() => new Map(entry.links.map((l) => [l.raw, l])), [entry.links]);
    // Keyed by body line, because that is the coordinate system the rendered
  // markdown is in. The file line rides along for writes.
  const headings = useMemo(() => new Map(entry.headings.map((h) => [h.bodyLine, h])), [entry.headings]);
  // One per page view: Load all reaches this page's remote images only.
  const images = useMemo(() => new RemoteImages(), [entry.path]);
  const checkboxes = useMemo(
    () => new Map(entry.checkboxes.map((c) => [c.bodyLine, c])),
    [entry.checkboxes],
  );

  const heading = (level: number) =>
    function H({ children, ...props }: { children?: React.ReactNode }) {
      return (
        <Heading level={level} id={headings.get(lineOf(props) ?? -1)?.id}>
          {children}
        </Heading>
      );
    };

  const components: Components = {
    a({ href, title, children }) {
      return (
        <PageLink target={linkTarget(href, links)} destination={destination} title={title}>
          {children}
        </PageLink>
      );
    },

    img({ src, alt, title }) {
      return (
        <Image source={imageSource(typeof src === "string" ? src : undefined, links)} alt={alt ?? ""} title={title} />
      );
    },

    table({ children }) {
      return <Table>{children}</Table>;
    },

    // A callout is a blockquote the author labelled; `remarkCallout` has already
    // stripped the marker and left the type and label behind.
    blockquote({ node: _node, children, ...props }) {
      const callout = calloutOf(props);
      return (
        <Quote callout={callout?.type} label={callout?.label}>
          {children}
        </Quote>
      );
    },

    // The checkbox is matched through its list item, because remark-gfm gives
    // the <input> no position of its own.
    li({ children, ...props }) {
      const box = checkboxes.get(lineOf(props) ?? -1);
      if (!box) return <li>{children}</li>;
      return (
        <TaskItem
          done={box.done}
          label={box.text}
          onToggle={onToggleCheckbox && (() => onToggleCheckbox(box.bodyLine, !box.done))}
        >
          {stripRenderedCheckbox(children)}
        </TaskItem>
      );
    },

    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
  };

  return (
    <RemoteImagesContext value={images}>
      <div className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkCallout]}
          // lowlight ships 37 curated common grammars, which is the subset worth
          // having; passing more only adds to it. Anything unrecognized renders as
          // plain code rather than failing, so an omission costs colour, not a
          // page. Highlighting is ~173KB of the bundle: going below this set means
          // constructing a lowlight instance directly, which is worth doing only
          // if that number starts to matter.
          rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          components={components}
          // Raw HTML is deliberately not enabled. These files are written by agents
          // and by anyone else with the folder, so passing their HTML through would
          // make every entry author an author of the UI.
          //
          // Addresses are left as written: `href.ts` is the one rule for what a
          // link or an image may be, and react-markdown's own filter would turn
          // an unsafe link into an empty one rather than into text.
          urlTransform={(url) => url}
        >
          {entry.body}
        </ReactMarkdown>
      </div>
    </RemoteImagesContext>
  );
}

/**
 * The two data attributes `remarkCallout` leaves on a blockquote, which arrive
 * as props react-markdown has no type for.
 */
function calloutOf(props: object): { type: string; label: string } | undefined {
  const { "data-callout": type, "data-callout-label": label } = props as {
    "data-callout"?: string;
    "data-callout-label"?: string;
  };
  return type === undefined ? undefined : { type, label: label ?? "" };
}

/**
 * Drops the disabled <input> remark-gfm puts inside a task list item, since this
 * renders its own interactive one.
 */
function stripRenderedCheckbox(children: React.ReactNode): React.ReactNode {
  if (!Array.isArray(children)) return children;
  return children.filter(
    (c) => !(c && typeof c === "object" && "type" in c && (c as { type?: unknown }).type === "input"),
  );
}
