// One file's `git diff`, read for the screen: each line numbered on its side,
// and each change line tagged with its `@@` hunk, the one a discard names.
// Ported from Foreman's review page (ui/src/app/diff.ts and fileTree.ts),
// changes-view-adr.md: one way to show a diff in both apps.

/** One line of a diff: a hunk header, or a line kept, added or removed, with
 *  its number on HEAD's side (old) and the worktree's (new). `hunk` is the
 *  index of the `@@` hunk it is in. */
export type DiffLine = {
  kind: "hunk" | "ctx" | "add" | "del" | "meta";
  text: string;
  hunk: number;
  old?: number;
  new?: number;
};

/** A file's diff as lines. git's header lines (`diff --git`, `index`, the
 *  modes, `---` and `+++`) are left out: the file's box says all of that. */
export function diffLines(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let hunk = -1;
  let old = 0;
  let next = 0;
  for (const line of raw.split("\n")) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      hunk++;
      old = Number(head[1]);
      next = Number(head[2]);
      lines.push({ kind: "hunk", text: line, hunk });
    } else if (hunk < 0) {
      // The header, before the first hunk.
      if (line.startsWith("Binary files")) lines.push({ kind: "meta", text: line, hunk });
    } else if (line.startsWith("+")) lines.push({ kind: "add", text: line, hunk, new: next++ });
    else if (line.startsWith("-")) lines.push({ kind: "del", text: line, hunk, old: old++ });
    else if (line.startsWith(" ")) lines.push({ kind: "ctx", text: line, hunk, old: old++, new: next++ });
    else if (line !== "") lines.push({ kind: "meta", text: line, hunk }); // "\ No newline at end of file"
  }
  return lines;
}

/** Lock files and the like: written by tools, rarely read in a review. */
const generated =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock)$/;

/** More changed lines than a file shows before it's opened. */
export const largeDiff = 500;

/** Why a file starts folded, if it does: a large change or a generated file. */
export function foldedAtFirst(path: string, changed: number): string | undefined {
  if (generated.test(path)) return "Generated: open it to read.";
  if (changed > largeDiff) return "A large change: open it to read.";
  return undefined;
}

/** A folder (its whole path, and its name: one folder, or a chain of lone
 *  folders joined by `/`) or one of the items given. */
export type TreeNode<T> =
  | { kind: "folder"; name: string; path: string; children: TreeNode<T>[] }
  | { kind: "file"; name: string; item: T };

type Folder<T> = Extract<TreeNode<T>, { kind: "folder" }>;

/** The items as a folder tree, by their path: folders before files, each
 *  alphabetically, a chain of lone folders as one row. */
export function fileTree<T extends { path: string }>(items: readonly T[]): TreeNode<T>[] {
  const root: Folder<T> = { kind: "folder", name: "", path: "", children: [] };
  for (const item of items) {
    const parts = item.path.replace(/^\//, "").split("/");
    let at = root;
    for (const name of parts.slice(0, -1)) {
      const path = at.path ? `${at.path}/${name}` : name;
      let next = at.children.find((c): c is Folder<T> => c.kind === "folder" && c.name === name);
      if (!next) {
        next = { kind: "folder", name, path, children: [] };
        at.children.push(next);
      }
      at = next;
    }
    at.children.push({ kind: "file", name: parts[parts.length - 1]!, item });
  }
  return shape(root.children);
}

function shape<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return nodes
    .map((n) => {
      if (n.kind === "file") return n;
      let folder = n;
      while (folder.children.length === 1 && folder.children[0]!.kind === "folder") {
        const only = folder.children[0] as Folder<T>;
        folder = { ...only, name: `${folder.name}/${only.name}` };
      }
      return { ...folder, children: shape(folder.children) };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
}

/** The items in the order the tree shows them: the diffs are read in that order. */
export function treeOrder<T extends { path: string }>(items: readonly T[]): T[] {
  const walk = (nodes: TreeNode<T>[]): T[] => nodes.flatMap((n) => (n.kind === "file" ? [n.item] : walk(n.children)));
  return walk(fileTree(items));
}
