import { NARROW, useMedia } from "@/media";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Saying an action landed: "Saved to Read later", "Moved to Done", "Pulled 3
 * commits". One at a time, gone after a beat, a new one replacing the last —
 * no queue, no stacking. At most one way on ("Open it"); something that needs
 * a decision is a dialog, not a toast.
 */
type Tone = "ok" | "danger";
/** The one thing a toast may offer: a way to where it is about. */
type Action = { label: string; run: () => void };
type Toast = { message: string; tone: Tone; action?: Action; id: number };
type Show = (message: string, tone?: Tone, action?: Action) => void;

const Ctx = createContext<Show | null>(null);

/** How long a toast stays: long enough to read a short sentence once. */
const SHOWN_MS = 2600;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const next = useRef(0);
  // Above the tab bar on a narrow screen, which would otherwise cover it.
  const narrow = useMedia(NARROW);
  const show = useCallback<Show>((message, tone = "ok", action) => {
    setToast({ message, tone, action, id: ++next.current });
  }, []);

  // Timed per toast, so a new one restarts the clock rather than inheriting
  // what was left of the last one's.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <Ctx.Provider value={show}>
      {children}
      {toast && (
        <div
          key={toast.id}
          role="status"
          data-print="hide"
          className={[
            narrow ? "bottom-[78px]" : "bottom-6",
            // As wide as the words, at most the screen less 16px a side, and
            // wrapping there: a phone shows a long reason whole.
            "bg-fg text-bg shadow-float animate-wv-in fixed left-1/2 z-90 flex w-max max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2.5 rounded-[11px] px-4 py-2.5 text-[13px] font-medium",
          ].join(" ")}
        >
          <span
            aria-hidden
            className={["size-[7px] shrink-0 rounded-full", toast.tone === "ok" ? "bg-ok" : "bg-danger"].join(" ")}
          />
          <span className="min-w-0">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
              className="text-bg shrink-0 font-semibold underline underline-offset-2"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

/** The one function a component needs: `toast("Saved")`, or with `"danger"`. */
export function useToast(): Show {
  const show = useContext(Ctx);
  if (!show) throw new Error("useToast outside a ToastProvider");
  return show;
}
