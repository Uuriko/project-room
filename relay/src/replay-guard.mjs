// Replay protection for signed machine-control requests.
//
// A link signature is HMAC(timestamp . rawBody) and stays valid for the
// whole HMAC skew window, so a captured request (same bytes, same headers)
// verifies again until its timestamp ages out. `resume` unconditionally
// clears `halted`, so a replayed resume inside the window undoes an
// operator's halt; `halt` is idempotent but `pause`/`bye` replays are still
// unwanted. Track the signatures this machine already honored and refuse
// repeats. Callers run inside the DO's exclusive() section, so the
// check-and-mark is atomic under the isolate's single thread.
//
// Pure: no Durable Object, no clock reads. The caller supplies nowSec.
import { relayError } from "./errors.mjs";

export function assertFreshControlSignature(seen, signature, nowSec, windowSec) {
  const rows = Array.isArray(seen) ? seen : [];
  const cutoff = nowSec - windowSec;
  const fresh = rows.filter(row =>
    row && typeof row.signature === "string"
    && Number.isSafeInteger(row.at) && row.at > cutoff);
  if (fresh.some(row => row.signature === signature)) {
    throw relayError(409, "replay_rejected", "This signed control request was already used");
  }
  return [...fresh, { signature, at: nowSec }];
}
