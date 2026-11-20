import { useSyncExternalStore } from "react";

/** What a new entry dialog was asked to start with. */
export interface NewEntryAsk {
  /** The folder it starts in, or an entry whose parts it goes beside. */
  in: string;
  title?: string;
}

/** The entry made: its path and title. */
export interface Made {
  path: string;
  title: string;
}

type Request = NewEntryAsk & { done: (made: Made | null) => void };

let open: Request | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/**
 * Opens the New entry dialog (the design's "Create an entry"), from anywhere:
 * the tree, the palette, the editor's menus and link card, which draw in
 * React roots of their own. It resolves with the entry made, or null when the
 * dialog was closed without one. A second ask replaces the first.
 */
export function newEntry(ask: NewEntryAsk): Promise<Made | null> {
  open?.done(null);
  return new Promise((done) => {
    open = { ...ask, done };
    changed();
  });
}

/** The open ask, for the one dialog the shell draws, and how to answer it. */
export function useNewEntry(): [Request | null, (made: Made | null) => void] {
  const ask = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => open,
  );
  const answer = (made: Made | null) => {
    const was = open;
    open = null;
    changed();
    was?.done(made);
  };
  return [ask, answer];
}

/** The folder a path is in: `/spec/a.md` is in `/spec`, `/a.md` in `/`. */
export const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** A title read from a file name: `/spec/settlement-rules.md` is
 *  "Settlement rules". New entry starts from it for a link to a missing page,
 *  so the default makes the very file the link names. */
export function titleOf(path: string): string {
  const words = (path.split("/").pop() ?? "").replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
