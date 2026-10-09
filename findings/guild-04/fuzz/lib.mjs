// Shared fuzz harness for wave1000 guild-04 (store-room slice).
// Usage: import { fuzz, scratchDir, WT } from "./lib.mjs";
//   fuzz("F1-name", async () => { ...assertions... });
// Exits 0 on PASS, 1 on FAIL (assertion/timeout/unexpected throw).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const WT = "/home/hatch/workspace/pr-wave1000-guild-04";
export function scratchDir(prefix) {
  const base = process.env.TMPDIR ?? tmpdir();
  return mkdtempSync(join(base, prefix));
}
const TIMEOUT_MS = Number(process.env.FUZZ_TIMEOUT_MS ?? 60000);
export async function fuzz(name, fn) {
  const killer = setTimeout(() => {
    console.error(`FAIL ${name}: hung past ${TIMEOUT_MS}ms`);
    process.exit(1);
  }, TIMEOUT_MS);
  killer.unref();
  try {
    await fn();
    clearTimeout(killer);
    console.log(`PASS ${name}`);
    process.exit(0);
  } catch (e) {
    clearTimeout(killer);
    console.error(`FAIL ${name}: ${e?.stack ?? e}`);
    process.exit(1);
  }
}
// Assert the fn throws (any error) within boundMs — used for "must not hang" probes.
export async function throwsBounded(fn, boundMs = 10000) {
  const t0 = Date.now();
  let threw = false;
  try { await fn(); } catch { threw = true; }
  const dt = Date.now() - t0;
  assert.ok(threw, "expected a throw");
  assert.ok(dt < boundMs, `throw took ${dt}ms, expected < ${boundMs}ms`);
  return dt;
}
