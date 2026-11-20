import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { api, ApiError, type TreeNode } from "@/api";
import { useBundle } from "@/bundle";
import { useNewEntry, type NewEntryAsk } from "@/create/newEntry";
import { Field, SettingsDialog } from "@/views/SettingsDialog";

/**
 * The New entry dialog (the design's "Create an entry"), drawn once by the
 * shell and opened by `newEntry()`. A title, where, and a type; the file it
 * will make shows as it's typed. The server drafts the file (editor ADR,
 * "Drafting a new entry"), so its name and header follow the wiki's own rules
 * and none are built here. Create posts the draft unchanged and opens it.
 */
export function NewEntryDialog() {
  const [ask, answer] = useNewEntry();
  // A fresh form for each ask.
  return ask ? <Form key={ask.in + ":" + (ask.title ?? "")} ask={ask} answer={answer} /> : null;
}

const input = "border-line-2 bg-panel-2 focus:border-accent h-9 rounded-[9px] border px-3 outline-none";

function Form({ ask, answer }: { ask: NewEntryAsk; answer: (made: { path: string; title: string } | null) => void }) {
  const { bundle, tree } = useBundle();
  const navigate = useNavigate();
  const places = useMemo(() => placesIn(tree, ask.in), [tree, ask.in]);
  const [title, setTitle] = useState(ask.title ?? "");
  const [where, setWhere] = useState(ask.in);
  const [type, setType] = useState(() => usualType(tree, ask.in, bundle.types));
  const draft = useDraft(where, type, title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The path was taken when Create asked for it (a 409 from Create itself).
  const [lost, setLost] = useState<{ error: string; taken: string } | null>(null);
  useEffect(() => setLost(null), [title, where, type]);
  const close = () => answer(null);
  // Why it can't be made, if it can't: the draft's refusal, or the write's.
  const refusal = lost ?? (draft.kind === "refused" ? draft : null);

  // Create drafts the fields as they are now and posts that draft: the one
  // shown may be a keystroke behind (Revy, Dessy). Enter waits, busy.
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    setLost(null);
    try {
      const made = await api.draftEntry(where, type, title);
      await api.createEntry(made.path, made.content);
      // The caller puts its link in place first, then the page opens with the
      // caret in its body.
      answer({ path: made.path, title: title.trim() });
      navigate("/wiki" + made.path, { state: { caret: true } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setLost({ error: e.message, taken: (e.body as { path: string }).path });
      else setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsDialog
      title="New entry"
      // The file it will make, as the server drafts it.
      path={draft.kind === "ok" ? draft.path : "\u00a0"}
      busy={busy || !title.trim() || lost !== null}
      busyLabel={busy ? "Creating…" : "Create"}
      error={error}
      onSubmit={create}
      onClose={close}
      action="Create"
      footnote=""
    >
      <Field label="Title">
        <input
          autoFocus
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={draft.kind === "refused" && draft.field === "title" ? true : undefined}
          className={input}
        />
      </Field>
      <Field label="Where">
        <select value={where} onChange={(e) => setWhere(e.target.value)} className={input}>
          {places.map(([path, label]) => (
            <option key={path} value={path}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Type">
        {bundle.types.length ? (
          <select value={type} onChange={(e) => setType(e.target.value)} className={input}>
            {bundle.types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-invalid={draft.kind === "refused" && draft.field === "type" ? true : undefined}
            className={input}
          />
        )}
      </Field>
      {refusal && (
        <p role="alert" className="text-danger text-[13px]">
          {refusal.error}{" "}
          {refusal.taken && (
            <button
              type="button"
              onClick={() => {
                answer(null);
                navigate("/wiki" + refusal.taken);
              }}
              className="text-accent-ink font-medium hover:underline"
            >
              Open it
            </button>
          )}
        </p>
      )}
    </SettingsDialog>
  );
}

type Draft =
  | { kind: "none" }
  | { kind: "ok"; path: string; content: string }
  | { kind: "refused"; error: string; field: "title" | "type" | "path"; taken?: string };

/** The server's draft for what's typed, read again 250 ms after a change. */
function useDraft(where: string, type: string, title: string): Draft {
  const [draft, setDraft] = useState<Draft>({ kind: "none" });
  useEffect(() => {
    if (!title.trim()) return setDraft({ kind: "none" });
    const ac = new AbortController();
    const t = setTimeout(() => {
      api
        .draftEntry(where, type, title, ac.signal)
        .then((d) => setDraft({ kind: "ok", ...d }))
        .catch((e) => {
          if (ac.signal.aborted) return;
          // A 409 always names the taken path (editor ADR amendment v3).
          const taken = e instanceof ApiError && e.status === 409 ? (e.body as { path: string }).path : undefined;
          setDraft({ kind: "refused", error: String(e.message ?? e), field: taken ? "path" : type.trim() ? "title" : "type", taken });
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [where, type, title]);
  return draft;
}

/**
 * Where an entry can go: every folder, and, when it was asked from inside an
 * entry, beside that entry as one of its parts.
 */
function placesIn(tree: TreeNode, asked: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: TreeNode) => {
    out.push([node.path || "/", node.path && node.path !== "/" ? node.path.slice(1) + "/" : "(top)"]);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  if (asked.endsWith(".md")) out.unshift([asked, `Inside ${asked.slice(1)}`]);
  else if (!out.some(([p]) => p === asked)) out.unshift([asked, asked.slice(1) + "/"]);
  return out;
}

/** The type most entries in that folder have, else the first declared. */
function usualType(tree: TreeNode, asked: string, types: readonly string[]): string {
  const folder = asked.endsWith(".md") ? asked.replace(/\.md$/, "") : asked;
  const node = find(tree, folder);
  const counts = new Map<string, number>();
  for (const e of node?.entries ?? []) if (e.type) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const usual = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return usual && (!types.length || types.includes(usual)) ? usual : (types[0] ?? usual ?? "note");
}

function find(node: TreeNode, path: string): TreeNode | null {
  if ((node.path || "/") === (path || "/")) return node;
  for (const child of node.children) {
    const hit = find(child, path);
    if (hit) return hit;
  }
  return null;
}
