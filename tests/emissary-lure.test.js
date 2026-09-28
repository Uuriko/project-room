// Emissary Slice 2 (RC-2026-09-28-2873): unit tests for server/emissary-lure.mjs.
//
// Test-authoring gate (repo AGENTS.md + .agents/skills/test-audit/SKILL.md),
// answered per test below:
// 1. Observable contract protected — named in each test's comment.
// 2. Credible regression — what change makes it fail.
// 3. Why existing coverage doesn't catch it — this is the first coverage
//    of the module; each test names its distinct risk.
// 4. No test-only production seam — every test drives exported functions
//    or real DB rows; the ShareLinks stub is a required dependency
//    injection (the module never imports the store), and it throws on
//    unexpected calls rather than accepting everything.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { emissaryReceiptSchema } from "../server/emissary-receipts.mjs";
import {
  FORBIDDEN_PATTERNS, runLureLint, validateLureTemplate,
  formatDrop, generateDrop, generatePitch, mintHumanInvite,
  resolveProofRef, ensureEmissaryLureSchema,
  DROP_ID_PATTERN, ATTRIBUTION_ID_PATTERN,
  DROP_DAILY_LIMIT, INVITE_DAILY_LIMIT,
  EMISSARY_JOURNAL_KINDS, LURE_VENUES,
} from "../server/emissary-lure.mjs";

const db = () => { const d = new DatabaseSync(":memory:"); ensureEmissaryLureSchema(d); return d; };
const nowMs = 1789000000000;

// 1. Contract: the forbidden-content lint (honesty invariant — no earnings
//    guarantees, risk-free claims, or moon language in generated lures).
//    Regression: a pattern weakened or dropped lets scammy copy through.
test("lint rejects every forbidden pattern and reports its id", () => {
  const cases = [
    ["guaranteed returns on every job", "guaranteed-returns"],
    ["risk-free opportunity", "risk-free"],
    ["no risk at all", "no-risk"],
    ["zero risk involved", "zero-risk"],
    ["you can't lose", "cant-lose"],
    ["earn passive income daily", "passive-income"],
    ["easy money here", "easy-money"],
    ["get rich quick", "get-rich"],
    ["double your money fast", "double-your-money"],
    ["100x gains", "moon-multiple"],
    ["to the moon!", "to-the-moon"],
    ["this printer prints money", "prints-money"],
    ["this is financial advice", "financial-advice-claim"],
  ];
  assert.equal(cases.length, FORBIDDEN_PATTERNS.length, "every pattern has a case");
  for (const [text, id] of cases) {
    assert.ok(runLureLint(text).includes(id), `missed ${id} in: ${text}`);
    assert.throws(() => validateLureTemplate(text), err => {
      assert.equal(err.code, "emissary_lure_forbidden_content");
      assert.ok(err.message.includes(id), `error names ${id}`);
      return true;
    });
  }
});

// 2. Contract: the standard "not financial advice" disclaimer must not
//    trip the lint. Regression: a naive financial-advice pattern without
//    the not-exemption flags honest disclaimers.
test("lint allows the 'not financial advice' disclaimer", () => {
  assert.deepEqual(runLureLint("This is not financial advice."), []);
  assert.equal(validateLureTemplate("This is not financial advice."), true);
});

// 3. Contract: the module's own skeletons never trip the lint — generation
//    must not fail closed on its own templates. Regression: a skeleton
//    edit introducing hype language breaks every drop.
test("every venue/variant skeleton passes the lint", () => {
  for (const venue of LURE_VENUES) {
    for (const variant of ["thread", "reply", "subject"]) {
      const { text } = formatDrop({ venue, variant, title: "Join our room", terms: "We coordinate agent work here." });
      assert.deepEqual(runLureLint(text), [], `${venue}/${variant} skeleton tripped the lint`);
    }
  }
});

