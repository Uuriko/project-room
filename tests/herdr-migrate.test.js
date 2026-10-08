// tests/herdr-migrate.test.js — fail-first tests for scripts/herdr-migrate.mjs
// (B20 migration/rollout tooling, D5 migration-rollout.md §5).
//
// Pure core is imported from the script; no network, no repo server boot.
// TMPDIR-backed journal paths only.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseArgs,
  parseFlagValue,
  effectiveFlagForRoom,
  resolveOptinMarker,
  hasOpenChangesRequested,
  fileLeaseConflicts,
  classifyClaim,
  idempotencyKey,
  isTerminalKind,
  findTerminalEntry,
  buildPlan,
  batchPlan,
  deriveExitCode,
  appendJournalEntry,
  readJournal,
  buildScanReport,
  renderHonestSummary,
  detectOrphans,
  aggregateDrainStatus,
  planReverse,
  linkedClaimIds,
  EXIT_OK,
  EXIT_PARTIAL,
  EXIT_SYSTEMIC,
} from "../scripts/herdr-migrate.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "herdr-migrate-test-"));

const liveClaim = (over = {}) => ({
  id: "clm_1",
  title: "t",
  state: "in_progress",
  owner: "jillian",
  claimedAt: "2026-10-06T10:00:00Z",
  leaseStartAt: "2026-10-06T10:00:00Z",
  leaseExpiresAt: "2026-10-08T10:00:00Z",
  files: [],
  reviews: [],
  ...over,
});

const ctx = (over = {}) => ({
  flagCoversRoom: true,
  optin: { backend: "herdr", source: "markers-file" },
  bridge: { status: "ok" },
  bridgeRequired: false,
  hostClass: "claude-code",
  hostClassInputProvided: false,
  allClaims: [],
  nowMs: Date.parse("2026-10-06T12:00:00Z"),
  ...over,
});

// ---- parseArgs -----------------------------------------------------------

test("parseArgs: unknown command is an error", () => {
  const r = parseArgs(["frobnicate"]);
  assert.ok(r.errors.length > 0);
});

test("parseArgs: missing command is an error", () => {
  const r = parseArgs(["--json"]);
  assert.ok(r.errors.length > 0);
});

