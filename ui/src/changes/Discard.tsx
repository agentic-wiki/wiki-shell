import { useEffect, useRef, useState } from "react";

/**
 * Discard, asked once in place: there is no undo, since the text was never
 * committed. The button becomes the question with Discard and Cancel, focus on
 * Cancel, so Enter twice never discards by accident.
 */
export function Discard({
  label = "Discard",
  question,
  onDiscard,
  className = "",
}: {
  label?: string;
  question: string;
  onDiscard: () => Promise<void>;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) cancel.current?.focus();
  }, [asking]);

  if (!asking) {
    return (
      <button
        ref={button}
        type="button"
        onClick={() => setAsking(true)}
        className={"text-muted hover:text-danger rounded-md px-1.5 text-[12px] font-medium " + className}
      >
        {label}
      </button>
    );
  }
  return (
    <span role="group" aria-label={question} className="bg-elev shadow-float flex items-center gap-2 rounded-lg px-2.5 py-1 text-[12.5px]">
      <span>{question}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onDiscard();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
        className="bg-danger text-on-accent rounded-md px-2 py-0.5 font-semibold disabled:opacity-50"
      >
        Discard
      </button>
      <button
        ref={cancel}
        type="button"
        onClick={() => {
          setAsking(false);
          requestAnimationFrame(() => button.current?.focus());
        }}
        onKeyDown={(e) => e.key === "Escape" && setAsking(false)}
        className="text-muted hover:text-fg rounded-md px-1.5 py-0.5 font-medium"
      >
        Cancel
      </button>
    </span>
  );
}