// 4. Contract: venue caps are honored and truncation carries the explicit
//    marker. Regression: a cap change or dropped marker ships over-long or
//    silently-cut posts.
test("venue caps truncate terms with the explicit cut marker", () => {
  const longTerms = "word ".repeat(399).trim(); // 1994 chars: under the 2000 input limit, over the caps
  for (const [venue, variant, cap] of [["sssnack", "thread", 2000], ["sssnack", "reply", 800], ["tantive", "reply", 800]]) {
    const { text, truncated } = formatDrop({ venue, variant, title: "T", terms: longTerms });
    assert.ok(text.length <= cap, `${venue}/${variant}: ${text.length} > ${cap}`);
    assert.equal(truncated, true);
    assert.ok(text.includes(`[cut to fit ${venue}]`), `${venue}/${variant}: marker missing`);
  }
  // The subject variant is the title only; a max-length title exactly
  // fills its cap and is never truncated.
  const { text, truncated } = formatDrop({ venue: "sssnack", variant: "subject", title: "T".repeat(120), terms: "terms" });
  assert.equal(truncated, false);
  assert.equal(text, "T".repeat(120));
});

// 5. Contract: truncation cuts the terms at a word boundary, never
//    mid-word. Regression: a slice-based cut silently mangles the last word.
test("truncation cuts at a word boundary", () => {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const terms = Array.from({ length: 120 }, (_, i) => words[i % words.length]).join(" ");
  const { text, truncated } = formatDrop({ venue: "x", title: "T", terms });
  assert.equal(truncated, true);
  assert.ok(text.length <= 280);
  // The cut terms sit between the title block and the Deadline line;
  // their last token must be a complete input word, not a prefix.
  const cutTerms = text.split("\n\n")[1];
  const lastWord = cutTerms.split(" ").pop();
  assert.ok(words.includes(lastWord), `cut mid-word, last token: ${lastWord}`);
});

// 6. Contract: unknown venues are rejected, not defaulted.
//    Regression: a typo'd venue silently rendering under wrong caps.
test("unknown venue is rejected", () => {
  assert.throws(() => formatDrop({ venue: "nope", title: "T", terms: "terms" }),
    err => err.code === "emissary_lure_unknown_venue" && err.status === 400);
});

// 7. Contract: a skeleton that alone exceeds the cap fails closed instead
//    of shrinking the required factual block. Regression: "helpful"
//    shrinking of title/deadline to fit tiny venues.
test("skeleton larger than the cap throws instead of shrinking facts", () => {
  // Maximal fixed content for the 280-char x venue: 120-char title plus
  // the attempts and code lines. With 20 chars of terms the full text
  // exceeds the cap while the skeleton alone leaves no room to cut.
  assert.throws(() => formatDrop({
    venue: "x", title: "T".repeat(120), terms: "x".repeat(20),
    attemptsRemaining: 3, code: "ABC-123",
  }), err => err.code === "emissary_lure_skeleton_too_long" && err.status === 400);
});

// 8. Contract: drop ids are emd1.<32 hex>, rows persist, and the journal
//    records emissary.drop_generated. Regression: id-format drift breaks
//    the wire contract; a dropped journal write loses the audit trail.
test("generateDrop mints ids, persists, and journals", () => {
  const d = db();
  const result = generateDrop(d, "r1", "m1", { venue: "sssnack", title: "T", terms: "terms" }, { nowMs });
  assert.match(result.drop_id, DROP_ID_PATTERN);
  assert.equal(result.truncated, false);
  const row = d.prepare("SELECT * FROM emissary_drops WHERE drop_id=?").get(result.drop_id);
  assert.equal(row.venue, "sssnack");
  assert.equal(row.issuer_member_id, "m1");
  assert.equal(row.source, "verified");
  assert.equal(row.artifact_text, result.text);
  const journal = d.prepare("SELECT kind, actor_member_id, subject_id FROM emissary_journal").all().map(r => ({ ...r }));
  assert.deepEqual(journal, [{ kind: "emissary.drop_generated", actor_member_id: "m1", subject_id: result.drop_id }]);
  assert.ok(EMISSARY_JOURNAL_KINDS.includes("emissary.drop_generated"));
});