test("parseArgs: --room is repeatable; --dry-run defaults true", () => {
  const r = parseArgs(["scan", "--room", "a", "--room", "b"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.command, "scan");
  assert.deepEqual(r.flags.room, ["a", "b"]);
  assert.equal(r.flags.dryRun, true);
  assert.equal(r.flags.execute, false);
});

test("parseArgs: --execute flips dry-run off", () => {
  const r = parseArgs(["migrate", "--room", "a", "--execute"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.flags.execute, true);
  assert.equal(r.flags.dryRun, false);
});

test("parseArgs: --batch parses, invalid --batch is an error", () => {
  assert.equal(parseArgs(["migrate", "--batch", "7"]).flags.batch, 7);
  assert.ok(parseArgs(["migrate", "--batch", "nope"]).errors.length > 0);
  assert.ok(parseArgs(["migrate", "--batch", "0"]).errors.length > 0);
});

test("parseArgs: unknown flag is an error", () => {
  assert.ok(parseArgs(["scan", "--bogus"]).errors.length > 0);
});

test("parseArgs: --claim/--confirm/--reason/--resume/--limit/--json parse", () => {
  const r = parseArgs(["force-release", "--room", "a", "--claim", "c1", "--execute", "--confirm", "--reason", "stuck pane"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.flags.claim, "c1");
  assert.equal(r.flags.confirm, true);
  assert.equal(r.flags.reason, "stuck pane");
  const r2 = parseArgs(["migrate", "--resume", "--limit", "3", "--json"]);
  assert.equal(r2.flags.resume, true);
  assert.equal(r2.flags.limit, 3);
  assert.equal(r2.flags.json, true);
});

// ---- flag parsing --------------------------------------------------------

test("parseFlagValue: off grammar", () => {
  assert.deepEqual(parseFlagValue("off"), { mode: "off", rooms: [] });
  assert.deepEqual(parseFlagValue(""), { mode: "off", rooms: [] });
  assert.deepEqual(parseFlagValue(undefined), { mode: "off", rooms: [] });
});

test("parseFlagValue: on grammar", () => {
  assert.deepEqual(parseFlagValue("on"), { mode: "on", rooms: [] });
});

test("parseFlagValue: bare room list grammar (compat-plan: ROOM_HERDR_SESSIONS=<roomId,...>)", () => {
  assert.deepEqual(parseFlagValue("muse-room,ops-room"), { mode: "rooms", rooms: ["muse-room", "ops-room"] });
  assert.deepEqual(parseFlagValue(" muse-room "), { mode: "rooms", rooms: ["muse-room"] });
});

test("parseFlagValue: trailing comma / empty entry is invalid", () => {
  assert.throws(() => parseFlagValue("muse-room,"), /invalid_flag_value/);
  assert.throws(() => parseFlagValue("room:x"), /invalid_flag_value/);
});

test("effectiveFlagForRoom", () => {
  assert.equal(effectiveFlagForRoom(parseFlagValue("on"), "any"), true);
  assert.equal(effectiveFlagForRoom(parseFlagValue("off"), "any"), false);
  assert.equal(effectiveFlagForRoom(parseFlagValue("a,b"), "b"), true);
  assert.equal(effectiveFlagForRoom(parseFlagValue("a,b"), "c"), false);
});

// ---- opt-in markers ------------------------------------------------------

test("resolveOptinMarker: claim field wins, then markers file, else unknown (never guessed)", () => {
  const markers = { "muse-room": { jillian: "herdr" } };
  assert.deepEqual(
    resolveOptinMarker({ id: "x", sessionBackend: "legacy" }, markers).backend,
    "legacy",
  );
  assert.equal(resolveOptinMarker({ id: "x", sessionBackend: "legacy" }, markers).source, "claim-field");
  const r = resolveOptinMarker({ id: "x" }, markers);
  // member lookup needs room+member; script passes a per-room view
  assert.equal(r.source, "unknown");
  const r2 = resolveOptinMarker({ id: "x", owner: "jillian" }, { jillian: "herdr" });
  assert.equal(r2.backend, "herdr");
  assert.equal(r2.source, "markers-file");
});

// ---- reviews -------------------------------------------------------------

test("hasOpenChangesRequested: latest verdict per member wins; comments ignored", () => {
  const reviews = [
    { memberId: "a", verdict: "changes_requested", at: "2026-10-06T10:00:00Z" },
    { memberId: "a", verdict: "approve", at: "2026-10-06T11:00:00Z" },
    { memberId: "b", verdict: "comment", at: "2026-10-06T12:00:00Z" },
  ];
  assert.equal(hasOpenChangesRequested(reviews), false);
  assert.equal(
    hasOpenChangesRequested([{ memberId: "a", verdict: "changes_requested", at: "2026-10-06T10:00:00Z" }]),
    true,
  );
  assert.equal(hasOpenChangesRequested([]), false);
  assert.equal(hasOpenChangesRequested(undefined), false);
});

// ---- file leases ---------------------------------------------------------

test("fileLeaseConflicts: mirrors server semantics (path match, block match)", () => {
  const a = liveClaim({ id: "a", owner: "x", files: ["server/a.mjs"] });
  const b = liveClaim({ id: "b", owner: "y", files: ["server/a.mjs"] });
  const c = liveClaim({ id: "c", owner: "z", files: ["server/other.mjs"] });
  assert.equal(fileLeaseConflicts([a, b, c], a).length, 1);
  assert.equal(fileLeaseConflicts([a, b, c], a)[0].holder.claimId, "b");
  assert.equal(fileLeaseConflicts([a, c], a).length, 0);
  // different blocks on the same path do not conflict
  const d = liveClaim({ id: "d", owner: "y", files: ["server/a.mjs"], fileBlocks: { "server/a.mjs": "b1" } });
  const e = liveClaim({ id: "e", owner: "x", files: ["server/a.mjs"], fileBlocks: { "server/a.mjs": "b2" } });
  assert.equal(fileLeaseConflicts([d, e], d).length, 0);
  // terminal claims never conflict; self never conflicts
  const t = liveClaim({ id: "t", owner: "y", state: "done", files: ["server/a.mjs"] });
  assert.equal(fileLeaseConflicts([a, t], a).length, 0);
  assert.equal(fileLeaseConflicts([a], a).length, 0);
});

// ---- classifyClaim -------------------------------------------------------

test("classifyClaim: happy path is eligible with all checks recorded", () => {
  const r = classifyClaim(liveClaim(), ctx());
  assert.equal(r.eligible, true);
  assert.equal(r.reason, null);
  assert.equal(r.checks.state, "live");
  assert.equal(r.checks.lease, "valid");
  assert.equal(r.checks.optin, "herdr (markers-file)");
  assert.equal(r.checks.flag, "covers");
  assert.equal(r.checks.bridge, "ok");
});

test("classifyClaim: terminal and non-live states", () => {
  assert.equal(classifyClaim(liveClaim({ state: "done" }), ctx()).reason, "claim_terminal");
  assert.equal(classifyClaim(liveClaim({ state: "failed" }), ctx()).reason, "claim_terminal");
  const r = classifyClaim(liveClaim({ state: "unclaimed" }), ctx());
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "claim_not_live");
});

test("classifyClaim: expired lease is skipped; null lease never expires", () => {
  const r = classifyClaim(liveClaim({ leaseExpiresAt: "2026-10-05T10:00:00Z" }), ctx());
  assert.equal(r.reason, "lease_expired");
  const ok = classifyClaim(liveClaim({ leaseExpiresAt: null }), ctx());
  assert.equal(ok.eligible, true);
});

test("classifyClaim: already-herdr (session link exists) and not-opted-in", () => {
  assert.equal(
    classifyClaim(liveClaim(), ctx({ existingHerdrSession: true })).reason,
    "already_herdr",
  );
  // opt-in marker "herdr" on the claim is lane INTENT, not migration state —
  // it makes the claim eligible, it does not mark it already-herdr.
  assert.equal(classifyClaim(liveClaim(), ctx()).eligible, true);
  const r = classifyClaim(liveClaim(), ctx({ optin: { backend: null, source: "unknown" } }));
  assert.equal(r.reason, "not_opted_in");
  const legacy = classifyClaim(liveClaim(), ctx({ optin: { backend: "legacy", source: "markers-file" } }));
  assert.equal(legacy.reason, "not_opted_in");
});

test("classifyClaim: room outside flag scope", () => {
  const r = classifyClaim(liveClaim(), ctx({ flagCoversRoom: false }));
  assert.equal(r.reason, "room_not_in_flag_scope");
});

test("classifyClaim: bridge checks — execute mode fails closed, scan mode marks unchecked", () => {
  const exec = { bridgeRequired: true };
  assert.equal(classifyClaim(liveClaim(), ctx({ ...exec, bridge: { status: "version_mismatch", detail: "pinned=22 server=21" } })).reason, "bridge_version_mismatch");
  assert.equal(classifyClaim(liveClaim(), ctx({ ...exec, bridge: { status: "unreachable" } })).reason, "bridge_unreachable");
  const scanMode = classifyClaim(liveClaim(), ctx({ bridge: { status: "not_configured" } }));
  assert.equal(scanMode.eligible, true);
  assert.equal(scanMode.checks.bridge, "unchecked");
  const execMissing = classifyClaim(liveClaim(), ctx({ ...exec, bridge: { status: "not_configured" } }));
  assert.equal(execMissing.reason, "bridge_not_configured");
});

test("classifyClaim: host class — no-herdr classes skip; unknown member skips when input provided", () => {
  assert.equal(
    classifyClaim(liveClaim(), ctx({ hostClass: "paste-relay", hostClassInputProvided: true })).reason,
    "host_class_no_herdr",
  );
  assert.equal(
    classifyClaim(liveClaim(), ctx({ hostClass: "pull-only", hostClassInputProvided: true })).reason,
    "host_class_no_herdr",
  );
  assert.equal(
    classifyClaim(liveClaim(), ctx({ hostClass: null, hostClassInputProvided: true })).reason,
    "host_class_unknown",
  );
  const unchecked = classifyClaim(liveClaim(), ctx({ hostClass: null, hostClassInputProvided: false }));
  assert.equal(unchecked.eligible, true);
  assert.equal(unchecked.checks.hostClass, "unchecked");
});

test("classifyClaim: open CHANGES REQUESTED defers", () => {
  const r = classifyClaim(
    liveClaim({ reviews: [{ memberId: "rev", verdict: "changes_requested", at: "2026-10-06T11:00:00Z" }] }),
    ctx(),
  );
  assert.equal(r.reason, "review_changes_requested");
});

test("classifyClaim: file lease conflict defers", () => {
  const a = liveClaim({ id: "a", files: ["server/x.mjs"] });
  const b = liveClaim({ id: "b", files: ["server/x.mjs"] });
  const r = classifyClaim(a, ctx({ allClaims: [a, b] }));
  assert.equal(r.reason, "file_lease_conflict");
});

// ---- idempotency ---------------------------------------------------------

test("idempotencyKey format + terminal kinds + findTerminalEntry", () => {
  assert.equal(idempotencyKey("muse-room", "clm_1"), "backfill:muse-room:clm_1");
  assert.equal(isTerminalKind("backfill_done"), true);
  assert.equal(isTerminalKind("backfill_aborted"), true);
  assert.equal(isTerminalKind("backfill_start"), false);
  assert.equal(isTerminalKind("reverse_done"), true);
  const entries = [
    { kind: "backfill_start", idempotency_key: "backfill:r:c" },
    { kind: "backfill_done", idempotency_key: "backfill:r:c" },
  ];
  assert.equal(findTerminalEntry(entries, "backfill:r:c").kind, "backfill_done");
  assert.equal(findTerminalEntry(entries, "backfill:r:other"), null);
});

// ---- plan / batch / exit codes ------------------------------------------

test("buildPlan: ordered by (room, claim); fromCursor/limit; skipped passthrough", () => {
  const classified = [
    { claim: liveClaim({ id: "b" }), eligible: true, roomId: "r" },
    { claim: liveClaim({ id: "a" }), eligible: true, roomId: "r" },
    { claim: liveClaim({ id: "z" }), eligible: false, reason: "not_opted_in", roomId: "r" },
  ];
  const { plan, skipped } = buildPlan(classified, {});
  assert.deepEqual(plan.map(p => p.claim_id), ["a", "b"]);
  assert.equal(plan[0].idempotency_key, "backfill:r:a");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "not_opted_in");
  const sliced = buildPlan(classified, { fromCursor: 1, limit: 1 });
  assert.deepEqual(sliced.plan.map(p => p.claim_id), ["b"]);
});

test("batchPlan: batches of n with remainder", () => {
  const plan = Array.from({ length: 7 }, (_, i) => ({ claim_id: `c${i}` }));
  const batches = batchPlan(plan, 5);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 5);
  assert.equal(batches[1].length, 2);
});

