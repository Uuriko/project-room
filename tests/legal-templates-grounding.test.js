// Legal templates grounding test (backlog O008 + O009).
//
// Every factual claim in docs/PRIVACY-POLICY-TEMPLATE.md and
// docs/TERMS-OF-SERVICE-TEMPLATE.md must be grounded in the product code:
// a snippet quoted from the template must also have matching evidence in a
// repo file. Writing a clause the product does not support fails the test.
//
// The templates are DRAFTS requiring legal review before publication —
// that banner is asserted too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const norm = (s) => s.replace(/\s+/g, " ").toLowerCase();
const normKeep = (s) => s.replace(/\s+/g, " ");

const PRIVACY = "docs/PRIVACY-POLICY-TEMPLATE.md";
const TERMS = "docs/TERMS-OF-SERVICE-TEMPLATE.md";

// [template, claim snippet, evidence sources (each: [file, regex])]
const EVIDENCE = [
  // ---- identity & legal-review banner ----
  [PRIVACY, "DRAFT — REQUIRES LEGAL REVIEW BEFORE PUBLICATION", [
    ["docs/PRIVACY-POLICY-TEMPLATE.md", /DRAFT — REQUIRES LEGAL REVIEW BEFORE PUBLICATION/],
  ]],
  [TERMS, "DRAFT — REQUIRES LEGAL REVIEW BEFORE PUBLICATION", [
    ["docs/TERMS-OF-SERVICE-TEMPLATE.md", /DRAFT — REQUIRES LEGAL REVIEW BEFORE PUBLICATION/],
  ]],
  [PRIVACY, "not legal advice", [
    ["server/account-deletion.mjs", /RETENTION_POLICY/],
  ]],

  // ---- what data is collected ----
  [PRIVACY, "email address", [
    ["server/account-login-methods.mjs", /email TEXT/],
  ]],
  [PRIVACY, "scrypt verifier", [
    ["server/account-login-methods.mjs", /scrypt verifier/],
  ]],
  [PRIVACY, "magic-link codes", [
    ["server/account-login-methods.mjs", /magic.*verified email address that may receive magic-link codes/],
  ]],
  [PRIVACY, "WebAuthn", [
    ["server/account-login-methods.mjs", /passkey.*WebAuthn/],
  ]],
  [PRIVACY, "OAuth", [
    ["server/account-login-methods.mjs", /oauth.*provider \('github' \| 'google'\)/],
  ]],
  [PRIVACY, "recovery codes", [
    ["server/account-login-methods.mjs", /recovery-code-set/],
  ]],
  [PRIVACY, "display name", [
    ["server/access-requests.mjs", /display_name TEXT NOT NULL/],
  ]],
  [PRIVACY, "room messages", [
    ["server/account-deletion.mjs", /Messages and files in personal rooms/],
  ]],
  [PRIVACY, "public key", [
    ["server/account-login-methods.mjs", /public_key_cose TEXT NOT NULL/],
  ]],
  [PRIVACY, "hashed at rest", [
    ["server/account-login-methods.mjs", /hashed at rest \(sha256 with a/],
  ]],
  [PRIVACY, "No secret value is ever logged or returned by list methods", [
    ["server/account-login-methods.mjs", /No secret value is ever logged or returned by list methods/],
  ]],
  [PRIVACY, "returned once", [
    ["docs/ROUTE-AUTH-TABLE.md", /the one-time identity secret is returned once/],
  ]],
  [PRIVACY, "single-use", [
    ["server/agent-invites.mjs", /the code burns on redeem/],
  ]],
  [PRIVACY, "invite emails", [
    ["docs/FAQ.md", /I didn't receive an invite email/],
  ]],
  [PRIVACY, "connected Gmail", [
    ["server/account-deletion.mjs", /Connected Gmail data \(gmail_mailboxes/],
  ]],
  [PRIVACY, "private inbox", [
    ["server/account-deletion.mjs", /Private inbox content is permanently deleted/],
  ]],
  [PRIVACY, "IP addresses are rate-limited per address", [
    ["server/http.mjs", /per-address rate limit/],
  ]],
  [PRIVACY, "hashed, never stored raw", [
    ["server/legal-store.mjs", /ip_hash TEXT NOT NULL/],
  ]],
  [PRIVACY, "Cloudflare", [
    ["docs/ROOM-DEPLOYMENT.md", /entry and the canonical Worker/],
  ]],
  [PRIVACY, "Durable Object", [
    ["docs/BACKUPS.md", /inside a Durable Object/],
  ]],
  [PRIVACY, "R2", [
    ["docs/BACKUPS.md", /room-backups\/YYYY-MM-DD\.ndjson/],
  ]],

  // ---- retention / deletion ----
  [PRIVACY, "GET /api/account/retention", [
    ["server/account-deletion.mjs", /Served verbatim at\s+\/\/ GET \/api\/account\/retention/],
  ]],
  [PRIVACY, "security audit rows", [
    ["server/account-deletion.mjs", /account_access_events rows are retained for security auditing/],
  ]],
  [PRIVACY, "room-owned history", [
    ["server/account-deletion.mjs", /Room events already shared with other members.*are room-owned history/],
  ]],
  [PRIVACY, "deactivated tombstone", [
    ["server/account-deletion.mjs", /deactivated tombstone \(active=0, profile scrubbed\)/],
  ]],
  [PRIVACY, "7 years", [
    ["server/audit-retention.mjs", /critical: 2555/],
  ]],
  [PRIVACY, "abuse reports", [
    ["server/account-deletion.mjs", /public_abuse_reports rows are retained as safety evidence/],
  ]],

  // ---- visibility ----
  [PRIVACY, "Room members only", [
    ["docs/FAQ.md", /Room members only\. Private rooms are visible to members/],
  ]],
  [PRIVACY, "opt-in public read-only face", [
    ["docs/ROUTE-AUTH-TABLE.md", /enables\/disables the opt-in public read-only face/],
  ]],
  [PRIVACY, "public by design", [
    ["docs/ROUTE-AUTH-TABLE.md", /Immutable public submitted evidence/],
  ]],
  [PRIVACY, "display names are visible to other members", [
    ["docs/OPERATOR.md", /returns `accounts` with ids and names only/],
  ]],
  [PRIVACY, "webhook", [
    ["server/agent-webhook-subscriptions.mjs", /signed delivery payload/],
  ]],

  // ---- cookies ----
  [PRIVACY, "HttpOnly", [
    ["server/http.mjs", /HttpOnly; SameSite/],
  ]],
  [PRIVACY, "SameSite=Strict", [
    ["server/http.mjs", /sameSite = "Strict"/],
  ]],
  [PRIVACY, "session expires", [
    ["server/http.mjs", /created\.session\.expiresAt/],
  ]],

  // ---- terms facts ----
  [TERMS, "TERMS_VERSION", [
    ["server/legal-store.mjs", /export const TERMS_VERSION = "2026-10-02"/],
  ]],
  [TERMS, "accepted_at", [
    ["server/legal-store.mjs", /accepted_at INTEGER NOT NULL/],
  ]],
  [TERMS, "password-signup", [
    ["server/legal-store.mjs", /password-signup.*google-oauth/],
  ]],
  [TERMS, "room credits are valueless ledger units", [
    ["docs/SPEND-PRIMITIVE.md", /room credits are valueless ledger units — no cash-out/],
  ]],
  [TERMS, "today this pays in reputation receipts; cash comes later", [
    ["docs/ROUTE-AUTH-TABLE.md", /Finish records submitted evidence; does not accept or pay/],
  ]],
  [TERMS, "escrow", [
    ["docs/FAQ.md", /Bounties use\s+escrow/],
  ]],
  [TERMS, "No real funds move without explicit owner approval", [
    ["docs/FAQ.md", /No real funds move without\s+explicit owner approval/],
  ]],
  [TERMS, "grants no room access by itself", [
    ["docs/ROUTE-AUTH-TABLE.md", /grants no room access by itself/],
  ]],
  [TERMS, "Guests", [
    ["docs/ROUTE-AUTH-TABLE.md", /guest writes refused/],
  ]],
  [TERMS, "blocked until ownership is transferred", [
    ["server/account-deletion.mjs", /blocks deletion until ownership is transferred/],
  ]],
  [TERMS, "confirm-then-delete", [
    ["server/account-deletion.mjs", /confirm-then-delete/],
  ]],
  [TERMS, "DM consent", [
    ["docs/ROUTE-AUTH-TABLE.md", /request DM consent toward another active member/],
  ]],
  [TERMS, "abuse report", [
    ["server/legal-store.mjs", /public_abuse_reports/],
  ]],
  [TERMS, "operator", [
    ["docs/OPERATOR.md", /The operator surface is how a person who runs Room removes test data/],
  ]],
  [TERMS, "per-address rate limit", [
    ["docs/ROUTE-AUTH-TABLE.md", /bounded by a per-address rate limit/],
  ]],
  [TERMS, "disputes", [
    ["server/bounty-disputes.mjs", /./],
  ]],
];

test("legal templates exist and carry the draft-review banner", () => {
  for (const path of [PRIVACY, TERMS]) {
    assert.ok(existsSync(join(ROOT, path)), `${path} must exist`);
    const body = read(path);
    assert.match(body, /DRAFT — REQUIRES LEGAL REVIEW BEFORE PUBLICATION/);
    assert.match(body, /not legal advice/i);
  }
});

test("every factual claim in the legal templates is grounded in code", () => {
  const failures = [];
  for (const [template, claim, sources] of EVIDENCE) {
    const body = read(template);
    const hay = norm(body);
    if (!hay.includes(norm(claim))) {
      failures.push(`claim missing from ${template}: ${JSON.stringify(claim)}`);
      continue;
    }
    for (const [src, pattern] of sources) {
      let srcBody;
      try {
        srcBody = read(src);
      } catch {
        failures.push(`evidence file unreadable: ${src} (claim: ${JSON.stringify(claim)})`);
        continue;
      }
      if (!pattern.test(normKeep(srcBody))) {
        failures.push(`no code evidence for claim ${JSON.stringify(claim)} in ${src} (pattern ${pattern})`);
      }
    }
  }
  assert.deepEqual(failures, [], `ungrounded claims:\n${failures.join("\n")}`);
});

test("templates name the product honestly (no generic placeholders)", () => {
  for (const path of [PRIVACY, TERMS]) {
    const body = read(path);
    assert.match(body, /Project Room/);
    assert.doesNotMatch(body, /\[COMPANY NAME\]|\[INSERT|Lorem ipsum/);
  }
});
