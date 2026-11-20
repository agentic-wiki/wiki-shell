/**
 * The pairs of equal items two lists share, in order: Myers' diff (the same
 * matching the server does on block hashes, editor-adr.md, "Anchors and
 * matching"). Identical items pair in order, so position breaks ties.
 *
 * The common start and end are paired first, so an edit in a long page only
 * diffs what lies between. Time is O((n+m)·d) for d differences and memory
 * O(d²); past MAX_D differences the middle counts as replaced whole, which is
 * still a correct, if coarse, answer.
 */
export function matches(a: readonly string[], b: readonly string[], maxD = MAX_D): [number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < start; i++) out.push([i, i]);
  for (const [x, y] of middle(a.slice(start, endA), b.slice(start, endB), maxD)) out.push([x + start, y + start]);
  for (let i = 0; endA + i < a.length; i++) out.push([endA + i, endB + i]);
  return out;
}

/** Past this many differences, the rest is replaced whole. */
export const MAX_D = 2000;

function middle(a: readonly string[], b: readonly string[], maxD: number): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  // trace[d] holds the furthest x on each diagonal k in -d..d, at index k + d.
  const trace: Int32Array[] = [];
  let prev = new Int32Array(1);
  for (let d = 0; d <= Math.min(n + m, maxD); d++) {
    const v = new Int32Array(2 * d + 1);
    const at = (k: number) => prev[k + d - 1]!; // prev holds -(d-1)..d-1
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(v);
        return backtrack(trace, n, m);
      }
    }
    trace.push(v);
    prev = v;
  }
  return [];
}

function backtrack(trace: Int32Array[], n: number, m: number): [number, number][] {
  const out: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d - 1]!;
    const at = (k: number) => v[k + d - 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push([x, y]);
  }
  return out.reverse();
}
