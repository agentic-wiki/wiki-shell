/**
 * Whether the server now serves a newer app than this tab runs. A tab left
 * open keeps its JavaScript when WikiShell is restarted with a new build: the
 * event stream just reconnects. So after a reconnect, the app index.html names
 * now is compared with this tab's own script (both hashed by the build).
 */
export async function updated(): Promise<boolean> {
  const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
  if (!mine) return false;
  try {
    const html = await fetch("/", { cache: "no-store" }).then((r) => r.text());
    const now = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? /<script[^>]+src="([^"]+)"[^>]*type="module"/.exec(html)?.[1];
    return !!now && now !== mine;
  } catch {
    return false;
  }
}
