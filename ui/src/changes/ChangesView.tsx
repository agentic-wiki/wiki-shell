import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { api, ApiError, type ChangedFile, type Committed } from "@/api";
import { useBundle } from "@/bundle";
import { useChanges } from "@/changes/data";
import { boxId, FileBox, modeLine, tickNote } from "@/changes/FileBox";
import { fileTree, treeOrder, type TreeNode } from "@/changes/lines";
import { proposeMessage } from "@/changes/message";
import { count } from "@/count";
import { NARROW, useMedia } from "@/media";
import { useGit } from "@/shell/GitActions";
import { Glyph } from "@/ui/IconButton";
import { State, StateIcon, stateButton } from "@/ui/State";
import { useToast } from "@/ui/Toast";
import { Loading } from "@/views/Loading";
import { ReadOnly } from "@/views/EntryView";

/**
 * Every uncommitted change in the wiki, from WikiShell, an agent or any other
 * tool, to read and then commit or discard: the one place WikiShell commits
 * (design-changes-view.md, changes-view-adr.md). A commit takes each ticked
 * file at the version it was shown, so nothing unseen is committed.
 */
export function ChangesView({ refresh }: { refresh: number }) {
  const { list, error, diffs, reload, show } = useChanges(refresh);
  const { bundle } = useBundle();
  const narrow = useMedia(NARROW);
  const wide = useMedia("(min-width: 900px)");
  const files = useMemo(() => treeOrder(list?.files ?? []), [list]);
  const [ticks, setTicks] = useState<Map<string, boolean>>(new Map());
  // The files listed when the view opened: one that joins later starts
  // unticked, so a Commit never takes a file the user hasn't seen arrive.
  const [opened, setOpened] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (list && !opened) setOpened(new Set(list.files.map((f) => f.path)));
  }, [list, opened]);
  const arrived = (f: ChangedFile) => opened !== null && !opened.has(f.path);
  const ticked = (f: ChangedFile) => f.kind !== "dot" && (ticks.get(f.path) ?? (startsTicked(f) && !arrived(f)));
  const tick = (path: string, on: boolean) => setTicks((m) => new Map(m).set(path, on));
  const reading = useReading(files);
  useScrollToHash(list !== null);

  if (error && !list)
    return (
      <State
        icon={StateIcon.offline}
        tone="danger"
        title="Can't read git"
        detail={error}
        action={
          <button type="button" onClick={() => void reload()} className={stateButton}>
            Try again
          </button>
        }
      />
    );
  if (!list) return <Loading />;
  if (!list.repo)
    return (
      <State
        icon={StateIcon.file}
        title="This wiki is not in git"
        detail="Edits are saved to the files, but there is nothing to review or commit."
      />
    );
  if (files.length === 0)
    return (
      <State
        icon={StateIcon.file}
        title="No changes"
        detail="Edits you make in WikiShell, or an agent makes in this folder, show up here before they are committed."
      />
    );

  const editable = bundle.editable;
  const checkbox = (f: ChangedFile) =>
    f.kind === "dot" ? (
      <span title="Not shown or committed here" className="text-faint grid size-3.5 place-items-center">
        <Glyph size={14}>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </Glyph>
      </span>
    ) : (
      <input
        type="checkbox"
        checked={ticked(f)}
        onChange={(e) => tick(f.path, e.target.checked)}
        aria-label={rowLabel(f, arrived(f))}
        className="accent-accent size-3.5 shrink-0"
      />
    );

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex grow gap-5 px-4 pt-6 md:px-8">
        {wide && (
          <nav aria-label="Changed files" className="sticky top-6 max-h-[calc(100vh-180px)] w-64 shrink-0 self-start overflow-y-auto">
            <ul role="tree" aria-label="Changed files" className="text-[13px]">
              <Tree nodes={fileTree(files)} reading={reading} check={editable ? checkbox : undefined} arrived={arrived} />
            </ul>
          </nav>
        )}
        <div className="flex min-w-0 grow flex-col gap-4 pb-6">
          <h1 className="text-fg text-[24px] font-bold tracking-[-0.02em]">Changes</h1>
          {narrow && <Picker files={files} />}
          {list.outside > 0 && (
            <p className="text-warn bg-warn/8 border-warn/25 rounded-lg border px-2.5 py-2 text-xs">
              {count(list.outside, "staged file")} elsewhere in this repository {list.outside === 1 ? "is" : "are"} outside the
              wiki, and won't be committed here. Handle {list.outside === 1 ? "it" : "them"} in a terminal.
            </p>
          )}
          {files.map((f) => (
            <FileBox
              key={f.path}
              file={f}
              shown={diffs[f.path]}
              editable={editable}
              check={editable && !wide ? checkbox(f) : undefined}
              arrived={editable && arrived(f)}
              onShow={() => show(f.path)}
              onDiscarded={async () => {
                await reload();
                await show(f.path);
              }}
            />
          ))}
          {!editable && (
            <p className="text-faint flex items-center gap-2 text-[13px]">
              <ReadOnly /> WikiShell was started without --edit on this address.
            </p>
          )}
        </div>
      </div>
      {editable && (
        <CommitBar
          files={files}
          ticked={files.filter(ticked)}
          versionOf={(f) => {
            const d = diffs[f.path];
            return d && "version" in d ? d.version : f.version;
          }}
          onCommitted={reload}
        />
      )}
    </div>
  );
}

