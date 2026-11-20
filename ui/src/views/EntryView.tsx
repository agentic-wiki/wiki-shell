import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError, type Backlink, type Entry, type Heading, type Op, type Ref } from "@/api";
import { isCurrent, recall, remember } from "@/cache";
import { Markdown } from "@/markdown/Markdown";
import { useWidth, WidthToggle, type Width } from "@/shell/Width";
import { useEscape } from "@/ui/escape";
import { useToast } from "@/ui/Toast";
import { tickOp } from "@/markdown/tick";
import { AddField, FieldValue, RemoveField } from "@/views/fields";
import { dropKept, type Early, editorPrefetch, type Kept, keptAll, putKept, settleSaves, type SaveState, typing, useEditorModule } from "@/editing";
import { usePeek } from "@/ui/peek";
import { NotCommitted } from "@/changes/NotCommitted";
import { useBundle } from "@/bundle";
import { groupOf, groupsUnder, NEUTRAL, tagColour } from "@/colour";
import { NARROW, useInlineSize, useMedia } from "@/media";
import { useBundleState } from "@/state";
import { age } from "@/time";
import { nameOf } from "@/tree";
import { Glyph, IconButton } from "@/ui/IconButton";
import { GroupChip } from "@/ui/GroupChip";
import { SectionLabel } from "@/ui/SectionLabel";
import { saveFile } from "@/save";
import { count } from "@/count";
import { NotFound } from "@/views/NotFound";
import { Loading } from "@/views/Loading";

