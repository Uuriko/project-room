/**
 * audit-wave-low-b.test.js — regression tests for LOW wave B findings:
 * L-4 (dm-consents bidirectional revoke), L-5 (ringdetect hop count),
 * L-6 (dispute-arbiters segment-boundary chain overlap), L-7 (health-report
 * NaN scores), L-8 (growth-funnel chronological order / non-negative
 * deltas), L-9 (github-oauth email pagination), L-10 (governance
 * dmConsentRequired honesty), L-16 (migration journal ordering), L-17
 * (morning-digest timestamp canonicalization), L-18 (installer EXIT trap).
 *
 * Each test fails on the pre-fix code for the intended reason and passes
 * after the owner-boundary repair. Run with:
 *   TMPDIR=<worktree>/.tmp node --test tests/audit-wave-low-b.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

import { DmConsents, dmConsentSchema } from "../server/dm-consents.mjs";
import { AUTONOMY_TIERS_SCHEMA } from "../server/autonomy-tiers.mjs";
import { detectRefundLoops } from "../server/emissary-ringdetect.mjs";
import { createArbiters } from "../server/dispute-arbiters.mjs";
import { healthReport, HealthError } from "../server/health-report.mjs";
import { funnelAnalysis } from "../server/growth-funnel.mjs";
import {
  GITHUB_USER_URL, GITHUB_EMAILS_URL,
  fetchGitHubUser,
} from "../server/github-oauth.mjs";
import { governanceObject } from "../server/governance.mjs";
import { verifyMigrations, migrate, MigrationError } from "../server/migrations.mjs";
import { buildMorningDigest } from "../server/morning-digest.mjs";
import { mcpInstallScript } from "../server/mcp-install-script.mjs";

// ---------------------------------------------------------------------------
// L-4: revoke revokes every approved directional row.
// ---------------------------------------------------------------------------

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeDmStore(states) {
  const db = new DatabaseSync(":memory:");
  db.exec(dmConsentSchema);
  db.exec(AUTONOMY_TIERS_SCHEMA);
  return {
    db,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; }
    },
    room(id) {
      const state = states[id];
      return state ? { state } : null;
    }
  };
}

const dmState = () => ({
  room: { id: "r1", title: "Room", purpose: "work", ownerId: "owner", createdAt: 1000 },
  members: {
    owner: member("owner", "Olivia Owner"),
    alice: member("alice", "Alice"),
    bob: member("bob", "Bob"),
  },
  messages: []
});

const errOf = fn => { try { fn(); } catch (e) { return e; } return null; };

test("L-4: revoke revokes both approved directional rows, not just the first", () => {
  const store = makeDmStore({ r1: dmState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob");
  dms.decide("r1", "bob", "alice", "approve");
  dms.request("r1", "bob", "alice");
  dms.decide("r1", "alice", "bob", "approve");
  dms.revoke("r1", "alice", "bob");
  const rows = store.db.prepare("SELECT status FROM dm_consents WHERE room_id = 'r1'").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.status === "revoked"), "both directions revoked");
  // Both directions are now refused; nothing stays silently approved.
  assert.equal(errOf(() => dms.requireDmAllowed("r1", "alice", "bob")).code, "dm_consent_required");
  assert.equal(errOf(() => dms.requireDmAllowed("r1", "bob", "alice")).code, "dm_consent_required");
});

// ---------------------------------------------------------------------------
// L-5: refund-loop hops count edges.
// ---------------------------------------------------------------------------

test("L-5: refund-loop hops count edges (triangle = 3 hops, self-loop = 1)", () => {
  const loops = detectRefundLoops([
    { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" },
    { from: "s", to: "s" },
  ], { maxHops: 4 });
  const tri = loops.find(l => l.hub === "a");
  assert.ok(tri, "triangle found");
  assert.deepEqual(tri.path, ["a", "b", "c", "a"]);
  assert.equal(tri.hops, 3, "a 3-edge cycle reports 3 hops");
  const self = loops.find(l => l.hub === "s");
  assert.ok(self, "self-loop found");
  assert.deepEqual(self.path, ["s", "s"]);
  assert.equal(self.hops, 1, "a self-loop is 1 hop");
});

// ---------------------------------------------------------------------------
// L-6: delegated-chain overlap is segment-boundary, not substring.
// ---------------------------------------------------------------------------

test("L-6: 'agent1' does not disqualify 'agent12'; true chain overlap still does", () => {
  const arbiters = createArbiters();
  const seat = (verifier, executor) => arbiters.resolveTier1({
    verifierId: verifier.lane, executor, lanes: [verifier],
  });
  // Substring false positive: agent1 vs agent12 share no delegation segment.
  const ok = seat(
    { lane: "agent1", delegatedChain: "agent1" },
    { lane: "agent12", delegatedChain: "agent12" },
  );
  assert.equal(ok.tier, 1, "independent verifier seats");
  // Genuine overlap: john>quill>codex shares segments with john>quill.
  const blocked = seat(
    { lane: "codex", delegatedChain: "john>quill>codex" },
    { lane: "quill", delegatedChain: "john>quill" },
  );
  assert.equal(blocked.unavailable, "no-arbitrator");
  assert.match(blocked.reason, /delegated chain overlap/);
});

// ---------------------------------------------------------------------------
// L-7: health scores reject non-numeric inputs instead of scoring NaN.
// ---------------------------------------------------------------------------

test("L-7: healthReport throws HealthError on non-numeric stats (no NaN scores)", () => {
  const rooms = [{ roomId: "r1", stats: { messages: undefined, reactions: 1, activeUsers: 2, workItems: 0, joins: 0 } }];
  assert.throws(() => healthReport({ rooms, weekEnding: "2026-09-30" }),
    err => err instanceof HealthError && err.code === "invalid_health");
  const nanRooms = [{ roomId: "r1", stats: { messages: NaN, reactions: 1, activeUsers: 2, workItems: 0, joins: 0 } }];
  assert.throws(() => healthReport({ rooms: nanRooms, weekEnding: "2026-09-30" }),
    err => err instanceof HealthError);
  // Valid input still scores.
  const good = healthReport({
    rooms: [{ roomId: "r1", stats: { messages: 50, reactions: 10, activeUsers: 5, workItems: 3, joins: 2 } }],
    weekEnding: "2026-09-30",
  });
  assert.ok(Number.isFinite(good.rooms[0].score));
});

// ---------------------------------------------------------------------------
// L-8: funnel is chronological and second-contribution deltas are honest.
// ---------------------------------------------------------------------------

const funnelEvents = (ordered = true) => {
  const ev = [
    { type: "member.invited", actorId: "a", at: "2026-09-01T00:00:00.000Z" },
    { type: "member.joined", actorId: "a", at: "2026-09-01T01:00:00.000Z" },
    { type: "work.claim", actorId: "a", at: "2026-09-01T02:00:00.000Z" },
    { type: "work.completed", actorId: "a", at: "2026-09-01T04:00:00.000Z" },
    { type: "work.claim", actorId: "a", at: "2026-09-01T05:00:00.000Z" },
  ];
  return ordered ? ev : [...ev].reverse();
};

test("L-8: funnel is order-independent and completed-to-second is non-negative", () => {
  const ordered = funnelAnalysis(funnelEvents(true));
  const shuffled = funnelAnalysis(funnelEvents(false));
  assert.deepEqual(
    { ...ordered, agents: undefined }, { ...shuffled, agents: undefined },
    "encounter order does not change the analysis");
  assert.equal(ordered.secondContribution, 1);
  assert.equal(ordered.medianCompletedToSecondMs, 3600000);
  // A second contribution that precedes completion is not a post-completion
  // return: no negative delta, and the agent is not counted as returned.
  const early = funnelAnalysis([
    { type: "member.joined", actorId: "b", at: "2026-09-01T01:00:00.000Z" },
    { type: "work.claim", actorId: "b", at: "2026-09-01T02:00:00.000Z" },
    { type: "work.claim", actorId: "b", at: "2026-09-01T03:00:00.000Z" },
    { type: "work.completed", actorId: "b", at: "2026-09-01T04:00:00.000Z" },
  ]);
  assert.equal(early.secondContribution, 0, "pre-completion second work is not a return");
  assert.equal(early.medianCompletedToSecondMs, null);
});

// ---------------------------------------------------------------------------
// L-9: /user/emails pagination follows Link rel="next".
// ---------------------------------------------------------------------------

const jsonResponse = (data, link = null) => new Response(JSON.stringify(data), {
  status: 200,
  headers: { "content-type": "application/json", ...(link ? { link } : {}) },
});

test("L-9: email pagination follows same-origin Link rel=next, ignores off-origin", async () => {
  const calls = [];
  const fetchFn = async url => {
    calls.push(url);
    if (url === GITHUB_USER_URL) return jsonResponse({ id: 424242, login: "octofixture" });
    if (url === GITHUB_EMAILS_URL)
      return jsonResponse(
        [{ email: "other@example.com", primary: false, verified: true }],
        `<${GITHUB_EMAILS_URL}?page=2>; rel="next"`);
    if (url === `${GITHUB_EMAILS_URL}?page=2`)
      return jsonResponse(
        [{ email: "page2@example.com", primary: true, verified: true }],
        `<https://evil.example/emails>; rel="next"`);
    return new Response("missing", { status: 404 });
  };
  const user = await fetchGitHubUser("token-abc", fetchFn);
  assert.equal(user.email, "page2@example.com");
  assert.ok(calls.includes(`${GITHUB_EMAILS_URL}?page=2`), "second page was fetched");
  assert.ok(!calls.includes("https://evil.example/emails"), "off-origin Link never followed");
});

// ---------------------------------------------------------------------------
// L-10: governance publishes the real (default-open) DM consent posture.
// ---------------------------------------------------------------------------

test("L-10: governance publishes dmConsentRequired: false (default-open)", () => {
  const gov = governanceObject({ origin: "https://room.example" });
  assert.equal(gov.communications.outboundContactPolicy.dmConsentRequired, false);
});

// ---------------------------------------------------------------------------
// L-16: migration journal ordering is verified.
// ---------------------------------------------------------------------------

const mig = (version, name = `m${version}`) => ({
  version, name,
  checksum: "a".repeat(64),
  up: () => {}, down: () => {},
});

test("L-16: verifyMigrations rejects an out-of-order journal", () => {
  const migrations = [mig(1), mig(2), mig(3)];
  const journal = [
    { version: 1, name: "m1", checksum: "a".repeat(64) },
    { version: 3, name: "m3", checksum: "a".repeat(64) },
    { version: 2, name: "m2", checksum: "a".repeat(64) },
  ];
  assert.throws(() => verifyMigrations(migrations, journal),
    err => err instanceof MigrationError && /out of order/.test(err.message));
  // An ordered journal still verifies and migrates.
  const ordered = [
    { version: 1, name: "m1", checksum: "a".repeat(64) },
    { version: 2, name: "m2", checksum: "a".repeat(64) },
  ];
  assert.doesNotThrow(() => verifyMigrations(migrations, ordered));
  const applied = [];
  const result = migrate(migrations, [...ordered], { touched: applied });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].version, 3);
});

// ---------------------------------------------------------------------------
// L-17: morning digest canonicalizes timestamps before comparing/sorting.
// ---------------------------------------------------------------------------

const arrival = (overrides = {}) => ({
  id: "a1", channel: "telegram", threadId: "t1", senderId: "s1",
  subject: "Hello", occurredAt: "2026-09-30T10:00:00.000Z", ...overrides,
});

test("L-17: mixed-format timestamps sort chronologically, not lexicographically", () => {
  // "2026-09-30T09:30:00+02:00" is 07:30Z — chronologically EARLIER than
  // 09:00Z — but sorts LATER as a raw string ("09:30" > "09:00").
  const digest = buildMorningDigest({
    arrivals: [
      arrival({ id: "offset-string", threadId: "t1", occurredAt: "2026-09-30T09:30:00+02:00" }),
      arrival({ id: "utc-iso", threadId: "t2", occurredAt: "2026-09-30T09:00:00.000Z" }),
    ],
    since: "2026-09-29T00:00:00.000Z",
    date: "2026-09-30",
  });
  const threads = digest.channels[0].senderGroups.flatMap(g => g.threads);
  // Newest first: 09:00Z beats 07:30Z.
  assert.equal(threads[0].sourceIds[0], "utc-iso");
  assert.equal(threads[1].sourceIds[0], "offset-string");
});

// ---------------------------------------------------------------------------
// L-18: the installer runs node as a child so the EXIT trap cleans up.
// ---------------------------------------------------------------------------

test("L-18: generated installer has no exec before node (EXIT trap cleans up)", t => {
  const dir = mkdtempSync(join(tmpdir(), "lowb-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const dl = join(dir, "dl");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dl, { recursive: true });
  // Fake node: -p reports a modern version; otherwise exits 0.
  writeFileSync(join(bin, "node"), "#!/bin/sh\nif [ \"$1\" = \"-p\" ]; then echo 20; exit 0; fi\nexit 0\n", { mode: 0o755 });
  // Fake curl: honors -o <file>, writing a trivial init script.
  writeFileSync(join(bin, "curl"),
    "#!/bin/sh\nout=\"\"\nwhile [ $# -gt 0 ]; do case \"$1\" in -o) out=\"$2\"; shift 2;; *) shift;; esac; done\necho 'console.log(\"init\");' > \"$out\"\n",
    { mode: 0o755 });
  const script = mcpInstallScript({ host: "https://room.example" });
  assert.ok(!/^\s*exec node /m.test(script), "no exec before node: the EXIT trap must run");
  assert.match(script, /trap cleanup EXIT INT TERM/);
  const scriptPath = join(dir, "install.sh");
  writeFileSync(scriptPath, script);
  const res = spawnSync("sh", [scriptPath], {
    input: "",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: dl },
  });
  assert.equal(res.status, 0, String(res.stderr));
  const leftovers = readdirSync(dl).filter(f => f.startsWith("room-mcp-init."));
  assert.deepEqual(leftovers, [], "the downloaded init script was cleaned up");
});