/** Pages and anything modified, deleted or renamed start ticked; a new file
 *  that isn't a page doesn't, so one Commit never publishes whatever was
 *  dropped into the folder. */
const startsTicked = (f: ChangedFile) => !(f.change === "new" && f.kind !== "page");

/** What a screen reader hears for a file's row. */
function rowLabel(f: ChangedFile, arrived: boolean): string {
  const parts = [f.path.slice(1), f.change];
  if (f.kind === "dot") parts.push("not shown or committed here");
  else if (arrived) parts.push("arrived after you opened this");
  else if (!startsTicked(f)) parts.push("new file, not a page");
  if (f.mode) parts.push(modeLine(f.mode).toLowerCase());
  return parts.filter(Boolean).join(", ");
}

const MARK: Record<ChangedFile["change"], [string, string] | null> = {
  new: ["new", "text-ok"],
  deleted: ["deleted", "text-danger"],
  renamed: ["renamed", "text-faint"],
  modified: null,
};

/** The changed files as a folder tree; a click scrolls to the file's box. */
function Tree({
  nodes,
  reading,
  check,
  arrived,
}: {
  nodes: TreeNode<ChangedFile>[];
  reading?: string;
  check?: (f: ChangedFile) => ReactNode;
  arrived: (f: ChangedFile) => boolean;
}) {
  return nodes.map((n) => {
    if (n.kind === "folder")
      return (
        <li key={n.path + "/"} role="treeitem" aria-expanded aria-label={n.name}>
          <span className="text-faint block truncate px-2 py-1 font-mono text-[12px]">{n.name}/</span>
          <ul role="group" className="pl-3">
            <Tree nodes={n.children} reading={reading} check={check} arrived={arrived} />
          </ul>
        </li>
      );
    const f = n.item;
    const mark = MARK[f.change];
    return (
      <li
        key={f.path}
        role="treeitem"
        aria-selected={f.path === reading}
        aria-label={rowLabel(f, arrived(f))}
        className={["flex items-start gap-2 rounded-md px-2 py-1", f.path === reading ? "bg-fg/6" : "hover:bg-fg/4"].join(" ")}
      >
        {check && <span className="pt-0.5">{check(f)}</span>}
        <button
          type="button"
          onClick={() => document.getElementById(boxId(f.path))?.scrollIntoView({ block: "start" })}
          className="flex min-w-0 flex-1 flex-col text-left"
          title={f.from ? `${f.from} → ${f.path}` : f.path}
        >
          <span className="flex items-baseline gap-1.5">
            <span className="truncate">{n.name}</span>
            {mark && <span className={"text-[11px] " + mark[1]}>{mark[0]}</span>}
          </span>
          {check && tickNote(f, arrived(f)) && <span className="text-faint text-[11.5px]">{tickNote(f, arrived(f))}</span>}
          {f.mode && <span className="text-faint text-[11.5px]">{modeLine(f.mode)}</span>}
        </button>
      </li>
    );
  });
}

/** On a narrow screen, where there is no tree: a select that scrolls to a file. */
function Picker({ files }: { files: ChangedFile[] }) {
  return (
    <select
      aria-label="Go to a file"
      defaultValue=""
      onChange={(e) => document.getElementById(boxId(e.target.value))?.scrollIntoView({ block: "start" })}
      className="bg-panel border-line rounded-md border px-2 py-1.5 text-[13px]"
    >
      <option value="" disabled>
        {count(files.length, "changed file")}
      </option>
      {files.map((f, i) => (
        <option key={f.path} value={f.path}>
          {i + 1} of {files.length} · {f.title || f.path.slice(1)}
        </option>
      ))}
    </select>
  );
}

