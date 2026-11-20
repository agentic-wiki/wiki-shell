import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "@/api";
import { useGit } from "@/shell/GitActions";

/**
 * "Not committed", in a page's toolbar while the page has changes git hasn't
 * taken: a link to them in the changes view. Read from the changes list, whose
 * paths are bundle paths (git status names them from the repository's root),
 * and only when the repository's status says something changed, so a clean
 * wiki asks nothing.
 */
export function NotCommitted({ path }: { path: string }) {
  const [git] = useGit();
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!git?.repo || git.changes.length === 0) {
      setChanged(false);
      return;
    }
    const ac = new AbortController();
    api
      .changes(ac.signal)
      .then((c) => setChanged(c.files.some((f) => f.path === path)))
      .catch(() => {});
    return () => ac.abort();
  }, [git, path]);
  if (!changed) return null;
  return (
    <Link
      data-print="hide"
      to={"/changes#" + encodeURIComponent(path)}
      className="bg-panel-2 text-muted hover:text-fg flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12.5px] font-medium"
    >
      <span aria-hidden className="bg-warn size-1.5 rounded-full" />
      Not committed
    </Link>
  );
}
