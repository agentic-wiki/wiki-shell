/**
 * The token this run's server accepts, and the one way it reaches this tab.
 *
 * Only a server on a network address has one; on localhost the tab holds none
 * and `api.ts` sends a placeholder instead. A network server prints its address
 * with the token in the fragment:
 * `http://<address>:<port>/#t=<token>`. A fragment rather than a query string
 * because a fragment never reaches the server, a log, or the `Referer` of a link
 * clicked from the page. It is taken from the address when the app starts and on
 * every later fragment navigation, kept for this tab only, and removed from the
 * address bar, so a screenshot or a bookmark cannot carry it.
 *
 * The token's wire form is 32 random bytes as 64 lowercase hex characters, sent
 * exactly as printed in the one place it travels, the `X-Wikiview-Token` header.
 * This file neither decodes nor normalises it.
 *
 * A module rather than React state: `api.ts` reads it on every request and
 * nothing renders from it, so a second copy in a component could only disagree
 * with this one.
 */

/** Where this tab's copy lives. `sessionStorage`, not `localStorage`: a token
 *  belongs to the window that was opened with it, not to every later window. */
const KEY = "wikiview.token";

/** The fragment's key when the URL carries a token: `#t=…`. The server prints
 *  the URL, so this name is a contract with it, not a local choice. */
const FRAGMENT = "t";

/** 32 bytes as lowercase hex, and nothing else. Checked before a fragment is
 *  believed: `#t=…` is also what a heading anchor looks like, and a page whose
 *  anchor happened to be token-shaped must not be mistaken for one. */
const SHAPE = /^[0-9a-f]{64}$/;

/** The tab's copy, and the fallback for a browser that refuses to store it: a
 *  wiki opened in private mode still works for as long as the tab is open. */
let held: string | null = null;

/** Keeps a token for this tab. */
export function storeToken(token: string): void {
  held = token;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Nothing to do: the copy above carries this tab.
  }
}

/** The token this tab holds, or null when it holds none. */
export function token(): string | null {
  if (held) return held;
  try {
    held = sessionStorage.getItem(KEY);
  } catch {
    // As above: no storage, so no copy — the tab has no token.
  }
  return held;
}

/** Forgets the token: the server has told us it no longer accepts it. */
export function clearToken(): void {
  held = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}

/**
 * Takes a token out of the address bar, if the URL carries one.
 *
 * Called as the app starts and again on every later fragment navigation, so it
 * has to be safe to call at any time: a URL that carries no token leaves this
 * tab exactly as it was.
 *
 * A fragment that is token-shaped replaces whatever this tab held. That is how a
 * tab left on an old address recovers: pasting the newly printed link into it is
 * a fragment-only navigation, and the new token has to win.
 *
 * Returns whether it took one, which is what tells a caller that the address
 * changed for a reason worth acting on.
 */
export function takeTokenFromUrl(): boolean {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith(FRAGMENT + "=")) return false;
  const value = hash.slice(FRAGMENT.length + 1);
  if (!SHAPE.test(value)) return false;
  storeToken(value);
  // Keep the path and the query, drop the fragment: the route is in the path,
  // and the token has no business staying in an address that gets shared.
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", pathname + search);
  return true;
}