/** Once the files are drawn, scrolls to the one the address names
 *  (`/changes#/notes/a.md`, from a page's "Not committed" chip). */
function useScrollToHash(ready: boolean) {
  const { hash } = useLocation();
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || !hash) return;
    done.current = true;
    document.getElementById(boxId(decodeURIComponent(hash.slice(1))))?.scrollIntoView({ block: "start" });
  }, [ready, hash]);
}

/** The path of the file being read: the first box whose body is on screen. */
function useReading(files: ChangedFile[]): string | undefined {
  const [reading, setReading] = useState<string>();
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set((e.target as HTMLElement).dataset.path!, e.isIntersecting);
      setReading(files.find((f) => seen.get(f.path))?.path);
    });
    for (const f of files) {
      const el = document.getElementById(boxId(f.path));
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [files]);
  return reading;
}

/** Files a commit refused because they changed after they were shown. */
function refusedLine(refused: Committed["refused"]): string {
  if (refused.length === 0) return "";
  if (refused.length === 1) return `${refused[0]!.path.slice(1)} changed after you read it. Check it, then commit again.`;
  return `${count(refused.length, "file")} changed after you read them. Check them, then commit again.`;
}

/**
 * The sticky commit bar: the message (proposed from what is ticked until it's
 * edited), "N of M files", and Commit (pushing is the git popover's). A
 * commit refused by a hook, or failing, shows git's words above it until the
 * next Commit.
 */
function CommitBar({
  files,
  ticked,
  versionOf,
  onCommitted,
}: {
  files: ChangedFile[];
  ticked: ChangedFile[];
  versionOf: (f: ChangedFile) => string;
  onCommitted: () => Promise<void>;
}) {
  const [, setStatus] = useGit();
  const toast = useToast();
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ title: string; output: string } | null>(null);
  const message = typed ?? proposeMessage(ticked.map((f) => ({ path: f.path.slice(1) })));
  const committable = files.filter((f) => f.kind !== "dot").length;
  const dots = files.length - committable;

  const commit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const done: Committed = await api.commit(
        message,
        ticked.map((f) => ({ path: f.path, version: versionOf(f) })),
      );
      setStatus(done.status);
      const n = count(done.committed.length, "file");
      // One toast says it all: a new one would replace the last.
      const said = [done.commit && `Committed ${n}.`, refusedLine(done.refused)].filter(Boolean);
      toast(said.join(" "), done.refused.length ? "danger" : "ok");
      if (done.commit) setTyped(null);
      await onCommitted();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const hook = /^the (pre-commit|commit-msg) hook refused the commit: ([\s\S]*)$/.exec(text);
      setFailure(
        hook
          ? { title: `The commit was refused by the repository's ${hook[1]} hook.`, output: hook[2]! }
          : { title: "The commit failed:", output: text },
      );
      // "Nothing to commit" still says which files were refused.
      const refused = e instanceof ApiError ? (e.body as Partial<Committed> | undefined)?.refused : undefined;
      if (refused?.length) toast(refusedLine(refused), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-bg border-line sticky bottom-0 z-20 border-t px-4 py-3 md:px-8">
      {failure && (
        <div role="status" aria-live="polite" className="mb-2.5">
          <p className="flex items-center gap-2 text-[13px]">
            <span aria-hidden className="bg-danger size-1.5 rounded-full" />
            {failure.title}
          </p>
          <pre className="bg-panel-2 mt-1.5 max-h-40 overflow-auto rounded-md p-2 font-mono text-[12px] whitespace-pre-wrap select-text">
            {failure.output}
          </pre>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={message}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Commit message"
          className="border-line-2 bg-panel-2 focus:border-accent h-9 min-w-0 flex-1 basis-60 rounded-[9px] border px-3 outline-none"
        />
        <span className="text-faint flex flex-col text-xs">
          {ticked.length} of {count(committable, "file")}
          {dots > 0 && <span>{count(dots, "dot file")} {dots === 1 ? "is" : "are"} left for git.</span>}
        </span>
        <button
          type="button"
          disabled={busy || ticked.length === 0 || !message.trim()}
          onClick={commit}
          className="bg-accent text-on-accent h-9 rounded-[9px] px-4 font-semibold hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Committing…" : "Commit"}
        </button>
      </div>
    </div>
  );
}
