import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Changes, type FileDiff } from "@/api";

/** A file's diff as shown, or why it couldn't be read. */
export type Shown = FileDiff | { error: string };

/**
 * The changes view's data: the list of changed files, and each file's diff at
 * the version it was shown (changes-view-adr.md, "The flow").
 *
 * The list follows the bundle: every version the event stream reports
 * refetches it, at most once every 500 ms. A diff is fetched when its file is
 * first listed, and then only when asked (`show`): a file that changes while
 * it is read doesn't jump, its list `version` simply moves past its diff's.
 */
export function useChanges(refresh: number) {
  const [list, setList] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, Shown>>({});

  const reload = useCallback(async () => {
    try {
      const next = await api.changes();
      setList(next);
      setError(null);
      // A file that left the list leaves its diff: back later, it's fetched anew.
      setDiffs((d) => {
        const keep = new Set(next.files.map((f) => f.path));
        return Object.fromEntries(Object.entries(d).filter(([p]) => keep.has(p)));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // At most one list fetch every 500 ms: a burst of an agent's writes is one.
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + 500 - Date.now());
    const t = setTimeout(() => {
      last.current = Date.now();
      void reload();
    }, wait);
    return () => clearTimeout(t);
  }, [refresh, reload]);

  const show = useCallback(async (path: string) => {
    try {
      const d = await api.change(path);
      setDiffs((m) => ({ ...m, [path]: d }));
    } catch (e) {
      // Gone from the list meanwhile: the next list drops it.
      if (e instanceof ApiError && e.status === 404) return;
      setDiffs((m) => ({ ...m, [path]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  }, []);

  // Each newly listed file's diff. A dot file's is never served.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const f of list?.files ?? []) {
      if (f.kind === "dot" || f.path in diffs || asked.current.has(f.path)) continue;
      asked.current.add(f.path);
      void show(f.path).finally(() => asked.current.delete(f.path));
    }
  }, [list, diffs, show]);

  return { list, error, diffs, reload, show };
}
