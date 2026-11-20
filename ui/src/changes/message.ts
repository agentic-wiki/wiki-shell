/**
 * The commit message the changes view starts with, for the files ticked.
 *
 * Derived from what changed, because the alternatives are worse in both
 * directions. An empty box asks somebody to name work they just watched an agent
 * do, every time, for a log nobody reads that closely. A fixed string with the
 * date in it — "Update notes 2026-08-12 14:30" — says nothing a commit does not
 * already carry: git records when, and repeating it in the subject line is
 * duplicating metadata git owns while still saying nothing about the change.
 *
 * So: name the file when there is one, count them when there are several. It is
 * a starting point in an editable box, not a decision — anybody with something
 * better to say types it.
 */
export function proposeMessage(changes: { path: string }[]): string {
  if (changes.length === 0) return "Update notes";
  if (changes.length === 1) return "Update " + changes[0]!.path;
  const folder = commonFolder(changes.map((c) => c.path));
  return `Update ${changes.length} entries` + (folder ? " in " + folder : "");
}

/** The folder every path shares, or "" when they share none. */
function commonFolder(paths: string[]): string {
  const parts = paths.map((p) => p.split("/").slice(0, -1));
  const shared: string[] = [];
  for (let i = 0; i < (parts[0]?.length ?? 0); i++) {
    const segment = parts[0]![i]!;
    if (!parts.every((p) => p[i] === segment)) break;
    shared.push(segment);
  }
  return shared.join("/");
}