export function EntryView({
  path,
  version,
  refresh,
  changedAt,
  destination = (bundlePath) => "/wiki" + bundlePath,
  queued,
  onQueue,
  inCard = false,
  properties = [],
}: {
  path: string;
  version: number;
  refresh: number;
  /** Whether this entry is in the read-later queue. */
  queued: boolean;
  /** Puts it in, or takes it out. */
  onQueue: () => void;
  /** The version this entry's content last moved at, from the tree. Undefined
   *  for a path the tree does not list, which is a reason to fetch rather than
   *  to trust a copy. */
  changedAt?: number;
  /** True when rendered inside a card sheet. The sheet has a fixed width so the
   *  page-width toggle would be a no-op there, and it is hidden accordingly. */
  inCard?: boolean;
  /**
   * Property rows the caller draws itself, first in the grid and in place of
   * those keys' plain values: a board's status and lane as controls that move
   * the card. Drawn even when the entry lacks the key, since choosing one is how
   * it gets it.
   */
  properties?: Property[];
  /**
   * Where a link to a bundle path should go, for *every* link this view draws:
   * the body, the frontmatter references, the backlinks.
   *
   * A board overrides it, so following something that is already on the board
   * opens that card instead of throwing away the board you were reading it on.
   * The reader leaves it alone and stays in the reader — which is why this is the
   * caller's rule rather than this view's: only the caller knows what is on
   * screen behind the entry.
   *
   * It used to reach the body alone, so one card obeyed the board in its prose
   * and left for the reader from a `blockers` chip: three link surfaces in one
   * view, one of which asked.
   */
  destination?: (bundlePath: string) => string;
}) {
  // What is on screen, and which path it is. The two travel together because
  // the fetch below is what makes them agree, and until it lands they do not:
  // the outgoing entry stays rendered while the incoming one is in flight.
  //
  // That is deliberate. Blanking instead would be honest for the few
  // milliseconds a local read takes, and it would cost the whole layout: the
  // view collapses to nothing, so the browser clamps the scroll position to
  // zero, and the restored position for a back navigation is lost before the
  // content that could hold it exists. A brief stale render is cheaper than a
  // reader that cannot go back.
  const [loaded, setLoaded] = useState<{ path: string; entry: Entry } | null>(null);
  const [error, setError] = useState<{ path: string; message: string; status?: number } | null>(null);
  const narrow = useMedia(NARROW);
  const [width, setWidth] = useWidth();
  // The room the reader has: the window less whatever panels are open beside
  // it. It decides whether wide can change anything.
  const [area, room] = useInlineSize();

  useEffect(() => {
    // A copy taken at or after the version this entry last moved at *is* the
    // file, so there is nothing to ask for. This is the common case in a
    // session: most navigation revisits, and most versions move because of some
    // other entry — which is exactly when a bundle-wide check would refetch
    // everything for nothing.
    if (isCurrent(path, changedAt)) {
      setError(null);
      return;
    }
    const ac = new AbortController();
    api
      .entry(path, ac.signal)
      .then((e) => {
        if (!ac.signal.aborted) {
          remember(path, e, version);
          setLoaded({ path, entry: e });
          setError(null);
        }
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError({ path, message: String(e.message ?? e), status: (e as { status?: number }).status });
      });
    return () => ac.abort();
  }, [path, refresh, changedAt, version]);

  // The entry this path is showing, read during render so one visited earlier is
  // on screen in the same commit as the navigation rather than a frame after it.
  // Undefined until a first visit lands, which is when the outgoing entry below
  // keeps the layout — and its scroll position — from collapsing.
  // The editor's save status for the page on screen. A page left with a save
  // still failing says so in a toast, since its status has gone with it.
  const toast = useToast();
  const navigate = useNavigate();
  const [save, setSave] = useState<{ path: string; state: SaveState; act: () => void } | null>(null);
  const here = useRef(path);
  here.current = path;
  const statusFor = useCallback(
    (page: string, title: string) => (state: SaveState, act: () => void) => {
      if (here.current === page) setSave({ path: page, state, act });
      else if (state.kind === "failed") {
        toast(`${title} is not saved yet.`, "danger", { label: "Open it", run: () => navigate("/wiki" + page) });
      }
    },
    [toast, navigate],
  );
  const reload = useCallback(async () => {
    const fresh = await api.entry(path);
    remember(path, fresh, version);
    setLoaded({ path, entry: fresh });
    return fresh;
  }, [path, version]);

  const shown = loaded?.path === path ? loaded.entry : recall(path)?.entry;
  const entry = shown ?? loaded?.entry ?? null;

  const toggle = useCallback(
    async (bodyLine: number, done: boolean) => {
      // A checkbox belongs to the entry it was rendered from. While a first
      // visit is in flight that entry is not the one at `path`.
      if (!shown) return;
      const op = tickOp(shown, bodyLine, done);
      if (!op) return;
      // Applied optimistically, then confirmed by the refetch the version bump
      // triggers. Kept as well as shown: without that, navigating away and back
      // would render the copy taken before the tick, and read as a failed write.
      const next = {
        ...shown,
        checkboxes: shown.checkboxes.map((c) => (c.bodyLine === bodyLine ? { ...c, done } : c)),
      };
      remember(path, next, version);
      setLoaded({ path, entry: next });
      let failed: string | null = null;
      try {
        const saved = await api.saveBlocks(path, shown.version, shown.blocks.map((b) => b.hash), [op]);
        if (saved.conflicts.length > 0) failed = "Not saved: this item changed outside WikiShell.";
      } catch (err) {
        failed = "Not saved: " + String((err as Error).message);
      }
      if (!failed) return;
      // The page as it is on disk, which says what the box really is.
      toast(failed, "danger");
      api
        .entry(path)
        .then((fresh) => {
          remember(path, fresh, version);
          setLoaded({ path, entry: fresh });
        })
        .catch(() => {});
    },
    [shown, path, version, toast],
  );

  // A missing entry is not an error in this format: a link may point at
  // knowledge not yet written. It gets a placeholder, not a stack of red text.
  // Only the current path's failure counts — a 404 left over from an entry you
  // have already navigated away from is not about this one.
  // A page on screen in the editor and deleted outside stays: the editor
  // says so above the body and offers to restore it, and editing goes on (the
  // design's §3). Anywhere else, a missing entry is the not-found page.
  const deleted = error?.path === path && error.status === 404 && loaded?.path === path && loaded.entry.editable;
  if (error?.path === path && !deleted) {
    return <NotFound path={path} hint="There is no entry here yet" />;
  }
  if (!entry) return <Loading />;

  const title = pageTitle(entry);
  const sections = contents(entry.headings, title?.id);
  // Wide is offered only while the article is held at the reading width with
  // room to spare; otherwise it would change nothing. (Unmeasured, it is
  // offered.)
  const widens = room === null || room > READING;

  return (
    <div
      ref={area}
      className={[
        "flex justify-center",
        inCard ? "px-5 pt-5 pb-6" : narrow ? "px-4.5 pt-5.5 pb-15" : "px-12 pt-11 pb-24",
      ].join(" ")}
    >
      <article className="reading-column animate-wv-fade min-w-0 flex-1">
        {/* In a sheet, the sheet's own header carries the group, the bookmark
            and the ways out, and "Open as page" names the path: nothing is left
            for a toolbar to say, so the title comes first. */}
        {!inCard && (
          <Toolbar
            entry={entry}
            queued={queued}
            onQueue={onQueue}
            width={widens ? width : undefined}
            onWidth={setWidth}
            save={save?.path === entry.path ? save : null}
          />
        )}
        {/* The title comes first whichever source it has, so every entry is
            laid out the same way: toolbar, title, what it is, then the body.
            It is the entry's own opening heading, lifted out of the body, or
            the title the entry carries when the body does not name itself. */}
        {title && (
          <h1
            id={title.id}
            className={[
              "text-fg scroll-mt-16 text-balance",
              inCard
                ? "mb-2.5 text-[23px] leading-[1.2] font-semibold tracking-[-0.02em]"
                : "mb-3 text-[clamp(28px,4vw,38px)] leading-[1.12] font-bold tracking-[-0.03em]",
            ].join(" ")}
          >
            {title.text}
          </h1>
        )}
        <Meta entry={entry} />
        <Frontmatter entry={entry} destination={destination} properties={properties} />
        {/* A header the library couldn't read gives no fields, so the page
            would otherwise look as if it simply had none. Said above the body,
            which still renders, with the library's own reason. */}
        {entry.frontmatterError && (
          <p
            role="status"
            className="text-warn bg-warn/8 border-warn/25 mb-5 rounded-lg border px-2.5 py-2 text-xs"
          >
            This entry&apos;s frontmatter couldn&apos;t be read: {entry.frontmatterError}. Fix it,
            then run <code>wiki check</code>.
          </p>
        )}
        <Body
          entry={entry}
          title={title}
          destination={destination}
          onStatus={statusFor(entry.path, title?.text ?? entry.title)}
          deleted={Boolean(deleted)}
          onReload={reload}
          reader={
            <Markdown
              entry={title?.hoisted ?? entry}
              onToggleCheckbox={entry.editable ? toggle : undefined}
              destination={destination}
            />
          }
        />
        <Connections entry={entry} destination={destination} />
      </article>
      {!inCard && sections.length >= 2 && <HeadingMap sections={sections} />}
    </div>
  );
}

/**
 * The page's title, and the body to render under it.
 *
 * Three cases. The body opens with an H1 of its own: that heading is the title,
 * lifted out so it sits above the metadata like every other title, and its line
 * is blanked in the body handed to the renderer — blanked, not removed, because
 * checkboxes and headings are matched by source line and a removed line would
 * shift every one below it. The body does not name itself: the entry's title.
 * The body names itself some other way — a setext H1, or an opening line that
 * says the title in prose — which is the author's choice, left alone.
 */
