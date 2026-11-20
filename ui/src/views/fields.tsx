import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Entry } from "@/api";
import { Glyph } from "@/ui/IconButton";

/**
 * A page's fields, edited where they are shown (the design's §1, "Frontmatter
 * as fields"). A value is clicked, or reached with Tab, to edit it; Enter or
 * leaving saves it through `PUT /api/fields`, guarded by the value the input
 * opened with, and Escape puts it back. A refusal shows the server's reason
 * under the field, and the typed value stays to be fixed. A value changed
 * outside meanwhile is offered: keep mine, or use theirs.
 */

type Value = unknown;

/** How a value is edited, by what it is: a list one item a line, so an item
 *  may hold a comma; true or false a switch; a date a date input; `type` a
 *  select of wiki.toml's types when it declares some; else text. */
type Kind = "list" | "bool" | "date" | "type" | "text";

function kindOf(field: string, v: Value, types: readonly string[]): Kind {
  if (field === "type" && types.length) return "type";
  if (Array.isArray(v)) return "list";
  if (typeof v === "boolean" || v === "true" || v === "false") return "bool";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
  return "text";
}

/** The input's text for a value, and the value for an input's text. */
const toText = (v: Value) => (Array.isArray(v) ? v.join("\n") : v === null || v === undefined ? "" : String(v));
const fromText = (kind: Kind, text: string): Value =>
  kind === "list"
    ? text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : text;

const said = (v: Value) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "(nothing)" : String(v));
const same = (a: Value, b: Value) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * One write of a field, and what came of it: done, refused (the server's
 * reason), or met a change made outside (their value), offered as keep mine
 * or use theirs.
 */
function useWrite(entry: Entry, field: string) {
  const [problem, setProblem] = useState<string | null>(null);
  const [theirs, setTheirs] = useState<{ value: Value; retry: (old: Value) => Promise<boolean> } | null>(null);
  const write = async (set: Record<string, Value>, old: Value, unset: string[] = []): Promise<boolean> => {
    try {
      const done = await api.setFields(entry.path, set, { [field]: old }, unset);
      const conflict = done.conflicts.find((c) => c.key === field);
      if (conflict) {
        setTheirs({ value: conflict.theirs, retry: (o) => write(set, o, unset) });
        return false;
      }
      setProblem(null);
      setTheirs(null);
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
      return false;
    }
  };
  return { write, problem, theirs, clear: () => (setProblem(null), setTheirs(null)) };
}

/** What a write that met a change made outside offers. */
function Theirs({
  value,
  onKeep,
  onUse,
}: {
  value: Value;
  onKeep: () => void;
  onUse: () => void;
}) {
  return (
    <span role="alert" className="text-[12px]">
      Changed outside WikiShell to: <code className="font-mono">{said(value)}</code>{" "}
      <button type="button" className="text-accent-ink font-medium hover:underline" onClick={onKeep}>
        Keep mine
      </button>{" "}
      <button type="button" className="text-muted font-medium hover:underline" onClick={onUse}>
        Use theirs
      </button>
    </span>
  );
}

function Problem({ id, text }: { id?: string; text: string }) {
  return (
    <span id={id} role="alert" className="text-danger text-[12px]">
      {text}
    </span>
  );
}

