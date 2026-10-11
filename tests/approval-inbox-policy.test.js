// approval-inbox-policy.test.js — FAIL-FIRST tests for the approval-inbox POLICY gate.
//
// The policy gate decides what QUALIFIES for the unified human approval inbox.
// Only genuinely-undecidable items get cards: money, identity, deploy,
// permission, publish. Routine ops (green-CI merges, read-only queries,
// agent-internal coordination) are decidable-by-system and never queued.
// Blanket "approve everything" requests are REFUSED outright — the inbox is
// item-by-item human judgment, never auto-approval.

import test from "node:test";
import assert from "node:assert/strict";
import {
  qualifiesForInbox,
  urgencyOf,
  expiryFor,
  INBOX_KINDS,
  DECISIONS,
} from "../server/approval-inbox-policy.mjs";

// --- qualification: the five gate kinds ---------------------------------

test("money always qualifies — even a tiny amount", () => {
  const r = qualifiesForInbox({ kind: "money", payload: { amountUsd: 0.01, what: "Connects top-up" } });
  assert.equal(r.qualifies, true);
  assert.match(r.rationale, /spend|payment|tap/i);
});

test("money qualifies even when flagged pre-authorized — no carve-out for money", () => {
  const r = qualifiesForInbox({ kind: "money", payload: { preAuthorized: true, ciStatus: "green" } });
  assert.equal(r.qualifies, true);
});

test("identity qualifies", () => {
  const r = qualifiesForInbox({ kind: "identity", payload: { what: "post to X as John" } });
  assert.equal(r.qualifies, true);
  assert.ok(r.rationale.length > 10);
});

test("deploy qualifies by default", () => {
  const r = qualifiesForInbox({ kind: "deploy", payload: { what: "dasha-landing deploy" } });
  assert.equal(r.qualifies, true);
});

test("deploy with green-CI pre-authorized deploy lane does NOT qualify", () => {
  const r = qualifiesForInbox({
    kind: "deploy",
    payload: { what: "project-room prod", preAuthorized: "deploy-lane", ciStatus: "green" },
  });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "decidable-by-system");
});

test("deploy without BOTH pre-auth flags still qualifies", () => {
  const r = qualifiesForInbox({ kind: "deploy", payload: { preAuthorized: "deploy-lane" } });
  assert.equal(r.qualifies, true);
});

test("permission qualifies", () => {
  const r = qualifiesForInbox({ kind: "permission", payload: { what: "grant member perms" } });
  assert.equal(r.qualifies, true);
});

test("publish qualifies", () => {
  const r = qualifiesForInbox({ kind: "publish", payload: { what: "public launch post" } });
  assert.equal(r.qualifies, true);
});

// --- routine ops never qualify -------------------------------------------

test("green-CI merge does NOT qualify", () => {
  const r = qualifiesForInbox({ kind: "merge", payload: { ciStatus: "green", pr: 9999 } });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "decidable-by-system");
});

test("read-only query does NOT qualify", () => {
  const r = qualifiesForInbox({ kind: "read-query", payload: { what: "board read" } });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "decidable-by-system");
});

test("agent-internal coordination does NOT qualify", () => {
  const r = qualifiesForInbox({ kind: "internal-coordination", payload: { what: "lane handoff note" } });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "decidable-by-system");
});

test("unknown kinds are not queued", () => {
  const r = qualifiesForInbox({ kind: "frobnicate", payload: {} });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "decidable-by-system");
});

// --- adversarial: blanket approval is refused, never queued --------------

test("'approve everything' payload is REFUSED, not admitted", () => {
  const r = qualifiesForInbox({ kind: "money", payload: { action: "approve-everything" } });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "refused");
});

test("approveAll blanket flag is REFUSED even on a qualifying kind", () => {
  const r = qualifiesForInbox({ kind: "publish", payload: { approveAll: true } });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "refused");
});