test("deriveExitCode: 0 all ok, 1 partial, 2 systemic", () => {
  assert.equal(deriveExitCode({ systemic: false, total: 3, ok: 3, failed: 0 }), EXIT_OK);
  assert.equal(deriveExitCode({ systemic: false, total: 3, ok: 2, failed: 1 }), EXIT_PARTIAL);
  assert.equal(deriveExitCode({ systemic: true, total: 3, ok: 0, failed: 0 }), EXIT_SYSTEMIC);
  assert.equal(deriveExitCode({ systemic: false, total: 0, ok: 0, failed: 0 }), EXIT_OK);
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_PARTIAL, 1);
  assert.equal(EXIT_SYSTEMIC, 2);
});

// ---- journal --------------------------------------------------------------

test("journal: append/read roundtrip with seq; missing file reads empty", () => {
  const dir = tmp();
  const p = join(dir, "j.jsonl");
  assert.deepEqual(readJournal(p), []);
  const e1 = appendJournalEntry(p, { kind: "backfill_plan", room_id: "r" });
  const e2 = appendJournalEntry(p, { kind: "backfill_start", room_id: "r", claim_id: "c" });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.ok(e1.at);
  const back = readJournal(p);
  assert.equal(back.length, 2);
  assert.equal(back[1].kind, "backfill_start");
});

