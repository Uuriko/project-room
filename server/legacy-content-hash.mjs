// Definition-aware content-hash comparison for the legacy operator
// repair path (P1 lane B5).
//
// A stored per-room baseline hash (integrity_room_state.projection_hash)
// is untagged: it was computed under whichever content-hash definition
// was current when the baseline was adopted — the fused v2 stream for
// an untransitioned baseline, the ranged v3 composition after the
// transition. Comparing a stored v2 hash against a freshly computed v3
// hash manufactures a content_hash_mismatch on every clean legacy
// room — the repair would refuse exactly the rooms it exists to serve.
// The store's own bootstrap proof (bootstrapLegacyWriteProofs in
// write-integrity.mjs) already judges a stored baseline this way, and
// this module gives the operator repair the same seam: a stored hash
// is accepted iff it matches the live projection under its OWN
// definition (v2 or v3); a hash that is no definition's output for
// these bytes — garbage, or a genuine drift under both definitions —
// is refused. Definition-aware is not permissive.
import { projectionContentHash, projectionContentHashV2 } from './write-integrity.mjs';

// Drift between the stored baseline and the live projection, judged
// definition-aware. An absent stored hash is NOT drift: it is the
// caller's missing-proof outcome (the repair's content_proof_missing),
// kept distinct so a hashless room is never reported as a mismatch.
// The v3 comparison runs first and the v2 stream only on a v3 miss, so
// a current-definition room pays exactly the comparison it always did.
export function legacyContentHashDrift(db, roomId, sequence, projection, storedHash) {
  if (typeof storedHash !== "string" || storedHash === "") return false;
  if (projectionContentHash(db, roomId, sequence, projection) === storedHash) return false;
  return projectionContentHashV2(db, roomId, sequence, projection) !== storedHash;
}