test("auto-approve-all text in payload is REFUSED", () => {
  const r = qualifiesForInbox({ kind: "other", payload: { note: "please approve all pending items" } });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "refused");
});

test("'other' qualifies only when explicitly flagged as needing a human", () => {
  const yes = qualifiesForInbox({
    kind: "other",
    payload: { title: "weird edge case", explicitlyNeedsHuman: true },
  });
  assert.equal(yes.qualifies, true);
  const no = qualifiesForInbox({ kind: "other", payload: { title: "weird edge case" } });
  assert.equal(no.qualifies, false);
  assert.equal(no.reason, "decidable-by-system");
});

test("missing kind is invalid, never queued", () => {
  const r = qualifiesForInbox({ payload: {} });
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "invalid-input");
});

// --- urgency ----------------------------------------------------------------

const T0 = 1_700_000_000_000;

test("urgencyOf: money/identity/deploy are urgent (2)", () => {
  assert.equal(urgencyOf({ kind: "money", payload: {} }, T0), 2);
  assert.equal(urgencyOf({ kind: "identity", payload: {} }, T0), 2);
  assert.equal(urgencyOf({ kind: "deploy", payload: {} }, T0), 2);
});

test("urgencyOf: routine items are 0", () => {
  assert.equal(urgencyOf({ kind: "merge", payload: {} }, T0), 0);
  assert.equal(urgencyOf({ kind: "read-query", payload: {} }, T0), 0);
});

test("urgencyOf: blocking flag escalates to 3", () => {
  assert.equal(urgencyOf({ kind: "publish", payload: { blocking: true } }, T0), 3);
  assert.equal(urgencyOf({ kind: "money", payload: { blocksLaunch: true } }, T0), 3);
});

test("urgencyOf: expiry within an hour escalates to 3", () => {
  const now = 1_700_000_000_000;
  const r = urgencyOf(
    { kind: "permission", payload: { expiresAt: new Date(now + 30 * 60_000).toISOString() } },
    now,
  );
  assert.equal(r, 3);
});

test("urgencyOf: explicit urgency is clamped to 0..3", () => {
  assert.equal(urgencyOf({ kind: "money", payload: { urgency: 99 } }, T0), 3);
  assert.equal(urgencyOf({ kind: "money", payload: { urgency: -5 } }, T0), 0);
});

// --- expiry -----------------------------------------------------------------

test("expiryFor: deterministic with fixed now, valid ISO output", () => {
  const now = 1_700_000_000_000;
  const a = expiryFor("money", now);
  const b = expiryFor("money", now);
  assert.equal(a, b);
  assert.ok(!Number.isNaN(Date.parse(a)));
  assert.equal(Date.parse(a), now + 24 * 3600_000);
});

test("expiryFor: deploy expires faster than permission", () => {
  const now = 1_700_000_000_000;
  assert.ok(Date.parse(expiryFor("deploy", now)) < Date.parse(expiryFor("permission", now)));
});

// --- shape / determinism / purity -------------------------------------------

test("qualifiesForInbox is deterministic: same input, same output", () => {
  const input = { kind: "identity", payload: { what: "send email as John" } };
  assert.deepEqual(qualifiesForInbox(input), qualifiesForInbox(input));
});

test("policy module is pure: no I/O imports", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../server/approval-inbox-policy.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /node:(fs|net|http|child_process|worker_threads)/);
  assert.doesNotMatch(src, /\bDate\.now\(\)/); // clock only via injected `now`
});

test("urgencyOf/expiryFor require an injected `now` — no hidden clock", () => {
  assert.throws(() => urgencyOf({ kind: "money", payload: {} }), TypeError);
  assert.throws(() => expiryFor("money"), TypeError);
});

test("exports list the card kinds and the human-only decisions", () => {
  assert.deepEqual([...INBOX_KINDS].sort(), ["deploy", "identity", "money", "other", "permission", "publish"]);
  assert.deepEqual([...DECISIONS].sort(), ["approve", "approve-session", "deny-stop"]);
});
