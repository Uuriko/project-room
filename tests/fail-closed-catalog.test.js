// Fail-closed catalog (200-hard-tasks #179).
//
// One suite asserting fail-closed behavior on >= 15 cases, each at a real
// module boundary, each naming the contract it guards. Cases were chosen to
// avoid duplicating existing per-module coverage (see the per-case notes);
// the suite's independent value is the single regression net over the
// fail-closed posture: unknown inputs, bad signatures, stale artifacts, and
// expired credentials must refuse, never silently proceed.
//
// (1) Each test names an observable refusal contract. (2) Credible
// regression: a fail-open change (a `|| true`, a swallowed error, a widened
// allowlist) flips the case red. (3) Existing coverage owns the per-module
// happy paths and the already-tested refusals (webhook forged signatures,
// vetting-receipt staleness, invite double-redeem, sign-agent-card key
// mismatch); the cases below are the ones no other test owns.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, args, opts = {}) =>
  execFileSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", ...opts });
const runFails = (script, args, pattern, opts = {}) => {
  let threw = null;
  try { run(script, args, opts); } catch (err) { threw = err; }
  assert.ok(threw, `expected ${script} ${args.join(" ")} to fail`);
  assert.notEqual(threw.status, 0);
  if (pattern) assert.match(String(threw.stderr ?? "") + String(threw.stdout ?? ""), pattern);
  return threw;
};

// --- A. build/deploy supply chain -------------------------------------------
// No other test owns stamp-version's argument validation.

test("fail-closed: stamp-version rejects a --revision that is not a full commit SHA", t => {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "version.mjs");
  writeFileSync(target, 'export const SOURCE_REVISION = "unstamped";\nexport const BUILD_ID = "unstamped";\n');
  runFails("scripts/stamp-version.mjs", ["--revision", "abc123", target], /full commit SHA/);
});

test("fail-closed: stamp-version rejects unknown flags instead of ignoring them", t => {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "version.mjs");
  writeFileSync(target, 'export const SOURCE_REVISION = "unstamped";\n');
  runFails("scripts/stamp-version.mjs", ["--bogus-flag", target], /unknown option/);
});

test("fail-closed: stamp-version refuses a target missing the version constants", t => {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "version.mjs");
  writeFileSync(target, "// no version constants here\n");
  runFails("scripts/stamp-version.mjs",
    ["--revision", "a".repeat(40), target], /version constants not found/);
});

// The pre-upload verifier (task #171) is new; this suite is its primary owner.
test("fail-closed: verify-build-artifacts exits 1 on an unstamped tree", () => {
  const threw = runFails("scripts/verify-build-artifacts.mjs", [], /stamped-revision/);
  const report = JSON.parse(threw.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some(f => f.check === "stamped-revision"));
});

test("fail-closed: verify-build-artifacts exits 1 when the stamped revision is not the checkout HEAD", t => {
  t.after(() => execFileSync("git", ["checkout", "--", "server/version.mjs"], { cwd: ROOT }));
  run("scripts/stamp-version.mjs", ["--revision", "b".repeat(40), "--build-id", "test"]);
  const threw = runFails("scripts/verify-build-artifacts.mjs", [], /does not match build checkout HEAD/);
  const report = JSON.parse(threw.stdout);
  assert.ok(report.failures.some(f => f.check === "stamped-revision"));
});

// --- B. webhook boundaries ----------------------------------------------------

test("fail-closed: webhook verification with an empty secret refuses before the MAC runs", async () => {
  const { verifyWebhook } = await import("../server/github-app/verify.mjs");
  const { createHmac } = await import("node:crypto");
  const body = new TextEncoder().encode('{"zen":"ok"}');
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  const check = await verifyWebhook({ rawBody: body, signature256: sig, secret: "" });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "missing_signature");
});

test("fail-closed: parseEvent with hostile header shapes ignores instead of throwing", async () => {
  const { parseEvent } = await import("../server/github-app/verify.mjs");
  // Note: header *values* are attacker-controlled (strings); the headers
  // *object* itself comes from the HTTP runtime, so only realistic shapes
  // are probed here.
  for (const headers of [null, undefined, 42, { get: "not-a-function" }]) {
    let parsed;
    try { parsed = parseEvent(headers, "{}"); } catch { parsed = { ignored: true, threw: true }; }
    assert.equal(parsed.threw ?? false, false, "must not throw");
    assert.equal(parsed.ignored, true);
  }
});

// --- C. receipts, invites, codes ------------------------------------------------

