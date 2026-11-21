import { useEffect, useState } from "react";
import type { Op } from "@/api";

/** The editor's chunk: loaded once, after a page has rendered and the browser
 *  is idle (editor-adr.md, "Prefetch"). */
type EditorModule = typeof import("@/edit/Editor");

let loaded: EditorModule | null = null;
let loading: Promise<EditorModule> | null = null;
/** True once the chunk failed to load: the reader stays, and says so once. */
let failed = false;

/** At most this long after a render before the chunk is asked for, idle or not. */
const IDLE_MS = 2000;

/**
 * Whether pages load the editor at all. Always, but in the app's own tests,
 * which drive the reader and turn it off (`test-setup.ts`), as the stream's
 * clocks are shortened there.
 */
export const editorPrefetch = { enabled: true };

/**
 * The editor's module once it is here, or null meanwhile. Asked for only when
 * `wanted` (an editable page): a read-only address never loads it. `onFail`
 * hears when it can't be loaded, once per tab.
 */
export function useEditorModule(wanted: boolean, onFail: () => void): EditorModule | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (!wanted || loaded || failed || !editorPrefetch.enabled) return;
    let gone = false;
    const start = () => {
      loading ??= import("@/edit/Editor");
      loading.then(
        (m) => {
          loaded = m;
          if (!gone) setModule(m);
        },
        () => {
          if (failed) return;
          failed = true;
          if (!gone) onFail();
        },
      );
    };
    const idle = window.requestIdleCallback?.(start, { timeout: IDLE_MS });
    const timer = idle === undefined ? setTimeout(start, 0) : undefined;
    return () => {
      gone = true;
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [wanted, onFail]);
  return wanted && editorPrefetch.enabled ? module : null;
}

/** What the save status shows (the editor's autosave, `edit/save.ts`). */
export type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; since: number }
  | { kind: "saved"; at: number }
  | { kind: "failed"; reason: string }
  /** Places held for the user to choose: what to check, said by kind
   *  ("1 paragraph to check", "3 changes to check"). */
  | { kind: "conflicts"; label: string; rewritten: boolean }
  | { kind: "gone" };

/** A page's kept copy: operations whose save never landed, and their base. */
export interface Kept {
  /** The bundle it was typed in (its id from /api/bundle). */
  bundle: string;
  /** The editor that kept it: each keeps its own, so a later one (after a
   *  reload) never writes over an earlier one's (Revy, msg-700). */
  session: string;
  /** Its number among the copies its editor kept: a save drops only older ones. */
  seq: number;
  base: string;
  baseBlocks: string[];
  ops: Op[];
  at: number;
}

/**
 * Where a kept copy is, in this tab. By bundle as well as path: a tab's
 * storage is per address, and another bundle served later on the same port
 * must never be offered this one's text (Audy's L-1). And by editor session.
 */
export const keptKey = (bundle: string, path: string, session: string) =>
  `wikishell:unsaved:${bundle}:${path}:${session}`;

/** Every copy kept for a page of this bundle, oldest first. */
export function keptAll(bundle: string, path: string): Kept[] {
  const out: Kept[] = [];
  try {
    const prefix = `wikishell:unsaved:${bundle}:${path}:`;
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const kept = JSON.parse(sessionStorage.getItem(key)!) as Kept;
      kept.ops = written(kept.ops);
      // Nothing left to write (only empty blocks): nothing to offer.
      if (kept.bundle === bundle && kept.ops.length) out.push(kept);
    }
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Operations as the server takes them: an insert with no text is an empty
 * block, which is no content, and a replace by nothing is a delete. Copies
 * kept before empty blocks were left out of saves hold such operations, and
 * putting them back as they were was refused again.
 */
export function written(ops: Op[]): Op[] {
  return ops.flatMap((o): Op[] => {
    const empty = "text" in o && !o.blocks && blankText(o.text ?? "");
    if (o.op === "insert" && empty) return [];
    if (o.op === "replace" && empty) return [{ op: "delete", at: o.at, hash: o.hash }];
    return [o];
  });
}

/** Text with nothing in it: spaces, or an item's marker, checkbox and a
 *  `<br />` alone (an empty to-do, as the app wrote one before). */
const blankText = (text: string) =>
  text.replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\])?/, "").replace(/<br\s*\/?>/gi, "").trim() === "";

/** One editor's kept copy of a page, if it has one. */
export function keptFor(bundle: string, path: string, session: string): Kept | null {
  return keptAll(bundle, path).find((k) => k.session === session) ?? null;
}

export function putKept(kept: Kept, path: string) {
  try {
    sessionStorage.setItem(keptKey(kept.bundle, path, kept.session), JSON.stringify(kept));
  } catch {
    // A full or refused storage: the editor still holds the text.
  }
}

export function dropKept(bundle: string, path: string, session: string) {
  try {
    sessionStorage.removeItem(keptKey(bundle, path, session));
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
}

/**
 * Input that came before the editor held the page (editor-adr.md, "A click or
 * a key before the mount"): where the reader was clicked, and the typing keys
 * after it, in order, for the editor to replay once it is in.
 */
export interface Early {
  point: { x: number; y: number } | null;
  keys: string[];
}

/** Whether a key types: a printable character, Enter or Backspace. */
export const typing = (e: KeyboardEvent) =>
  !e.metaKey && !e.ctrlKey && !e.altKey && (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace");

/** The editors' saves of each page on screen, for a reader of the file (a
 *  dataset's download) to wait for what is typed and not saved yet. */
const saving = new Map<string, () => Promise<void>>();

/** An editor's way to settle its saves, kept while it holds the page. */
export function registerSaves(path: string, settle: () => Promise<void>): () => void {
  saving.set(path, settle);
  return () => {
    if (saving.get(path) === settle) saving.delete(path);
  };
}

/** Waits for the saves of a page being edited, if one is. */
export async function settleSaves(path: string): Promise<void> {
  await saving.get(path)?.();
}

/** Waits for the saves of every page being edited, as a reload is about to. */
export async function settleAllSaves(): Promise<void> {
  await Promise.all([...saving.values()].map((settle) => settle().catch(() => {})));
}
