import { Glyph } from "@/ui/IconButton";

/** Whether this is a Mac (or an iPad or iPhone), where shortcuts use ⌘. */
export const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * The shortcut key a hint names: ⌘ on a Mac, drawn (no font has the same ⌘
 * everywhere), and "Ctrl" elsewhere, which is the key there.
 */
export function ModKey() {
  return mac ? (
    <span className="inline-flex align-[-1px]" aria-label="Command">
      <Glyph size={11}>
        <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
      </Glyph>
    </span>
  ) : (
    <>Ctrl </>
  );
}