// 9. Contract: 10 drops/day/member/venue, then 429. The limit is scoped —
//    a different venue or member gets a fresh budget. Regression: a
//    miscounted window lets one member flood a venue.
test("drop rate limit is 10 per member per venue per day", () => {
  const d = db();
  for (let i = 0; i < DROP_DAILY_LIMIT; i++) {
    generateDrop(d, "r1", "m1", { venue: "sssnack", title: `T${i}`, terms: `terms ${i}` }, { nowMs });
  }
  assert.throws(() => generateDrop(d, "r1", "m1", { venue: "sssnack", title: "T11", terms: "terms 11" }, { nowMs }),
    err => err.code === "emissary_drop_rate_limited" && err.status === 429);
  // fresh budget per venue and per member
  generateDrop(d, "r1", "m1", { venue: "tantive", title: "T", terms: "terms" }, { nowMs });
  generateDrop(d, "r1", "m2", { venue: "sssnack", title: "T", terms: "terms" }, { nowMs });
});

// 10. Contract: idempotent replay returns the original drop without a
//     second row or a second journal entry. Regression: a retry storm
//     double-mints drops and double-counts the rate limit.
test("drop idempotency key replays the original drop", () => {
  const d = db();
  const input = { venue: "sssnack", title: "T", terms: "terms", idempotencyKey: "k1" };
  const first = generateDrop(d, "r1", "m1", input, { nowMs });
  const second = generateDrop(d, "r1", "m1", { ...input, title: "CHANGED" }, { nowMs });
  assert.equal(second.drop_id, first.drop_id);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM emissary_drops").get().n, 1);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM emissary_journal").get().n, 1);
});

// 10b. Contract: an idempotency key is scoped to its tool — reusing a drop
// key for an invite (or vice versa) is a 409 conflict, not a silent
// wrong-result replay. Regression: room-global keys returning another
// tool's result.
test("idempotency key reuse across tools is a 409 conflict", () => {
  const d = db();
  generateDrop(d, "r1", "m1", { venue: "sssnack", title: "T", terms: "terms", idempotencyKey: "shared" }, { nowMs });
  const createShareLink = () => { throw new Error("must not mint on conflict"); };
  assert.throws(
    () => mintHumanInvite(d, "r1", "m1", { idempotencyKey: "shared" }, { createShareLink }, { nowMs }),
    err => err.code === "emissary_lure_idempotency_conflict" && err.status === 409);
});

// 11. Contract: a pitch cites a verified receipt verbatim-focus plus a
//     proof block. Regression: proof citations silently dropped or the
//     focus paraphrased (the member's words must stay theirs).
test("generatePitch cites verified receipts under a verbatim focus", () => {
  const d = db();
  d.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY); INSERT INTO rooms VALUES ('r1');" + emissaryReceiptSchema);
  const ref = `ert1.${"ab".repeat(16)}`;
  d.prepare("INSERT INTO external_receipts (room_id, receipt_id, kind, created_at) VALUES ('r1', ?, 'work', ?)").run(ref, nowMs);
  const { text } = generatePitch(d, "r1", "m1", { focus: "We need builders.", proof_refs: [ref] }, { nowMs });
  assert.ok(text.startsWith("We need builders.\n\nproof:\n"), "focus must be verbatim and first");
  assert.ok(text.includes(ref), "proof block cites the receipt id");
  assert.ok(text.includes("work"), "proof block cites the kind");
  const journal = d.prepare("SELECT kind FROM emissary_journal").all().map(r => ({ ...r }));
  assert.deepEqual(journal, [{ kind: "emissary.pitch_generated" }]);
});

