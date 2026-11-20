import { useEffect, useRef, useState } from "react";
import { api, ApiError, type ChangedFile, type Entry } from "@/api";
import type { Shown } from "@/changes/data";
import { Discard } from "@/changes/Discard";
import { LineDiff } from "@/changes/LineDiff";
import { foldedAtFirst } from "@/changes/lines";
import { PageDiff } from "@/changes/PageDiff";
import { NARROW, useMedia } from "@/media";
import { Segmented } from "@/ui/Segmented";

/**
 * One changed file in the changes view: its header (sticky while its lines
 * scroll) and its diff, as shown at one version. A file that changed since
 * says "Changed again, just now" and redraws only on Show.
 */
export function FileBox({
  file,
  shown,
  editable,
  check,
  arrived = false,
  onShow,
  onDiscarded,
}: {
  file: ChangedFile;
  shown?: Shown;
  /** Whether discards are offered (not on a read-only address). */
  editable: boolean;
  /** The commit checkbox, on a narrow screen where there's no tree. */
  check?: React.ReactNode;
  /** It joined the list after the view opened, so it starts unticked. */
  arrived?: boolean;
  onShow: () => Promise<void>;
  /** After a discard: the list and this file's diff are read again. */
  onDiscarded: () => Promise<void>;
}) {
  const diff = shown && "version" in shown ? shown : undefined;
  const page = !!diff?.blocks;
  const [view, setView] = useState<"rendered" | "markdown">("rendered");
  const [folded, setFolded] = useState(() => foldedAtFirst(file.path, (file.added ?? 0) + (file.removed ?? 0)));
  const [refused, setRefused] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const entry = usePageEntry(file);
  const narrow = useMedia(NARROW);
  const again = diff !== undefined && diff.version !== file.version;
  const title = file.title || file.path.replace(/^\//, "");

  useEffect(() => {
    if (refused) showButton.current?.focus();
  }, [refused]);

  const show = async () => {
    setRefused(false);
    setProblem(null);
    await onShow();
  };
  const discard = async (hunk?: number) => {
    if (!diff) return;
    setProblem(null);
    try {
      await api.discard(file.path, diff.version, hunk);
      await onDiscarded();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setRefused(true);
      else setProblem(e instanceof Error ? e.message : String(e));
    }
  };
  const can = editable && diff !== undefined && !refused;
  const modeOnly = !!file.mode && diff !== undefined && diff.hunks.length === 0 && !diff.raw?.includes("\n@@");
  const notes = [file.mode && modeLine(file.mode), tickNote(file, arrived)].filter(Boolean);
  const actions = (
    <>
      {file.added !== undefined && (
        <span className="font-mono text-[11.5px]">
          <span className="text-ok">+{file.added}</span> <span className="text-danger">−{file.removed}</span>
        </span>
      )}
      {again && (
        <span className="text-warn flex items-center gap-1.5 text-[12px]">
          <span aria-hidden className="bg-warn size-1.5 rounded-full" />
          Changed again, just now
          <button type="button" onClick={show} className="text-accent-ink font-medium hover:underline">
            Show
          </button>
        </span>
      )}
      {page && (
        <Segmented
          label="Show as"
          options={[
            ["rendered", "Rendered"],
            ["markdown", "Markdown"],
          ]}
          value={view}
          onChange={setView}
        />
      )}
      {can && !modeOnly && (
        <Discard
          label="Discard changes"
          question={file.change === "new" ? "Are you sure?" : `Discard all changes to ${title}?`}
          onDiscard={() => discard()}
        />
      )}
    </>
  );

  return (
    <section
      id={boxId(file.path)}
      data-path={file.path}
      aria-label={title}
      // Focusable from script only: following a page's "Not committed" chip
      // lands here, for the keyboard and a screen reader.
      tabIndex={-1}
      className="border-line scroll-mt-2 shrink-0 overflow-clip rounded-[10px] border"
    >
      {/* On a phone the title and path take the first line whole, the path
          wrapping, and the actions go on a second. */}
      <header className="bg-panel border-line sticky top-0 z-10 flex flex-col gap-1.5 border-b px-3.5 py-2">
        <div className="flex items-start gap-2.5">
          {check && <span className="pt-0.5">{check}</span>}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={"font-medium " + (narrow ? "break-words" : "truncate")}>{title}</span>
            <span className={"text-faint font-mono text-[11.5px] " + (narrow ? "break-all" : "truncate")}>
              {file.from && `${file.from.slice(1)} → `}
              {/* A file with no title is named by its path already. */}
              {file.title ? `${file.path.slice(1)} · ${file.change}` : file.change}
            </span>
            {notes.map((n) => (
              <span key={n as string} className="text-faint text-[11.5px]">
                {n}
              </span>
            ))}
          </span>
          {!narrow && <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">{actions}</span>}
        </div>
        {narrow && <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">{actions}</div>}
      </header>

      {refused && (
        <p role="status" aria-live="polite" className="bg-warn/8 flex items-center gap-2 px-3.5 py-2 text-[13px]">
          <span aria-hidden className="bg-warn size-1.5 rounded-full" />
          This file changed after you read it. Nothing was discarded.
          <button ref={showButton} type="button" onClick={show} className="text-accent-ink font-medium hover:underline">
            Show
          </button>
        </p>
      )}
      {problem && (
        <p role="alert" className="text-danger px-3.5 py-2 text-[13px]">
          {problem}
        </p>
      )}

      {body()}
    </section>
  );

  function body() {
    const quiet = (text: string, title?: string) => (
      <p className="text-faint px-3.5 py-2.5 text-[13px]" title={title}>
        {text}
      </p>
    );
    if (file.kind === "dot")
      return quiet("Not shown or committed here: files whose name starts with a dot can hold secrets. Use git for this one.");
    if (file.size !== undefined) return quiet(`A large file (${megabytes(file.size)}): not shown here.`);
    if (shown === undefined) return quiet("Loading…");
    if (!diff)
      return (
        <p role="alert" className="text-danger px-3.5 py-2.5 text-[13px]">
          {(shown as { error: string }).error}{" "}
          <button type="button" onClick={show} className="text-accent-ink font-medium hover:underline">
            Try again
          </button>
        </p>
      );
    if (modeOnly) return quiet("Only the file's mode changed. Change it back with chmod.");
    if (file.kind === "binary" || diff.raw === undefined) return quiet("A binary file changed.");
    if (folded)
      return (
        <button type="button" onClick={() => setFolded(undefined)} className="text-faint hover:text-fg px-3.5 py-2.5 text-[13px]">
          {folded}
        </button>
      );
    if (diff.blocks && view === "rendered") {
      return entry ? (
        <PageDiff diff={{ ...diff, blocks: diff.blocks }} entry={entry} onDiscard={can ? discard : undefined} />
      ) : (
        quiet("Loading…")
      );
    }
    // A page's lines are for reading: it's discarded in Rendered, where a
    // hunk is what the user sees.
    return <LineDiff raw={diff.raw} hunks={diff.hunks} onDiscard={can && !page ? discard : undefined} />;
  }
}

/** The page's entry, for its links: read when it still exists; a deleted
 *  page's blocks resolve nothing, as a missing page's links don't. */
function usePageEntry(file: ChangedFile): Entry | null {
  const [entry, setEntry] = useState<Entry | null>(null);
  useEffect(() => {
    if (file.kind !== "page") return;
    const empty: Entry = {
      path: file.path,
      title: file.title ?? file.path,
      type: "",
      frontmatter: {},
      body: "",
      links: [],
      frontmatterRefs: [],
      backlinks: [],
      headings: [],
      checkboxes: [],
      version: "",
      blocks: [],
      editable: false,
    };
    if (file.change === "deleted") return setEntry(empty);
    const ac = new AbortController();
    api
      .entry(file.path, ac.signal)
      .then(setEntry)
      .catch(() => !ac.signal.aborted && setEntry(empty));
    return () => ac.abort();
  }, [file.path, file.kind, file.change, file.title]);
  return entry;
}

/** Why a file starts unticked, said under its name, or nothing. */
export function tickNote(file: ChangedFile, arrived: boolean): string {
  if (file.kind === "dot") return "";
  if (arrived) return "Arrived after you opened this: tick to include.";
  if (file.change === "new" && file.kind !== "page") return "New file, not a page: tick to include.";
  return "";
}

/** What a file's mode change says, in the tree row and the box header. */
export function modeLine(mode: NonNullable<ChangedFile["mode"]>): string {
  if (mode.to === "120000") return "Now a link";
  if (mode.from === "120000") return "No longer a link";
  if (!mode.from) return mode.to === "100755" ? "Executable" : "";
  if (mode.to === "100755") return "Now executable";
  if (mode.from === "100755") return "No longer executable";
  return "";
}

const megabytes = (n: number) => `${(n / (1 << 20)).toFixed(1)} MB`;

/** The box's element id, for the tree and the picker to scroll to. */
export const boxId = (path: string) => "change-" + path;