// ---- scan report shape ----------------------------------------------------

test("buildScanReport: D5 dry-run JSON shape", () => {
  const r = buildScanReport({
    command: "scan",
    roomId: "muse-room",
    dryRun: true,
    eligible: [{ claim_id: "c1", member_id: "jillian" }],
    skipped: [{ claim_id: "c2", reason: "claim_terminal", claim_state: "done" }],
  });
  assert.equal(r.command, "scan");
  assert.equal(r.dryRun, true);
  assert.equal(r.room_id, "muse-room");
  assert.equal(r.eligible.length, 1);
  assert.equal(r.skipped[0].reason, "claim_terminal");
  assert.equal(r.plan_count, 1);
  assert.ok(Array.isArray(r.would_write));
  assert.ok(r.would_write.length > 0);
});

test("renderHonestSummary: one paragraph covering moves / not-moves / holder gains", () => {
  const s = renderHonestSummary(buildScanReport({
    command: "scan", roomId: "r", dryRun: true,
    eligible: [{ claim_id: "c1" }], skipped: [{ claim_id: "c2", reason: "not_opted_in" }],
  }));
  assert.ok(s.includes("c1") || s.toLowerCase().includes("1 claim"));
  assert.ok(s.toLowerCase().includes("empty") || s.toLowerCase().includes("starts empty"));
});

