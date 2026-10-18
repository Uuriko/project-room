// Scan-on-write for secrets (W10, bright line B2): deliveries and room
// messages are refused at the shared persistence layer when they carry a
// credential-shaped string. The write does NOT happen — the content is
// never captured into the room log, a claim item, or a public-work
// receipt. Redaction is deliberately not offered: it silently alters user
// content and still captures a mangled secret.
//
// Detection is the existing detector (server/secret-scan.mjs — the same
// PATTERNS the CI tree scan and the PR diff gate run), restricted to its
// high-confidence shapes. No new patterns are invented here.
//
// INCLUDED (provider- or format-shaped; a match is a credential with
// negligible legitimate prose/code use):
//   aws-access-key    AKIA… access key ids
//   aws-secret-key    named aws_secret_access_key assignments with a value
//   github-token      ghp_/gho_ tokens
//   private-key       PEM/OpenSSH private-key block headers
//   slack-token       xox[baprs]- tokens
//   stripe-key        sk_/rk_ live AND test keys (a test key is still a
//                     secret key; Stripe treats both as non-shareable)
//   room-credential   pri_/rak_/ga1. room credentials — the same shapes
//                     server/room-export.mjs scrubs on export
//                     (TOKEN_SOURCE), so write and export agree
//   telegram-bot-token  BotFather token shape (the 2026-09-17 incident class)
//   wallet-seed       quoted seed/mnemonic phrases with explicit context
//
// EXCLUDED from the write scan (still enforced by CI on the code tree):
//   generic-api-key / generic-secret — bare `api_key = …` / `password = …`
//     assignments are how legitimate code deliveries read secrets from env
//     and how test fixtures are written; the shape alone cannot tell a
//     fixture from a credential, and the programme's falsifier for this
//     lane is the false-positive rate on legitimate deliveries.
//   bearer-token — `Authorization: Bearer …` appears throughout legitimate
//     API documentation and delivered runbooks, usually with placeholders.
//   high-entropy — hashes, digests, UUIDs, SRI hashes, base64 samples and
//     git SHAs are the normal currency of a delivery; the entropy rule
//     flags them all (see the FP probe set in
//     tests/secret-write-scan.test.js, which the full detector would fail
//     and this subset passes 16/16).
//
// One allowlist entry is inherited from the CI scan
// (scripts/secret-scan-check.mjs): AKIAIOSFODNN7EXAMPLE, AWS's own
// documented example access key id, is documentation, not a credential.
//
// Findings returned here carry ONLY the rule id and label — never the
// detector's redacted preview and never any part of the matched value —
// so refusal copy and logs built from them cannot leak the secret.
import { scanText } from "./secret-scan.mjs";

export const SECRET_WRITE_PATTERN_IDS = Object.freeze([
  "aws-access-key", "aws-secret-key", "github-token", "private-key",
  "slack-token", "stripe-key", "room-credential", "telegram-bot-token",
  "wallet-seed",
]);

export const SECRET_WRITE_ALLOWLIST = Object.freeze([/AKIAIOSFODNN7EXAMPLE/]);

export const SECRET_DETECTED_CODE = "secret_detected";

export function secretDetectedMessage(field, label) {
  return `A credential-shaped string (${label}) was detected in ${field}; the write was refused and nothing was saved. `
    + "Remove the credential and send again — credentials are never stored in room content.";
}

// First high-confidence finding in one string, as { rule, label } or null.
export function findSecretWriteFinding(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const [finding] = scanText(text, {
    patternIds: SECRET_WRITE_PATTERN_IDS, includeEntropy: false, allowlist: SECRET_WRITE_ALLOWLIST,
  });
  return finding ? Object.freeze({ rule: finding.rule, label: finding.label }) : null;
}

// Walk the string leaves of a value (strings, arrays, plain objects) and
// return the first finding as { field, rule, label }, where field is the
// top-level key the value arrived under. Depth and node budgets keep the
// walk bounded on adversarial payloads; callers have already size-checked
// the payloads this runs on.
export function findSecretInFields(fields) {
  if (!fields || typeof fields !== "object") return null;
  let budget = 512;
  const walk = (value, field) => {
    if (budget-- <= 0) return null;
    if (typeof value === "string") {
      const finding = findSecretWriteFinding(value);
      return finding ? Object.freeze({ field, ...finding }) : null;
    }
    if (Array.isArray(value)) {
      for (const entry of value) { const hit = walk(entry, field); if (hit) return hit; }
      return null;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) { const hit = walk(entry, field); if (hit) return hit; }
    }
    return null;
  };
  for (const [field, value] of Object.entries(fields)) {
    const hit = walk(value, field);
    if (hit) return hit;
  }
  return null;
}
