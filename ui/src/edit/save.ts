import type { Node } from "@milkdown/prose/model";
import { ApiError, type Block, type Conflict, type Entry, type Op, type Saved } from "@/api";
import { applied, lineup, rebase, type Loaded } from "@/edit/blocks";
import type { Engine } from "@/edit/engine";
import { dropKept, keptFor, putKept, written, type SaveState } from "@/editing";

/**
 * Autosave for one page (editor-adr.md, "Autosave"; the design's §2): 800 ms
 * after the last change, at most every 3 s while typing goes on, and at once
 * when the page is left. One save in flight. A save that fails is retried, and
 * its operations are kept in the tab (sessionStorage) until one lands, so a
 * reload loses nothing.
 */


/** The page version the editor's operations are made against. */
export interface Base {
  version: string;
  blocks: Block[];
}


export interface SaverDeps {
  /** The bundle's id: kept text belongs to one bundle (Audy's L-1). */
  bundle: string;
  path: string;
  /** The first block the editor holds (1 with the title hoisted). */
  from: number;
  engine: Engine;
  base: Base;
  loaded: Loaded;
  /** The editor's document now. */
  doc: () => Node;
  api: {
    saveBlocks: (path: string, base: string, baseBlocks: string[], ops: Op[], keepalive?: boolean) => Promise<Saved>;
    entry: (path: string) => Promise<Entry>;
  };
  onState: (state: SaveState) => void;
  /** Told the conflicts a save came back with (the inline panels, §3). */
  onConflicts?: (conflicts: Conflict[], rewritten: boolean) => void;
  clock?: Clock;
}

export interface Clock {
  now: () => number;
  /** Runs fn after ms; returns how to cancel it. */
  after: (ms: number, fn: () => void) => () => void;
}

const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

const QUIET_MS = 800;
const MAX_MS = 3000;
/** Retries after a failure: then every 30 s. */
const RETRY_MS = [2000, 5000, 15000, 30000];
/** The server's limits on one save. */
const MAX_OPS = 1000;
const MAX_BODY = 2 * 1024 * 1024;
/** The largest body a browser sends with keepalive. */
const KEEPALIVE_MAX = 64 * 1024;


export class Saver {
  private base: Base;
  private loaded: Loaded;
  /** What the disk holds of this document, as far as the editor knows: the
   *  document last saved with no conflict, or last taken in. What sync
   *  compares against, so edits already merged on disk aren't news (Archy,
   *  msg-702). */
  private synced: Node;
  private clock: Clock;
  private cancel: (() => void) | null = null;
  private pendingSince: number | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  /** The last kept record's number: a save drops only records made before it
   *  started, which it carries. */
  private seq = 0;
  /** This editor's own: what it keeps never replaces another's. */
  private session = crypto.randomUUID();

  constructor(private deps: SaverDeps) {
    this.base = deps.base;
    this.loaded = deps.loaded;
    this.synced = deps.loaded.doc;
    this.clock = deps.clock ?? realClock;
  }

  /** The document changed: save soon. */
  changed() {
    const now = this.clock.now();
    this.pendingSince ??= now;
    this.failures = 0;
    this.cancel?.();
    const wait = Math.max(0, Math.min(QUIET_MS, MAX_MS - (now - this.pendingSince)));
    this.cancel = this.clock.after(wait, () => void this.flush());
  }

  /** Whether some change isn't saved yet. */
  get pending(): boolean {
    return this.pendingSince !== null || this.inFlight !== null;
  }