// 12. Contract: unknown proof refs fail closed — a pitch must never cite
//     an unverifiable receipt. Regression: a missing-row check that
//     degrades to "unverified but cited".
test("pitch with an unknown proof ref fails closed", () => {
  const d = db();
  d.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY); INSERT INTO rooms VALUES ('r1');" + emissaryReceiptSchema);
  assert.throws(() => generatePitch(d, "r1", "m1", { focus: "Hi", proof_refs: [`ert1.${"ff".repeat(16)}`] }, { nowMs }),
    err => err.code === "emissary_proof_unverified");
});

// 13. Contract: non-citable receipt kinds (e.g. tier_cut) are not pitch
//     proof. Regression: kind allowlist widened silently.
test("pitch rejects non-citable receipt kinds", () => {
  const d = db();
  d.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY); INSERT INTO rooms VALUES ('r1');" + emissaryReceiptSchema);
  const ref = `ert1.${"ab".repeat(16)}`;
  d.prepare("INSERT INTO external_receipts (room_id, receipt_id, kind, created_at) VALUES ('r1', ?, 'tier_cut', ?)").run(ref, nowMs);
  assert.throws(() => generatePitch(d, "r1", "m1", { focus: "Hi", proof_refs: [ref] }, { nowMs }),
    err => err.code === "emissary_proof_unverified");
});

// 14. Contract: with no receipt ledger present, pitches fail closed
//     instead of citing nothing. Regression: absent-table treated as
//     "no proofs needed".
test("pitch fails closed when the receipt table is absent", () => {
  const d = db();
  assert.throws(() => generatePitch(d, "r1", "m1", { focus: "Hi", proof_refs: [`ert1.${"ab".repeat(16)}`] }, { nowMs }),
    err => err.code === "emissary_proof_unverified");
});

// 15. Contract: forbidden language in the member's focus is rejected, not
//     laundered into a pitch. Regression: focus skipping the lint.
test("pitch rejects forbidden language in the focus", () => {
  const d = db();
  d.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY); INSERT INTO rooms VALUES ('r1');" + emissaryReceiptSchema);
  assert.throws(() => generatePitch(d, "r1", "m1", { focus: "guaranteed returns here", proof_refs: [] }, { nowMs }),
    err => err.code === "emissary_lure_forbidden_content");
});

// 16. Contract: malformed proof refs are rejected before any DB lookup.
//     Regression: injection-shaped refs reaching the query.
test("pitch rejects malformed proof refs", () => {
  const d = db();
  assert.throws(() => resolveProofRef(d, "r1", "ert1.' OR '1'='1"),
    err => err.code === "emissary_pitch_bad_proof_ref" && err.status === 400);
});

