// FIX-40 — direct uniqueness assertions on raw registry arrays.
//
// COLLIDE-4 exp 2 showed registry corruption was visible ONLY to raw-array
// assertions (new Set(arr).size === arr.length); no direct assertion existed
// anywhere. Every raw registry array whose entries must be unique gets a
// direct assertUnique call at module load (or in the validator that owns it),
// so a corrupted registry fails loudly at import time instead of silently
// shadowing entries downstream.
//
// Zero dependencies: importable from src/ (browser bundle) and server/ alike.
//
// assertUnique(arr, label, key = v => v)
//   Throws Error naming each duplicated entry ("label: "a" (x2)") when the
//   raw array holds repeats; returns arr unchanged otherwise.
// duplicatesOf(arr, key) — [{ key, count }] for the repeats only.
export function duplicatesOf(arr, key = value => value) {
  if (!Array.isArray(arr)) throw new TypeError(`duplicatesOf: expected an array, got ${typeof arr}`);
  const counts = new Map();
  for (const item of arr) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = [];
  for (const [k, count] of counts) {
    if (count > 1) out.push({ key: k, count });
  }
  return out;
}

export function assertUnique(arr, label, key = value => value) {
  const dupes = duplicatesOf(arr, key);
  if (dupes.length) {
    const named = dupes.map(({ key: k, count }) => `${JSON.stringify(k)} (x${count})`).join(", ");
    throw new Error(`duplicate entries in ${label}: ${named}`);
  }
  return arr;
}