/** One field's value: as drawn, or being edited. `start` opens it for editing. */
export function FieldValue({
  entry,
  field,
  value,
  types = [],
  start = false,
  children,
}: {
  entry: Entry;
  field: string;
  value: Value;
  /** wiki.toml's types, for `type`. */
  types?: readonly string[];
  start?: boolean;
  children: ReactNode;
}) {
  const kind = kindOf(field, value, types);
  const [editing, setEditing] = useState<string | null>(null);
  // The value the input opened with: the guard of its write, so a change made
  // outside while it was open is never overwritten unasked (Dessy, msg-745).
  const opened = useRef<Value>(value);
  const { write, problem, theirs, clear } = useWrite(entry, field);
  const reason = useId();
  const open = () => {
    opened.current = value;
    setEditing(toText(value));
  };
  useEffect(() => {
    if (start && entry.editable) open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  if (!entry.editable) return <>{children}</>;

  const save = async (text: string) => {
    const next = fromText(kind, text);
    if (same(next, opened.current)) {
      setEditing(null);
      clear();
      return;
    }
    if (await write({ [field]: next }, opened.current)) setEditing(null);
  };
  const conflict = theirs && (
    <Theirs
      value={theirs.value}
      onKeep={async () => {
        if (await theirs.retry(theirs.value)) setEditing(null);
      }}
      onUse={() => {
        clear();
        setEditing(null);
      }}
    />
  );

  if (kind === "bool") {
    const on = value === true || value === "true";
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          role="switch"
          aria-label={field}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? reason : undefined}
          checked={on}
          onChange={() => void write({ [field]: typeof value === "boolean" ? !on : String(!on) }, value)}
          className="accent-accent size-3.5"
        />
        {problem && <Problem id={reason} text={problem} />}
        {theirs && (
          <Theirs value={theirs.value} onKeep={() => void theirs.retry(theirs.value)} onUse={clear} />
        )}
      </span>
    );
  }

  if (editing === null) {
    return (
      <button type="button" onClick={open} aria-label={`Edit ${field}`} className="flex min-w-0 flex-wrap items-center gap-1.5 text-left">
        {children}
      </button>
    );
  }
  const common = {
    autoFocus: true,
    "aria-label": field,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": problem ? reason : undefined,
    className: "bg-panel border-line w-full rounded-md border px-2 py-0.5 text-[13px]",
  } as const;
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
      clear();
    }
  };
  return (
    <span className="flex min-w-0 flex-col gap-1">
      {kind === "type" ? (
        <select
          {...common}
          value={editing}
          onChange={(e) => {
            setEditing(e.target.value);
            void save(e.target.value);
          }}
          onKeyDown={keys}
        >
          {!types.includes(editing) && <option value={editing}>{editing || "(nothing)"}</option>}
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      ) : kind === "list" ? (
        // One item a line: an item may hold a comma.
        <textarea
          {...common}
          rows={Math.max(2, editing.split("\n").length)}
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            keys(e);
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(editing);
          }}
          onBlur={() => !theirs && void save(editing)}
        />
      ) : (
        <input
          {...common}
          type={kind === "date" ? "date" : "text"}
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            keys(e);
            if (e.key === "Enter") void save(editing);
          }}
          onBlur={() => !theirs && void save(editing)}
        />
      )}
      {kind === "list" && <span className="text-faint text-[11.5px]">One item a line; ⌘Enter or leaving saves.</span>}
      {problem && <Problem id={reason} text={problem} />}
      {conflict}
    </span>
  );
}

/** The ✕ that removes a field, shown on hover or focus of its row. */
export function RemoveField({ entry, field, value }: { entry: Entry; field: string; value: Value }) {
  const { write, problem, theirs, clear } = useWrite(entry, field);
  if (!entry.editable) return null;
  return (
    <>
      <button
        type="button"
        aria-label={`Remove ${field}`}
        title={`Remove ${field}`}
        onClick={() => void write({}, value, [field])}
        className="text-faint hover:text-danger ml-1 opacity-0 group-hover/field:opacity-100 focus:opacity-100"
      >
        <Glyph size={12}>
          <path d="M6 6l12 12M18 6L6 18" />
        </Glyph>
      </button>
      {problem && <Problem text={problem} />}
      {theirs && <Theirs value={theirs.value} onKeep={() => void theirs.retry(theirs.value)} onUse={clear} />}
    </>
  );
}

/** "+ Add a property": a name, then its value. */
export function AddField({ entry, types = [] }: { entry: Entry; types?: readonly string[] }) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (!entry.editable) return null;
  if (!adding) {
    return (
      <button type="button" onClick={() => setAdding(true)} className="text-faint hover:text-fg col-span-2 text-left text-[12.5px]">
        + Add a property
      </button>
    );
  }
  const add = async () => {
    const k = key.trim();
    if (!k) return;
    try {
      const done = await api.setFields(entry.path, { [k]: value }, { [k]: null });
      // A key that is there already isn't replaced: said, and the value kept.
      if (done.conflicts.some((c) => c.key === k)) {
        setProblem(`${k} already exists`);
        return;
      }
      setAdding(false);
      setKey("");
      setValue("");
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    }
  };
  return (
    <span className="col-span-2 flex flex-wrap items-center gap-2">
      <input
        autoFocus
        aria-label="Property name"
        placeholder="name"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className="bg-panel border-line w-28 rounded-md border px-2 py-0.5 text-[13px]"
      />
      {key.trim() === "type" && types.length ? (
        <select
          aria-label="Property value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="bg-panel border-line min-w-0 flex-1 rounded-md border px-2 py-0.5 text-[13px]"
        >
          <option value="">(choose)</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label="Property value"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
            if (e.key === "Escape") setAdding(false);
          }}
          className="bg-panel border-line min-w-0 flex-1 rounded-md border px-2 py-0.5 text-[13px]"
        />
      )}
      <button type="button" onClick={() => void add()} className="text-accent-ink text-[12.5px] font-medium hover:underline">
        Add
      </button>
      {problem && <span role="alert" className="text-danger w-full text-[12px]">{problem}</span>}
    </span>
  );
}
