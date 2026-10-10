// Dispute evidence validator (hard task 107).
// Implements docs/exchange/107-dispute-evidence-standard.md.
// Pure: validate(bundle, { fundedAt }) -> { ok, errors[], warnings[] }.
const KINDS = new Set(["artifact-link", "test-report", "message-ref", "commit-ref", "screenshot", "log-excerpt", "attestation"]);
const CLAIMS = new Set(["work.completed", "work.not_completed", "payment.owed", "payment.not_owed"]);
const CLAIM_SUPPORT = {
  "work.completed": new Set(["artifact-link", "test-report"]),
  "work.not_completed": new Set(["log-excerpt", "message-ref"]),
  "payment.owed": new Set(["message-ref", "attestation"]),
  "payment.not_owed": new Set(["artifact-link", "log-excerpt", "attestation"]),
};
const HASHED_KINDS = new Set(["artifact-link", "log-excerpt"]);
const STALE_MS = 30 * 24 * 3600 * 1000;

const iso = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

export function validateEvidenceBundle(bundle, { fundedAt = null, now = Date.now() } = {}) {
  const errors = [], warnings = [];
  const err = (code, message) => errors.push({ code, message });
  if (!bundle || typeof bundle !== "object") { err("invalid_bundle", "bundle must be an object"); return { ok: false, errors, warnings }; }

  if (bundle.bundleVersion !== "dispute-evidence/1") err("bad_version", "bundleVersion must be dispute-evidence/1");
  if (typeof bundle.bountyId !== "string" || !bundle.bountyId) err("bad_bounty", "bountyId is required");
  if (typeof bundle.submittedBy !== "string" || !bundle.submittedBy) err("bad_submitter", "submittedBy is required");
  if (!CLAIMS.has(bundle.claim)) err("bad_claim", `claim must be one of ${[...CLAIMS].join(", ")}`);

  const submittedAt = iso(bundle.submittedAt);
  if (submittedAt === null) err("bad_timestamp", "submittedAt must be ISO-8601");
  else if (submittedAt > now + 60_000) err("future_timestamp", "submittedAt is in the future");

  // Signature presence (cryptographic verification plugs in room identity keys).
  if (!bundle.signature || typeof bundle.signature.signer !== "string" || typeof bundle.signature.sig !== "string") {
    err("missing_signature", "bundles must carry an Ed25519 signature by the submitter");
  } else if (bundle.signature.signer !== bundle.submittedBy) {
    err("signature_mismatch", "signature.signer must equal submittedBy");
  }

  if (!Array.isArray(bundle.items) || bundle.items.length === 0) {
    err("empty_items", "items must be a non-empty array");
  } else {
    const kinds = new Set();
    bundle.items.forEach((item, i) => {
      const p = `items[${i}]`;
      if (!item || typeof item !== "object") { err("bad_item", `${p} must be an object`); return; }
      if (!KINDS.has(item.kind)) { err("bad_kind", `${p}.kind must be one of ${[...KINDS].join(", ")}`); return; }
      kinds.add(item.kind);
      if (typeof item.uri !== "string" || !item.uri) err("bad_uri", `${p}.uri is required`);
      if (typeof item.note !== "string" || !item.note.trim()) err("bad_note", `${p} needs a one-sentence note saying what it proves`);
      if (HASHED_KINDS.has(item.kind) && !/^[0-9a-f]{64}$/.test(item.sha256 ?? "")) {
        err("missing_hash", `${p}: ${item.kind} must carry the sha256 of the bytes it points to`);
      }
      const capturedAt = iso(item.capturedAt);
      if (capturedAt === null) err("bad_timestamp", `${p}.capturedAt must be ISO-8601`);
      else {
        if (capturedAt > now + 60_000) err("future_timestamp", `${p}.capturedAt is in the future`);
        if (fundedAt !== null && capturedAt < fundedAt) err("predates_bounty", `${p} was captured before the bounty was funded — inadmissible`);
        if (now - capturedAt > STALE_MS) warnings.push({ code: "stale_evidence", message: `${p} is older than 30 days — admissible but discounted` });
      }
    });
    if (CLAIMS.has(bundle.claim)) {
      const need = CLAIM_SUPPORT[bundle.claim];
      if (![...kinds].some(k => need.has(k))) {
        err("unsupported_claim", `claim ${bundle.claim} needs at least one of: ${[...need].join(", ")}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
