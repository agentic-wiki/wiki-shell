import { expect, test } from "bun:test";
import { matches } from "@/edit/diff";

/** The longest common subsequence's length, by the textbook table. */
function lcs(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i]![j] = a[i] === b[j] ? 1 + t[i + 1]![j + 1]! : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  return t[0]![0]!;
}

test("pairs equal items in order, as many as there can be", () => {
  expect(matches([], [])).toEqual([]);
  expect(matches(["a"], [])).toEqual([]);
  expect(matches(["a", "b", "c"], ["a", "b", "c"])).toEqual([
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
  expect(matches(["a", "b", "c"], ["a", "x", "c"])).toEqual([
    [0, 0],
    [2, 2],
  ]);
  // Two identical blocks: the one that stayed is the first, by position.
  expect(matches(["---", "p", "---"], ["---", "---"])).toEqual([
    [0, 0],
    [2, 1],
  ]);

  // Against the textbook, on random lists over a small alphabet.
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rand(12) }, () => "abc"[rand(3)]!);
    const b = Array.from({ length: rand(12) }, () => "abc"[rand(3)]!);
    const got = matches(a, b);
    expect(got.length).toBe(lcs(a, b));
    for (const [i, j] of got) expect(a[i]).toBe(b[j]!);
    for (let k = 1; k < got.length; k++) {
      expect(got[k]![0]).toBeGreaterThan(got[k - 1]![0]);
      expect(got[k]![1]).toBeGreaterThan(got[k - 1]![1]);
    }
  }
});

test("a 20,000-unit page replaced whole diffs fast, in bounded memory", () => {
  const a = Array.from({ length: 20_000 }, (_, i) => "a" + i);
  const b = Array.from({ length: 20_000 }, (_, i) => "b" + i);
  const t = performance.now();
  expect(matches(a, b)).toEqual([]);
  expect(performance.now() - t).toBeLessThan(2000);
  // One edit in the middle of it pairs everything else.
  const c = [...a];
  c[10_000] = "x";
  expect(matches(a, c)).toHaveLength(19_999);
});

test("past the cap, the middle counts as replaced, and the ends still pair", () => {
  expect(matches(["s", "a", "b", "e"], ["s", "c", "d", "e"], 1)).toEqual([
    [0, 0],
    [3, 3],
  ]);
});
