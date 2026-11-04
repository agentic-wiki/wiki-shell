import { useEffect } from "react";
import { State, StateIcon } from "@/ui/State";

const TITLE = "Open this wiki with its link";

/**
 * What a tab with no working token shows.
 *
 * Only a server on a network address asks for a token, so the reader is often
 * on another machine and someone else may have started wikiview: the copy says
 * who to ask rather than pointing at a terminal they cannot see. Not an error:
 * nothing failed, this window simply has no link the server would open for it.
 * A tab opened without one, and a tab left open across a restart (which creates
 * a new token) both land here, which is why the copy says the tab has no
 * *working* link rather than that no link was opened.
 *
 * `host` is the other case that looks the same from here, and happens only on a
 * loopback bind: the name in the address is not a loopback name, such as the
 * machine's network name. Same screen, same title, same origin line; only the
 * sentence differs, because the reader is on the same machine and can open the
 * printed address themselves.
 *
 * Nothing from the bundle is on it: a wiki can hold client notes, so a window
 * the server refused is given nothing.
 */
export function NeedsLink({ reason }: { reason: "token" | "host" }) {
  const origin = window.location.origin;

  // The tab would otherwise keep naming the entry it was showing when the
  // stream died, which is no longer what is on screen.
  useEffect(() => {
    document.title = `${TITLE} · wikiview`;
  }, []);

  return (
    <State
      icon={StateIcon.key}
      // A steady state on first load (nothing to announce: the region arrives
      // filled), and on a mid-session 401 the only thing that tells a
      // screen-reader user the page changed under them.
      live
      title={TITLE}
      detail={
        <>
          {reason === "host" ? (
            <>
              wikiview opens this wiki only at the address it printed when it started, and this
              tab is on a different one. Open that address exactly as printed.
            </>
          ) : (
            <>
              wikiview opens this wiki only with the link it printed when it started, and this tab
              has no working one. Ask the person who started wikiview for that link. After a
              restart, there is a new one.
            </>
          )}
          {/* The instance's identity, not a link: clicking it reloads into this
              same state. Never the token and never the fragment. Inherits the
              detail's `text-muted` rather than `text-faint`: at 13px this label
              is the point of the line in the wrong-address case, and faint does
              not reach AA against the panel. */}
          <span className="mt-3 block">
            This tab is on <span className="text-fg font-mono break-all">{origin}</span>
          </span>
        </>
      }
    />
  );
}