// ---- orphans ---------------------------------------------------------------

test("detectOrphans: §4.4 verdicts", () => {
  const nowMs = Date.parse("2026-10-06T12:00:00Z");
  const sessions = [
    { session_id: "s1", claim_id: "c1", room_id: "r" },
    { session_id: "s2", claim_id: "c2", room_id: "r" },
    { session_id: "s3", claim_id: "c3", room_id: "r" },
    { session_id: "s4", claim_id: "c4", room_id: "r" },
  ];
  const inventory = new Set(["s2", "s3"]); // live panes
  const claimsById = {
    c1: liveClaim({ id: "c1", state: "done" }),          // pane gone + terminal => orphan
    c2: liveClaim({ id: "c2", state: "in_progress" }),   // pane live + live => healthy
    c3: liveClaim({ id: "c3", state: "done" }),          // pane live + terminal => NOT orphan
    c4: liveClaim({ id: "c4", state: "in_progress" }),   // pane gone + live => NOT orphan (absence of evidence)
  };
  const out = detectOrphans({ sessions, bridgeInventory: inventory, claimsById, nowMs });
  const by = Object.fromEntries(out.map(o => [o.session_id, o.verdict]));
  assert.equal(by.s1, "orphan");
  assert.equal(by.s2, "healthy");
  assert.equal(by.s3, "terminal_claim_live_pane");
  assert.equal(by.s4, "missing_pane_live_claim");
});

// ---- drain-status ------------------------------------------------------------

test("aggregateDrainStatus: per-room flag state and session counts", () => {
  const out = aggregateDrainStatus({
    roomId: "r",
    flagParsed: parseFlagValue("off"),
    sessions: [{ session_id: "s1" }, { session_id: "s2" }],
    claims: [liveClaim({ id: "a" })],
    bridgeStatus: "not_configured",
  });
  assert.equal(out.room_id, "r");
  assert.equal(out.flag_state, "off");
  assert.equal(out.herdr_open_sessions, 2);
  assert.equal(out.legacy_open_sessions, 1);
  assert.ok(Array.isArray(out.draining));
  assert.ok(Array.isArray(out.orphans));
});

// ---- session links ------------------------------------------------------------

test("linkedClaimIds: journal session links per room (pre-B5 source)", () => {
  const journal = [
    { kind: "backfill_done", room_id: "r", claim_id: "c1", session_id: "s1" },
    { kind: "session_attached", room_id: "r", claim_id: "c2", session_id: "s2" },
    { kind: "backfill_start", room_id: "r", claim_id: "c3" }, // no session yet
    { kind: "backfill_done", room_id: "other", claim_id: "c9", session_id: "s9" },
  ];
  assert.deepEqual([...linkedClaimIds(journal, "r")].sort(), ["c1", "c2"]);
  assert.deepEqual([...linkedClaimIds(journal, "other")], ["c9"]);
  assert.deepEqual([...linkedClaimIds([], "r")], []);
});

// ---- reverse ------------------------------------------------------------------

test("planReverse: steps journal the intent and name the marker gap honestly", () => {  const steps = planReverse({ roomId: "r", claim: liveClaim({ id: "c1" }), marker: "herdr" });
  assert.ok(steps.length >= 3);
  const text = steps.join(" ");
  assert.ok(text.includes("reverse_start"));
  assert.ok(text.toLowerCase().includes("legacy"));
});