function pageTitle(entry: Entry): { text: string; id?: string; hoisted?: Entry } | null {
  const lines = entry.body.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const opening = first < 0 ? undefined : entry.headings.find((h) => h.bodyLine === first + 1);
  // ATX only (`# Title`). A setext heading spans two lines, and blanking one of
  // them would leave the underline to render as a rule.
  if (opening?.level === 1 && /^#\s/.test(lines[first]!)) {
    const blanked = lines.map((l, i) => (i === first ? "" : l)).join("\n");
    return { text: opening.text, id: opening.id, hoisted: { ...entry, body: blanked } };
  }
  return alreadyNamed(entry) ? null : { text: entry.title };
}

/**
 * Whether the body already announces what the entry is called.
 *
 * Two ways it can, and both mean a prepended title would be a repetition the
 * author did not write. Whether a line is a heading comes from the headings
 * table rather than from parsing the markdown again — the engine already said
 * where every heading is, and a second opinion about what counts as one is the
 * duplication this API shape exists to avoid.
 */
function alreadyNamed(entry: Entry): boolean {
  const lines = entry.body.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return true; // an empty body has nothing to sit above

  // The body opens with a title of its own, whatever it says — an H1 that could
  // not be lifted (a setext one). Adding a title above it would give the entry
  // two, one of which nobody wrote. An opening H2 is a section, not a title,
  // and the entry's title goes above it like above any other body.
  if (entry.headings.some((h) => h.bodyLine === first + 1 && h.level === 1)) return true;

  // Or an H1 further down says exactly the title: an untitled entry takes its
  // title from its first heading, and prose before it would otherwise put the
  // same heading above the body and again in it.
  if (entry.headings.some((h) => h.level === 1 && h.text === entry.title)) return true;

  // Or the first line already says the title in prose — "**A markdown reader by
  // default.**" under a title about the reader. Compared loosely, on lowercase
  // and stripped of markdown emphasis, because the question is whether a reader
  // would see the same words twice, not whether the strings match.
  const opening = lines[first]!.toLowerCase().replace(/[*_`#>]/g, "").trim();
  const title = entry.title.toLowerCase().trim();
  return title.length > 0 && opening.includes(title);
}

/**
 * Above the title: where the entry lives, and what you can do with it.
 *
 * A row rather than three floated buttons. The floats were there because the
 * buttons had nothing dependable to attach to; the row is that thing, and it is
 * always present.
 */
function Toolbar({
  entry,
  queued,
  onQueue,
  width,
  onWidth,
  save,
}: {
  entry: Entry;
  queued: boolean;
  onQueue: () => void;
  /** Absent when wide would change nothing, and so is not offered. */
  width?: Width;
  onWidth: (width: Width) => void;
  /** The editor's save status, once it holds this page. */
  save: { state: SaveState; act: () => void } | null;
}) {
  return (
    <div data-chrome="" className="mb-3.5 flex flex-wrap items-center gap-2">
      <GroupChip path={entry.path} />
      <span className="text-faint min-w-0 truncate font-mono text-xs">{entry.path}</span>
      <div className="flex-1" />
      {!entry.editable && <ReadOnly />}
      {save && <SaveStatus save={save} />}
      <NotCommitted path={entry.path} />
      <div data-print="hide" className="flex gap-0.5">
        {width && <WidthToggle width={width} onChange={onWidth} />}
        {downloadable(entry) && <Download path={entry.path} />}
        <QueueButton queued={queued} onQueue={onQueue} />
        <Print />
      </div>
    </div>
  );
}

/**
 * The page's body: the reader, and once the editor's chunk is here, the editor
 * in its place. The editor mounts hidden and is swapped in when it holds the
 * page, in one commit, so a large page never shows blank and nothing moves.
 * If the chunk can't be loaded, the reader stays, ticking still works, and a
 * toast says editing is off.
 */
function Body({
  entry,
  title,
  destination,
  reader,
  onStatus,
  onReload,
  deleted,
}: {
  entry: Entry;
  title: ReturnType<typeof pageTitle>;
  destination: (bundlePath: string) => string;
  reader: ReactNode;
  onStatus: (state: SaveState, act: () => void) => void;
  /** Reads the page again, after kept text was put back. */
  onReload: () => Promise<Entry>;
  /** The page was deleted outside while on screen. */
  deleted: boolean;
}) {
  const toast = useToast();
  const unavailable = useCallback(() => toast("Editing is unavailable: reload the page to try again.", "danger"), [toast]);
  const module = useEditorModule(entry.editable, unavailable);
  const [mounted, setMounted] = useState<string | null>(null);
  // A new editor after kept text is put back, on the page as it then is.
  const [epoch, setEpoch] = useState(0);
  const { bundle } = useBundle();
  const [kept, setKept] = useState(() => keptAll(bundle.id, entry.path));
  // The kept copies part of which met changes made outside, by session.
  const [partly, setPartly] = useState<string[]>([]);
  // A click in the reader, and the keys typed after it, before the editor is
  // in: held, and replayed in it once it is on screen.
  const editorRef = useRef<{ replay: (early: Early) => void } | null>(null);
  const early = useEarly(entry.editable && editorPrefetch.enabled && mounted !== entry.path + ":" + epoch);
  useLayoutEffect(() => {
    if (mounted !== entry.path + ":" + epoch || !editorRef.current) return;
    editorRef.current.replay(early.take());
  }, [mounted, entry.path, epoch, early]);
  useEffect(() => setKept(keptAll(bundle.id, entry.path)), [bundle.id, entry.path]);

  const bar =
    entry.editable &&
    kept.map((k) => (
      <KeptBar
        key={k.session}
        kept={k}
        partly={partly.includes(k.session)}
        onPut={async () => {
          try {
            // Through the normal save, so it meets changes made since as any
            // save does. What the page doesn't hold afterwards met one: it
            // stays kept, here, and is never lost (Audy's L-2).
            await api.saveBlocks(entry.path, k.base, k.baseBlocks, k.ops);
            const fresh = await onReload();
            const left = notIn(k.ops, fresh.blocks);
            if (left.length) {
              putKept({ ...k, ops: left }, entry.path);
              setPartly((p) => [...p, k.session]);
            } else dropKept(bundle.id, entry.path, k.session);
            setKept(keptAll(bundle.id, entry.path));
            setEpoch((e) => e + 1);
          } catch (err) {
            toast("Not saved: " + String((err as Error).message), "danger");
          }
        }}
        onDrop={() => {
          dropKept(bundle.id, entry.path, k.session);
          setKept(keptAll(bundle.id, entry.path));
        }}
      />
    ));
  const ready = Boolean(module) && mounted === entry.path + ":" + epoch;
  return (
    <>
      {bar}
      {!ready && <div onPointerDown={early.down}>{reader}</div>}
      {module && <div hidden={!ready}>
        <module.Editor
          key={entry.path + ":" + epoch}
          entry={entry}
          from={title?.hoisted ? 1 : 0}
          title={title?.text ?? entry.title}
          destination={destination}
          onReady={(editor) => {
            editorRef.current = editor;
            setMounted(entry.path + ":" + epoch);
          }}
          onStatus={onStatus}
          bundle={bundle.id}
          deleted={deleted}
        />
      </div>}
    </>
  );
}

/**
 * Holds early input while `holding`: a click in the reader's text records its
 * point (a click on a link, a box, an anchor or an image keeps its reader
 * behaviour and isn't held), and typing keys after it are held, in order, with
 * their default prevented. `take` hands them over and starts afresh.
 */
function useEarly(holding: boolean) {
  const held = useRef<Early>({ point: null, keys: [] });
  useEffect(() => {
    if (!holding) return;
    const key = (e: KeyboardEvent) => {
      if (!held.current.point || !typing(e)) return;
      e.preventDefault();
      held.current.keys.push(e.key);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [holding]);
  return useMemo(
    () => ({
      down: (e: React.PointerEvent) => {
        if (!holding || e.button !== 0) return;
        if ((e.target as Element).closest("a, input, img, button, [data-remote-image]")) return;
        held.current = { point: { x: e.clientX, y: e.clientY }, keys: [] };
      },
      take: () => {
        const out = held.current;
        held.current = { point: null, keys: [] };
        return out;
      },
    }),
    [holding],
  );
}

/**
 * The kept operations the page doesn't hold: a replace or insert whose text
 * isn't one of its blocks, a delete whose block is still there.
 */
function notIn(ops: Op[], blocks: Entry["blocks"]): Op[] {
  const texts = new Set(blocks.map((b) => b.text));
  const hashes = new Set(blocks.map((b) => b.hash));
  return ops.filter((op) => (op.op === "delete" ? hashes.has(op.hash) : "text" in op && op.text !== undefined && !texts.has(op.text)));
}

/**
 * Text a reload left unsaved, offered back above the body (the design's §2),
 * shown as it was typed, so the user sees what goes in before it does.
 */
function KeptBar({ kept, partly, onPut, onDrop }: { kept: Kept; partly: boolean; onPut: () => void; onDrop: () => void }) {
  const text = kept.ops
    .map((op) => ("text" in op && op.text !== undefined ? op.text : op.op === "delete" ? "(a block deleted)" : ""))
    .filter(Boolean)
    .join("\n\n");
  return (
    <div role="status" data-print="hide" className="bg-panel-2 text-fg mb-5 rounded-lg px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden className="bg-warn size-[7px] shrink-0 rounded-full" />
        <span className="flex-1">
          {partly
            ? "Part of your text met changes made outside WikiShell, and wasn't put back. It's kept here."
            : `You have text on this page that was not saved (${age(new Date(kept.at).toISOString())}).`}
        </span>
        {!partly && (
          <button type="button" onClick={onPut} className="text-accent-ink font-medium hover:underline">
            Put it back
          </button>
        )}
        <button type="button" onClick={onDrop} className="text-muted font-medium hover:underline">
          Throw it away
        </button>
      </div>
      <pre className="text-muted mt-2 max-h-40 overflow-auto font-mono text-[12px] whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

/**
 * The save status, left of the toolbar's buttons: as little as it can say
 * (the design's §2). Nothing at rest; "Saving…" only past a second; "Saved"
 * for two seconds; "Not saved" until a save lands, with why on hover.
 */
function SaveStatus({ save }: { save: { state: SaveState; act: () => void } }) {
  const { state, act } = save;
  const [, tick] = useState(0);
  const reason = useId();
  // Wakes once when "Saving…" should appear or "Saved" go.
  useEffect(() => {
    const wait = state.kind === "saving" ? 1000 : state.kind === "saved" ? 2000 : null;
    if (wait === null) return;
    const t = setTimeout(() => tick((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [state]);
  const now = Date.now();
  let shown: ReactNode = null;
  // What a screen reader hears: a failure and what to check, never each save.
  let said = "";
  if (state.kind === "saving" && now - state.since >= 1000) shown = <span className="text-faint">Saving…</span>;
  else if (state.kind === "saved" && now - state.at < 2000) shown = <span className="text-faint">Saved</span>;
  else if (state.kind === "failed") {
    said = state.reason;
    shown = (
      <span className="group relative flex items-center gap-1.5">
        <span aria-hidden className="bg-danger size-[7px] shrink-0 rounded-full" />
        <span className="text-danger">Not saved</span>
        <button
          type="button"
          onClick={act}
          aria-describedby={reason}
          className="text-accent-ink font-medium hover:underline"
        >
          Try again
        </button>
        {/* Why, on hover and on focus alike. */}
        <span
          id={reason}
          role="tooltip"
          className="bg-elev shadow-float text-fg invisible absolute top-full right-0 z-80 mt-1.5 w-max max-w-[min(320px,80vw)] rounded-lg px-2.5 py-1.5 text-[12.5px] group-focus-within:visible group-hover:visible"
        >
          {state.reason}
        </span>
      </span>
    );
  } else if (state.kind === "conflicts") {
    said = state.label;
    shown = (
      <button type="button" onClick={act} className="flex items-center gap-1.5 hover:underline">
        <span aria-hidden className="bg-warn size-[7px] shrink-0 rounded-full" />
        <span className="text-fg">{state.label}</span>
      </button>
    );
  } else if (state.kind === "gone")
    shown = (
      <>
        <span aria-hidden className="bg-warn size-[7px] shrink-0 rounded-full" />
        <span className="text-fg">This page was deleted outside WikiShell.</span>
      </>
    );
  return (
    <span data-print="hide" className="flex items-center gap-1.5 text-[12.5px]">
      {shown}
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
    </span>
  );
}

/**
 * Says the page can't be changed here, and why on hover: the one sign of it,
 * since an editable page has no sign at all.
 */
export function ReadOnly() {
  const { bundle } = useBundle();
  const toast = useToast();
  const why = bundle.editable
    ? "This page is too long to edit here: it has over 20,000 blocks."
    : "This wiki is read-only on this address: start WikiShell with --edit to change it.";
  return (
    <span
      data-print="hide"
      title={why}
      tabIndex={0}
      // A phone shows no tooltip: a tap says it.
      onClick={() => toast(why)}
      aria-label={"Read only. " + why}
      className="bg-panel-2 text-muted rounded-md px-2 py-0.5 text-[12.5px] font-medium"
    >
      Read only
    </span>
  );
}

/** Under the title: when it last changed, and how connected it is. */
function Meta({ entry }: { entry: Entry }) {
  const out = linksOut(entry).length;
  const back = linkedFrom(entry).length;
  return (
    <div data-chrome="" className="text-faint mb-7 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
      {entry.updated && <span title={entry.updated}>Updated {age(entry.updated)}</span>}
      <span>{count(out, "link")} out</span>
      <span>{count(back, "backlink")}</span>
    </div>
  );
}

/**
 * The entries this one points at: body links that land on an entry in the
 * bundle, then frontmatter values that do, each target once, in the order they
 * appear. Both count, because both are edges — the graph draws them the same.
 */
function linksOut(entry: Entry): string[] {
  const out: string[] = [];
  const add = (to: string) => {
    if (to && to !== entry.path && !out.includes(to)) out.push(to);
  };
  for (const l of entry.links) if (l.exists && !l.outside && !l.asset) add(l.to);
  for (const r of entry.frontmatterRefs) add(r.to);
  return out;
}

/** The entries linking here, each once, in the order the server lists them. */
function linkedFrom(entry: Entry): Backlink[] {
  const seen = new Set<string>();
  return entry.backlinks.filter((b) => !seen.has(b.from) && seen.add(b.from));
}

/** A short rest before the folded properties open, so a pointer passing over
 *  them does not; gone almost the moment it leaves. */
const PROPERTIES_PEEK = { openAfter: 100, closeAfter: 30 };

/**
 * Frontmatter as a grid of properties rather than a raw YAML block. It is
 * metadata, and the raw form is only interesting when editing — which this is
 * not, yet.
 *
 * The grid folds to one line of what it says, the same way wherever an entry
 * is read: on the page and in every sheet, so the hand learns it once. Resting
 * on the line floats the grid, and a click keeps it open, remembered per bundle
 * as one choice for all of them, since how much metadata you want above what
 * you are reading is a habit. A view's own rows (a board's status and lane
 * controls) are in the grid like any other, and work while it floats.
 */
function Frontmatter({
  entry,
  destination,
  properties,
}: {
  entry: Entry;
  destination: (bundlePath: string) => string;
  properties: Property[];
}) {
  const { bundle } = useBundle();
  const [open, setOpen] = useBundleState(bundle.id, "reader:properties", false);
  // A folded property clicked: the grid opens with that value being edited.
  const [start, setStart] = useState<string | null>(null);
  // Folded, pointing at the summary shows the whole grid floating over the
  // text — a glance that moves nothing, since opening in the flow would push
  // the entry down under a pointer on its way to it. A click pins it in place.
  const glance = usePeek(PROPERTIES_PEEK);
  // title is already the heading; okf_version is the format's bookkeeping and
  // says nothing about the entry.
  const drawn = new Set(properties.map((p) => p.key));
  const fields = Object.entries(entry.frontmatter).filter(
    ([k]) => k !== "title" && k !== "okf_version" && !drawn.has(k),
  );
  if (fields.length === 0 && properties.length === 0 && !entry.editable) return null;

  // Values that name an entry, keyed the way they are written so a lookup
  // replaces any guessing about what looks like a path.
  const refs = new Map(entry.frontmatterRefs.map((r) => [r.key + "\u0000" + r.value, r]));

  const grid = (
    <dl
      id="entry-properties"
      className="grid grid-cols-[84px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 px-3 pb-3 text-[13px]"
    >
      {properties.map((p) => (
        <Fragment key={p.key}>
          <dt className="text-faint self-center truncate" title={p.key}>
            {p.key}
          </dt>
          <dd className="min-w-0">{p.node}</dd>
        </Fragment>
      ))}
      {fields.map(([key, value]) => {
        const list = Array.isArray(value);
        // A value naming an entry is a link to follow; it is changed with the
        // link picker, not by clicking it.
        const linked = values(value).some((v) => refs.has(key + "\u0000" + v));
        const shown = (
          <>
              {values(value).map((v, i) => {
                const ref = refs.get(key + "\u0000" + v);
                // Truncated with the whole value on hover, so nothing is lost,
                // only shortened; capped, so one long value does not eat the
                // line and push its siblings off it.
                if (ref) {
                  return (
                    <Link
                      key={i}
                      to={destination(ref.to)}
                      className="text-accent-ink max-w-[20rem] min-w-0 truncate underline decoration-1 underline-offset-2"
                      title={ref.value}
                    >
                      {ref.label}
                    </Link>
                  );
                }
                // Tags wear their colour, the same one everywhere
                // (backlog/8-design/003). Other lists are chips so their items
                // read as items. Values are never coloured by what they say.
                if (key === "tags" || list) {
                  return (
                    <span
                      key={i}
                      className="bg-elev text-muted inline-flex h-5.5 max-w-[20rem] min-w-0 items-center gap-1.5 rounded-md px-2 text-xs"
                      title={v}
                    >
                      {key === "tags" && (
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: tagColour(v, bundle.tags) }}
                          aria-hidden
                        />
                      )}
                      <span className="truncate">{v}</span>
                    </span>
                  );
                }
                return (
                  <span key={i} className="max-w-[20rem] min-w-0 truncate" title={v}>
                    {v}
                  </span>
                );
              })}
              {/* The key is there, so the grid says so, in the word the filter
                  uses for an empty value. */}
              {values(value).length === 0 && <span className="text-faint">(nothing)</span>}
          </>
        );
        return (
          <Fragment key={key}>
            {/* The key is faint and never coloured: accent means "this is
                interactive", and a key is not. */}
            <dt className="text-faint truncate" title={key}>
              {key}
            </dt>
            <dd className="group/field text-fg flex min-w-0 flex-wrap items-center gap-1.5">
              {linked ? (
                shown
              ) : (
                <FieldValue entry={entry} field={key} value={value} types={bundle.types} start={start === key}>
                  {shown}
                </FieldValue>
              )}
              <RemoveField entry={entry} field={key} value={value} />
            </dd>
          </Fragment>
        );
      })}
      <AddField entry={entry} types={bundle.types} />
    </dl>
  );
  // The view's own rows lead the line, as they lead the grid: a card's status
  // and lane are what you look for first. A key that says nothing is left off.
  const summary: [string, unknown][] = [
    ...properties.filter((p) => p.value !== "").map((p): [string, unknown] => [p.key, p.value]),
    ...fields.filter(([, value]) => values(value).length > 0),
  ];

  return (
    // The summary and its floating grid are one area, so moving from one to
    // the other keeps it open.
    <div {...glance.handlers} className="relative mb-8">
      <div className="bg-panel-2 rounded-xl">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="entry-properties"
          title={open ? "Hide the properties" : "Keep the properties open"}
          // Kept open, a click folds it and it stays folded under the pointer,
          // rather than floating back up where the grid just was.
          onClick={(e) => {
            if (!open) {
              setStart(entry.editable ? ((e.target as Element).closest("[data-field]")?.getAttribute("data-field") ?? null) : null);
              return setOpen(true);
            }
            setOpen(false);
            setStart(null);
            glance.dismiss();
          }}
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-[13px]"
        >
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            className={["text-faint shrink-0 transition-transform duration-150", open ? "rotate-90" : ""].join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          {open ? (
            <span className="text-faint">Properties</span>
          ) : (
            <Summary fields={summary} refs={refs} tags={bundle.tags} />
          )}
        </button>
        {open && grid}
      </div>
      {!open && glance.peeking && (
        // The gap above the float is padding, not margin: part of the area, so
        // a pointer on its way down from the line to the grid never leaves it.
        <div data-print="hide" className="absolute inset-x-0 top-full z-30 pt-1">
          <div className="bg-elev shadow-float animate-wv-in rounded-xl pt-3">{grid}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The properties folded to one line: each value as it would read aloud,
 * separated by dots — "todo · high · ● feature ● ui · 2 blockers". Keys are
 * left out, because on one line the values are what you scan for; the open
 * grid has the keys. Clipped at the edge rather than wrapped, so folded is
 * always one line.
 */
function Summary({
  fields,
  refs,
  tags,
}: {
  fields: [string, unknown][];
  refs: Map<string, Ref>;
  tags: string[];
}) {
  return (
    <span className="text-muted flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
      {fields.map(([key, value], i) => {
        const vs = values(value);
        const named = vs.map((v) => refs.get(key + "\u0000" + v)).filter((r): r is Ref => r !== undefined);
        return (
          <span key={key} data-field={key} className="flex shrink-0 items-center gap-1.5">
            {i > 0 && <span className="text-line-2" aria-hidden>·</span>}
            {key === "tags" ? (
              vs.map((t) => (
                <span key={t} className="flex shrink-0 items-center gap-1">
                  <span className="size-1.5 rounded-full" style={{ background: tagColour(t, tags) }} aria-hidden />
                  {t}
                </span>
              ))
            ) : named.length > 1 ? (
              // Several entries named by one key: how many, by the key's own
              // word, rather than a row of titles the line has no room for.
              <span className="shrink-0" title={named.map((r) => r.label).join(", ")}>
                {vs.length} {key}
              </span>
            ) : (
              <span className="shrink-0" title={key}>
                {named.length === 1 ? named[0]!.label : vs.join(", ")}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** A property row a caller draws itself: its key, and what goes beside it. */
export interface Property {
  key: string;
  node: ReactNode;
  /** What it says while the properties are folded: the view's value, which
   *  can be ahead of the file (a move not yet written) or not in it at all. */
  value: string;
}

/** A scalar and a list are the same thing here, one of them repeated — which is
 *  how the format treats a frontmatter reference too. A key written with
 *  nothing after it (YAML's null), an empty string and an empty list all say
 *  nothing, so they have no values, rather than the word "null". */
function values(value: unknown): string[] {
  const all = Array.isArray(value) ? value : [value];
  return all.filter((v) => v !== null && v !== undefined && v !== "").map(String);
}

/**
 * Under the body: what this entry links to, and what links to it, side by side.
 *
 * "Linked from" is what the engine calls backlinks (`wiki backlinks`); the
 * reference's words are used on screen because they say which way each column
 * points. Both columns are always drawn, and say "Nothing yet" when empty, so
 * the footer does not reflow from one entry to the next.
 */
function Connections({
  entry,
  destination,
}: {
  entry: Entry;
  destination: (bundlePath: string) => string;
}) {
  const out = linksOut(entry);
  const back = linkedFrom(entry);
  return (
    <section
      data-print="hide"
      className="border-line mt-12 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-5 border-t pt-6"
    >
      <div>
        <SectionLabel className="mb-2">Links to · {out.length}</SectionLabel>
        {out.length === 0 && <p className="text-faint text-[13px]">Nothing yet</p>}
        {out.map((to) => (
          <Connection key={to} to={destination(to)} path={to} />
        ))}
      </div>
      <div>
        <SectionLabel className="mb-2">Linked from · {back.length}</SectionLabel>
        {back.length === 0 && <p className="text-faint text-[13px]">Nothing yet</p>}
        {back.map((b) => (
          <Connection
            key={b.from}
            to={destination(b.from)}
            path={b.from}
            name={b.title}
            // Where in the source the link is, for the one reader who wants it.
            title={`${b.from}:${b.line}`}
          />
        ))}
      </div>
    </section>
  );
}

/** One row of the footer: the entry's group dot, what it is called, and its
 *  group — so a column of links says where each one goes before you follow it. */
function Connection({ to, path, name, title }: { to: string; path: string; name?: string; title?: string }) {
  const { bundle, tree } = useBundle();
  const groups = useMemo(() => groupsUnder(tree, "/"), [tree]);
  const group = groupOf(path, groups, "/");
  return (
    <Link
      to={to}
      title={title ?? path}
      className="hover:bg-fg/5 -mx-2.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2"
    >
      <span className="size-[7px] shrink-0 rounded-full" style={{ background: group?.colour ?? NEUTRAL }} aria-hidden />
      <span className="text-fg flex-1 truncate">{name || nameOf(tree, path, bundle.label) || path}</span>
      <span className="text-faint shrink-0 text-xs">{group?.label ?? bundle.label}</span>
    </Link>
  );
}

/** The article's normal width: `--column-width` in `index.css`. */
export const READING = 680;
/** Resting on the map opens it; it opens and closes quicker than the
 *  properties, being something you reach for rather than pass over. */
const MAP_PEEK = { openAfter: 120, closeAfter: 150 };

/**
 * The entry's sections as a heading map: a short line per heading in the
 * page's right margin, the one being read in the accent, the deeper ones
 * shorter. It takes the margin's width and nothing else, so it is there at
 * every width, on a wide page and a phone alike, with no column to make room
 * for.
 *
 * Resting on it floats the headings' titles beside the lines. The one under
 * the pointer is lit, in the list and on its line alike. A click on the lines
 * keeps it open, which is also how a touch screen opens it (a first tap opens
 * rather than jumps, since a line says nothing until its title is showing).
 * Choosing a heading keeps it open while the pointer stays. The links are plain `#id` anchors, the same as
 * the headings' own, so scrolling to one is the reader's hash handling and not
 * a second mechanism. Only with two headings or more: a map of one is a
 * heading.
 */
function HeadingMap({ sections }: { sections: Heading[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const peek = usePeek(MAP_PEEK);
  const open = pinned || peek.peeking;
  // Choosing a heading lets go of a click's hold, and the titles stay while
  // the pointer is on the map, ready for the next. Escape puts it away until
  // the pointer has left.
  const choose = () => setPinned(false);
  const dismiss = () => {
    setPinned(false);
    setHot(null);
    peek.dismiss();
  };

  // The section being read is the last one whose heading has scrolled past the
  // top of the view. Measured on scroll of the view area, which is what scrolls.
  useEffect(() => {
    const view = document.querySelector("main");
    if (!view) return;
    const onScroll = () => {
      const top = view.getBoundingClientRect().top + 80;
      let at: string | null = null;
      for (const h of sections) {
        const el = document.getElementById(h.id);
        if (el && el.getBoundingClientRect().top <= top) at = h.id;
      }
      setCurrent(at);
    };
    onScroll();
    view.addEventListener("scroll", onScroll, { passive: true });
    return () => view.removeEventListener("scroll", onScroll);
  }, [sections]);

  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned]);

  // Depth relative to the shallowest heading listed, so a page whose sections
  // are h2s draws them full length.
  const top = Math.min(...sections.map((h) => h.level));
  const depth = (h: Heading) => h.level - top;

  return (
    <nav
      ref={box}
      aria-label="On this page"
      data-print="hide"
      {...peek.handlers}
      onPointerLeave={() => {
        setHot(null);
        peek.handlers.onPointerLeave();
      }}
      className="fixed top-1/2 right-0.5 z-30 -translate-y-1/2 sm:right-2"
    >
      {/* The way in without a pointer: focusing it opens the list. */}
      <button type="button" className="sr-only" aria-expanded={open} onClick={() => (pinned ? dismiss() : setPinned(true))}>
        On this page
      </button>
      <div aria-hidden className="flex max-h-[60vh] flex-col items-end px-1.5 py-2">
        {sections.map((h) => (
          <a
            key={h.id}
            href={"#" + h.id}
            tabIndex={-1}
            onPointerEnter={() => setHot(h.id)}
            onClick={(e) => {
              if (open) return choose();
              e.preventDefault();
              setPinned(true);
            }}
            // Each line is a row a pointer can land on, and the rows give way
            // to one another on a page with more headings than the map has
            // height for.
            className="flex h-[9px] min-h-[3px] shrink items-center"
          >
            <span
              className={[
                "h-0.5 rounded-full transition-colors",
                ["w-2.5 sm:w-4", "w-2 sm:w-3", "w-1.5 sm:w-2"][Math.min(depth(h), 2)],
                hot === h.id ? "bg-fg" : current === h.id ? "bg-accent" : "bg-line-2",
              ].join(" ")}
            />
          </a>
        ))}
      </div>
      {open && <MapList sections={sections} current={current} hot={hot} onHot={setHot} depth={depth} onChoose={choose} onEscape={dismiss} />}
    </nav>
  );
}

/** The headings the map shows: h1 to h3 with an anchor, less the one that is
 *  the page's title. Memoized on the headings array, so the scroll listener
 *  is not re-bound on every render; the title comes from the same entry, so
 *  it cannot differ for the same array. */
const contentsOf = new WeakMap<Heading[], Heading[]>();
function contents(headings: Heading[], title?: string): Heading[] {
  let out = contentsOf.get(headings);
  if (!out) {
    out = headings.filter((h) => h.level <= 3 && h.id && h.id !== title);
    contentsOf.set(headings, out);
  }
  return out;
}

/** The map's titles, floating beside its lines. */
function MapList({
  sections,
  current,
  hot,
  onHot,
  depth,
  onChoose,
  onEscape,
}: {
  sections: Heading[];
  current: string | null;
  hot: string | null;
  onHot: (id: string) => void;
  depth: (h: Heading) => number;
  onChoose: () => void;
  onEscape: () => void;
}) {
  useEscape(onEscape);
  return (
    <div className="bg-elev shadow-float animate-wv-in absolute top-1/2 right-full max-h-[70vh] w-64 -translate-y-1/2 overflow-y-auto rounded-xl p-1.5">
      {sections.map((h) => (
        <a
          key={h.id}
          href={"#" + h.id}
          aria-current={current === h.id ? "location" : undefined}
          onPointerEnter={() => onHot(h.id)}
          onFocus={() => onHot(h.id)}
          onClick={onChoose}
          style={{ paddingLeft: 10 + depth(h) * 14 }}
          className={[
            "block truncate rounded-lg py-1.5 pr-2.5 text-[13px]",
            hot === h.id ? "bg-fg/5 text-fg" : current === h.id ? "text-accent-ink" : "text-muted",
          ].join(" ")}
        >
          {h.text}
        </a>
      ))}
    </div>
  );
}

/**
 * Whether a page offers its table as a file: a dataset with exactly one table,
 * as its blocks tell (a table's head block starts each table). A page too big
 * to be split into blocks comes without them; then the server decides.
 */
function downloadable(entry: Entry): boolean {
  if (entry.type !== "dataset") return false;
  if (!entry.blocks.length) return entry.body.trim() !== "";
  return entry.blocks.filter((b) => b.kind === "table-head").length === 1;
}

/**
 * Download a dataset's table, as CSV or JSON: the same bytes as
 * `wiki table --format csv|json`, for a spreadsheet or a script.
 *
 * Two words rather than two icons, since the choice is the format and an icon
 * can't say which. They sit in the toolbar's own style, after a download
 * glyph that labels the group. A button is busy until its file is handed
 * over, so a second click doesn't save twice, and it keeps focus meanwhile.
 */
function Download({ path }: { path: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"csv" | "json" | null>(null);
  // Read in the click itself: a second click can come before the re-render.
  const inFlight = useRef(new Set<string>());
  const save = async (format: "csv" | "json") => {
    if (inFlight.current.has(format)) return; // its file is on the way
    inFlight.current.add(format);
    setBusy(format);
    try {
      // What is typed and not saved yet goes first: the file is the page as
      // the user sees it.
      await settleSaves(path);
      const { blob, name } = await api.table(path, format);
      saveFile(blob, name);
    } catch (e) {
      // The server's reason, or, when it never answered, the app's words
      // rather than the browser's ("Failed to fetch").
      toast(`Can't download: ${e instanceof ApiError ? e.message : "WikiShell didn't answer."}`, "danger");
    } finally {
      inFlight.current.delete(format);
      setBusy(null);
    }
  };
  return (
    <div role="group" aria-label="Download this dataset" className="text-muted flex items-center">
      {/* The group's label, not a button: set off from the buttons before it,
          and against "CSV". */}
      <span aria-hidden className="bg-line mr-1.5 h-4 w-px" />
      <Glyph size={16}>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </Glyph>
      {(["csv", "json"] as const).map((format) => (
        <button
          key={format}
          type="button"
          aria-label={`Download ${format.toUpperCase()}`}
          title={`Download ${format.toUpperCase()}`}
          onClick={() => void save(format)}
          // aria-disabled, not disabled: a disabled button would drop a
          // keyboard user's focus to the page while the file downloads.
          aria-disabled={busy === format}
          aria-busy={busy === format}
          className="hover:bg-fg/5 hover:text-fg h-8 rounded-lg px-2 font-mono text-xs font-medium aria-disabled:opacity-40"
        >
          {format.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/**
 * Print this entry.
 *
 * `window.print()` and nothing else. The browser already turns a page into a
 * PDF, and everyone already knows ⌘P; this only says so on screen for the people
 * who do not.
 */
function Print() {
  return (
    <IconButton label="Print this entry" size="sm" data-print="hide" onClick={() => window.print()}>
      <Glyph size={16}>
        <path d="M6 9V3h12v6" />
        <rect x="6" y="14" width="12" height="7" rx="1" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      </Glyph>
    </IconButton>
  );
}

/**
 * Save this entry to read later.
 *
 * Here, on the entry, because this is the moment the thought happens: you are
 * reading something that matters and cannot read it now. It rides along into the
 * card sheet for free, since a card is this view inside a dialog.
 *
 * The bookmark filled when it is saved, hollow when it is not: the same glyph the
 * rail and the tree use, in the two states there are.
 */
function QueueButton({ queued, onQueue }: { queued: boolean; onQueue: () => void }) {
  return (
    <IconButton
      label={queued ? "Remove from read later" : "Save to read later"}
      size="sm"
      data-print="hide"
      onClick={onQueue}
      aria-pressed={queued}
      active={queued}
    >
      <Glyph size={16}>
        <path
          d="M18.5 21l-6.5-4-6.5 4V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2z"
          fill={queued ? "currentColor" : "none"}
        />
      </Glyph>
    </IconButton>
  );
}