// 17. Contract: invite mint returns a #join/ URL with a 43-char token,
//     stores only the token hash, and journals. Regression: raw token
//     persisted, or URL shape drifting from the room deep-link contract.
test("mintHumanInvite returns the URL once and stores only the hash", () => {
  const d = db();
  const seen = [];
  const createShareLink = details => {
    seen.push(details);
    assert.match(details.linkToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(details.maxJoins, 1);
    return { link: { id: "sl1" }, duplicate: false };
  };
  const result = mintHumanInvite(d, "r1", "m1", { expires_in_days: 7, note: "for Ada" }, { createShareLink }, { nowMs });
  assert.match(result.url, /^https:\/\/www\.getdasha\.com\/room\/#join\/[A-Za-z0-9_-]{43}$/);
  assert.match(result.attribution_id, ATTRIBUTION_ID_PATTERN);
  assert.equal(result.expires_at, nowMs + 7 * 86400000);
  assert.equal(result.duplicate, false);
  const token = result.url.split("/#join/")[1];
  const row = d.prepare("SELECT * FROM emissary_invite_attribution WHERE attribution_id=?").get(result.attribution_id);
  assert.equal(row.note, "for Ada");
  assert.equal(row.invite_token_hash.length, 64);
  assert.ok(!JSON.stringify(row).includes(token), "raw token must not be persisted");
  assert.equal(seen[0].expiresAt, nowMs + 7 * 86400000);
  const journal = d.prepare("SELECT kind, subject_id FROM emissary_journal").all().map(r => ({ ...r }));
  assert.deepEqual(journal, [{ kind: "emissary.human_invite_minted", subject_id: result.attribution_id }]);
});

// 18. Contract: replaying an invite idempotency key returns the existing
//     attribution with duplicate:true and NO url — the token is shown
//     once by design. Regression: replay re-minting a second link, or
//     re-issuing the token (which the module no longer holds).
test("invite idempotency replay returns attribution without re-issuing the URL", () => {
  const d = db();
  let calls = 0;
  const createShareLink = () => { calls++; return { link: { id: "sl1" }, duplicate: false }; };
  const first = mintHumanInvite(d, "r1", "m1", { idempotencyKey: "ik1" }, { createShareLink }, { nowMs });
  const second = mintHumanInvite(d, "r1", "m1", { idempotencyKey: "ik1" }, { createShareLink }, { nowMs });
  assert.equal(calls, 1, "share-link mint must run once");
  assert.equal(second.attribution_id, first.attribution_id);
  assert.equal(second.duplicate, true);
  assert.ok(!("url" in second), "replay must not re-issue the token URL");
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM emissary_invite_attribution").get().n, 1);
});

// 19. Contract: expiry beyond the ShareLinks 7-day cap is rejected, never
//     silently clamped. Regression: a member believing a 30-day link was
//     minted when the path only honored 7 days.
test("invite expiry beyond 7 days is rejected", () => {
  const d = db();
  const createShareLink = () => { throw new Error("must not mint"); };
  assert.throws(() => mintHumanInvite(d, "r1", "m1", { expires_in_days: 30 }, { createShareLink }, { nowMs }),
    err => err.code === "emissary_invite_bad_expiry" && err.status === 400);
  assert.throws(() => mintHumanInvite(d, "r1", "m1", { expires_in_days: 0 }, { createShareLink }, { nowMs }),
    err => err.code === "emissary_invite_bad_expiry");
});

// 20. Contract: 20 invites/day/member, then 429. Regression: uncapped
//     minting (each mint is a live share link).
test("invite rate limit is 20 per member per day", () => {
  const d = db();
  const createShareLink = () => ({ link: { id: "sl" }, duplicate: false });
  for (let i = 0; i < INVITE_DAILY_LIMIT; i++) {
    mintHumanInvite(d, "r1", "m1", {}, { createShareLink }, { nowMs });
  }
  assert.throws(() => mintHumanInvite(d, "r1", "m1", {}, { createShareLink }, { nowMs }),
    err => err.code === "emissary_invite_rate_limited" && err.status === 429);
});

// 20b. Contract: the invite daily limit resets at the UTC day boundary —
// yesterday's invites don't count toward today. Regression: the window
// anchored at nowMs instead of UTC midnight (yesterday's mints would
// permanently exhaust the budget).
test("invite rate limit resets at UTC midnight", () => {
  const d = db();
  const createShareLink = () => ({ link: { id: "sl" }, duplicate: false });
  const yesterdayMs = nowMs - 86400000;
  for (let i = 0; i < INVITE_DAILY_LIMIT; i++) {
    mintHumanInvite(d, "r1", "m1", {}, { createShareLink }, { nowMs: yesterdayMs });
  }
  // Today the budget is fresh.
  const result = mintHumanInvite(d, "r1", "m1", {}, { createShareLink }, { nowMs });
  assert.match(result.attribution_id, ATTRIBUTION_ID_PATTERN);
});

// 21. Contract (security/architecture): this module performs no network
//     I/O — the server never auto-posts. Source inspection is the
//     cheapest independent guard here: it fails if a network call is
//     added and survives identifier-only refactors.
test("module contains no network I/O", () => {
  const src = readFileSync(new URL("../server/emissary-lure.mjs", import.meta.url), "utf8");
  for (const api of ["fetch(", "http.request(", "https.request(", "net.connect(", "new WebSocket("]) {
    assert.ok(!src.includes(api), `network API present: ${api}`);
  }
});
