// Replay protection for signed machine-control requests.
//
// A link signature is HMAC(timestamp . path . rawBody) and stays valid for
// the whole HMAC skew window, so a captured request (same bytes, same headers)
// verifies again until its timestamp ages out. `resume` unconditionally
// clears `halted`, so a replayed resume inside the window undoes an
// operator's halt; `halt` is idempotent but `pause`/`bye` replays are still
// unwanted. Track the signatures this machine already honored and refuse
// repeats. Callers run inside the DO's exclusive() section, so the
// check-and-mark is atomic under the isolate's single thread.
//
// The replay memory is keyed on the request's own timestamp, not on when
// the relay first saw it: the HMAC stays valid for +/- HMAC_SKEW_SEC around
// the stamp, so pruning on receipt time forgets a future-dated signature
// while it still verifies (QA slice D). A row may be dropped once
// nowSec - stamp > windowSec, because the HMAC can no longer verify then.
// A non-integer stamp fails closed to receipt time, never to an unprunable
// row (which would fail open).
//
// Pure: no Durable Object, no clock reads. The caller supplies nowSec.
import { relayError } from "./errors.mjs";

export function assertFreshControlSignature(seen, signature, nowSec, windowSec, stampSec = nowSec) {
  const rows = Array.isArray(seen) ? seen : [];
  const at = Number.isSafeInteger(stampSec) ? stampSec : nowSec;
  const cutoff = nowSec - windowSec;
  const fresh = rows.filter(row =>
    row && typeof row.signature === "string"
    && Number.isSafeInteger(row.at) && row.at > cutoff);
  if (fresh.some(row => row.signature === signature)) {
    throw relayError(409, "replay_rejected", "This signed control request was already used");
  }
  return [...fresh, { signature, at }];
}