test("fail-closed: vetting-receipt verification rejects a non-Set replay journal", async () => {
  const { generateReceiptKeyPair, issueVettingReceipt, verifyVettingReceipt } =
    await import("../server/vetting-receipts.mjs");
  const keypair = generateReceiptKeyPair();
  const now = Date.parse("2026-10-06T12:00:00.000Z");
  const receipt = issueVettingReceipt({
    trialTaskId: "t", demigodReqId: "r", candidateId: "agent:x",
    scope: { hoursMax: "1", deliverableShape: "x" },
    rubricScores: [{ criterion: "c", scoreBps: "1" }],
    verdict: "pass", evaluator: { kind: "human", id: "h" },
    issuedAt: new Date(now).toISOString(), receiptId: `vetting-receipt:${"ef".repeat(16)}`, now,
  }, keypair);
  const check = verifyVettingReceipt(receipt, { expectedPubkey: keypair.pubkeyHex, seen: "not-a-set", now });
  assert.equal(check.ok, false);
  assert.match(check.reason, /^invalid_input/);
});

test("fail-closed: referral preview of a token for an unknown room is 404, never 500", async () => {
  const { ReferralInvites, referralInviteSchema } = await import("../server/referral-invites.mjs");
  const db = new DatabaseSync(":memory:");
  db.exec(referralInviteSchema);
  const now = 9_000_000;
  const store = {
    db,
    now: () => now,
    room: () => { throw Object.assign(new Error("no such room"), { status: 404 }); },
    transaction: fn => fn(),
  };
  const invites = new ReferralInvites(store);
  const keys = invites.roomKeys("ghost-room");
  const body = {
    v: 1, jti: "jti-ghost", chainId: "chain-1", roomId: "ghost-room",
    depth: 0, maxDepth: 3, issuedAt: now, expiresAt: now + 3600_000, tier: "chat",
  };
  const token = invites.signToken(body, keys.privateSeed);
  db.prepare(`INSERT INTO referral_invites (jti, room_id, chain_id, inviter_member_id, depth, max_depth,
    created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'minted')`)
    .run("jti-ghost", "ghost-room", "chain-1", "inviter", 0, 3, now, now + 3600_000);
  assert.throws(() => invites.preview(token), err => err.status === 404);
});

test("fail-closed: guest-invite code predicate rejects non-strings without throwing", async () => {
  const { isGuestInviteCode } = await import("../server/guest-invites.mjs");
  for (const bad of [null, undefined, 42, {}, [], ""]) {
    assert.equal(isGuestInviteCode(bad), false);
  }
  assert.equal(isGuestInviteCode("definitely-not-a-code"), false);
});

// --- D. retention boundaries ----------------------------------------------------

test("fail-closed: live-store retention rejects an invalid batch limit", async () => {
  const { runLiveStoreRetention, RetentionRunError } = await import("../server/retention-run.mjs");
  const store = { db: { prepare() { throw new Error("must not query"); } }, transaction: fn => fn() };
  for (const limit of [0, -1, 101, 1.5, NaN]) {
    assert.throws(() => runLiveStoreRetention({ store, limit }),
      err => err instanceof RetentionRunError && /batch limit/.test(err.message));
  }
});

test("fail-closed: live-store retention rejects an invalid table index", async () => {
  const { runLiveStoreRetention, RetentionRunError } = await import("../server/retention-run.mjs");
  const store = { db: { prepare() { throw new Error("must not query"); } }, transaction: fn => fn() };
  for (const tableIndex of [NaN, 1.5, "0"]) {
    assert.throws(() => runLiveStoreRetention({ store, tableIndex }),
      err => err instanceof RetentionRunError && /retention table/.test(err.message));
  }
});

test("fail-closed: deploy-checks refuses to trust a malformed manifest", async () => {
  const { readManifest } = await import("../scripts/deploy-checks.mjs");
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const bad = join(dir, "manifest.json");
  writeFileSync(bad, "{ not json");
  assert.throws(() => readManifest(bad), /not valid JSON/);
  rmSync(dir, { recursive: true, force: true });
  assert.throws(() => readManifest(join(dir, "missing.json")), /not found/);
});

// --- E. webhook delivery journal edges ------------------------------------------

test("fail-closed: delivery journal refuses invalid repos and treats missing journals as stale", async () => {
  const { recordWebhookDelivery, webhookDeliveryStale } = await import("../server/claim-autolink.mjs");
  assert.equal(recordWebhookDelivery(null, "not a repo!!!"), false);
  assert.equal(recordWebhookDelivery(null, ""), false);
  // No journal row: the poll fallback must assume the webhook is not alive.
  assert.equal(webhookDeliveryStale({}, "acme/app"), true);
});

test("fail-closed: retention-plan CLI rejects an out-of-range batch limit", () => {
  runFails("scripts/retention-plan.mjs", ["--db", "x", "--limit", "101"], /--limit must be an integer/);
});