  /** Saves now. With `leaving`, the request outlives the page, and what it
   *  can't carry is kept in the tab. */
  flush(leaving = false): Promise<void> {
    this.cancel?.();
    this.cancel = null;
    if (this.inFlight) {
      this.again = true;
      // The save after this one can't be sent once the page is gone.
      if (leaving) this.keep(this.ops());
      return this.inFlight;
    }
    const ops = this.ops();
    this.pendingSince = null;
    if (ops.length === 0) return Promise.resolve();
    const bytes = new TextEncoder().encode(JSON.stringify({ base: this.base.version, baseBlocks: this.hashes(), ops })).length;
    // The server's limits (editor-adr.md, "Saving"): said, rather than refused.
    if (ops.length > MAX_OPS || bytes > MAX_BODY) {
      this.keep(ops);
      this.deps.onState({
        kind: "failed",
        reason: "Not saved: this change is too big to save at once (over 1,000 blocks or 2 MB). Undo part of it, or make it in steps.",
      });
      return Promise.resolve();
    }
    const keepalive = leaving && bytes <= KEEPALIVE_MAX;
    // Leaving, the text is kept before it goes: the page may be gone before
    // the answer comes, and with it the chance to keep it on a failure. A
    // successful save drops it again, if nothing newer was kept meanwhile.
    if (leaving) this.keep(ops);
    this.inFlight = this.send(ops, this.deps.doc(), keepalive, this.seq).finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        this.changed();
      }
    });
    return this.inFlight;
  }

  /** Saves what is pending and waits for every save to land. */
  async settle(): Promise<void> {
    while (this.pending) await this.flush();
  }

  /** The version and mapping the document is now against: the page as it is
   *  on disk, after its outside changes were taken in. */
  resync(base: Base, loaded: Loaded) {
    this.base = base;
    this.loaded = loaded;
    this.synced = loaded.doc;
  }

  /** The document the disk holds as far as the editor knows: sync's base. */
  get baseDoc(): Node {
    return this.synced;
  }

  get version(): string {
    return this.base.version;
  }

  /** Saves what is pending, as the page is left. */
  leave() {
    if (this.pending) void this.flush(true);
  }

  /** Tries a failed save again now. */
  retry() {
    this.failures = 0;
    void this.flush();
  }

  /** What to send: only operations the server takes. A block with no text
   *  is never sent, so it can't be refused, and a refusal can't carry on into
   *  every later save. */
  private ops(): Op[] {
    return written(lineup(this.deps.engine, this.loaded, this.base.blocks, this.deps.doc()));
  }

  private hashes(): string[] {
    return this.base.blocks.map((b) => b.hash);
  }

  private async send(ops: Op[], doc: Node, keepalive: boolean, covers: number) {
    const { api, path, onState } = this.deps;
    onState({ kind: "saving", since: this.clock.now() });
    let saved: Saved;
    try {
      saved = await api.saveBlocks(path, this.base.version, this.hashes(), ops, keepalive);
    } catch (err) {
      this.failed(ops, err);
      return;
    }
    this.failures = 0;
    // What was kept before this save started, it carried; anything kept since
    // (leaving while it was in flight) stays.
    const kept = keptFor(this.deps.bundle, path, this.session);
    if (kept && kept.seq <= covers) dropKept(this.deps.bundle, path, this.session);
    if (saved.conflicts.length > 0 || saved.rewritten) {
      this.deps.onConflicts?.(saved.conflicts, saved.rewritten);
      const n = saved.conflicts.length;
      onState({ kind: "conflicts", label: `${n} ${n === 1 ? "block" : "blocks"} to check`, rewritten: saved.rewritten });
      return;
    }
    // Whatever else the disk has now, it has this document's changes.
    this.synced = doc;
    // Move the base on only when the page is now exactly the base with these
    // operations: then the disk is this document. A change made outside
    // meanwhile, anywhere on the page, keeps the old base, so the next save's
    // merge, and the next sync, see it (Archy, msg-680).
    const want = applied(this.base.blocks.map((b) => b.text), ops).join("\0");
    try {
      const entry = await api.entry(path);
      const next =
        entry.version === saved.version &&
        entry.blocks.map((b) => b.text).join("\0") === want &&
        rebase(this.deps.engine, doc, entry.body, entry.blocks, this.deps.from);
      if (next) {
        this.base = { version: entry.version, blocks: entry.blocks };
        this.loaded = next;
      }
    } catch {
      // The save landed; the next one goes against the old base.
    }
    onState({ kind: "saved", at: this.clock.now() });
  }

  private failed(ops: Op[], err: unknown) {
    const { onState } = this.deps;
    this.keep(ops);
    if (err instanceof ApiError && err.status === 404) {
      onState({ kind: "gone" });
      return;
    }
    const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
    onState({
      kind: "failed",
      reason: refused
        ? "Not saved: " + err.message
        : "Not saved: WikiShell is not running, or this computer is offline. Your text is kept in this tab.",
    });
    // A refusal says the same again; anything else is worth another try.
    if (refused) return;
    const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]!;
    this.failures++;
    this.cancel = this.clock.after(wait, () => void this.flush());
  }

  /** Keeps the operations in the tab, with their base, for a reload to put back. */
  private keep(ops: Op[]) {
    if (ops.length === 0) return;
    putKept(
      {
        bundle: this.deps.bundle,
        session: this.session,
        seq: ++this.seq,
        base: this.base.version,
        baseBlocks: this.hashes(),
        ops,
        at: this.clock.now(),
      },
      this.deps.path,
    );
  }
}
