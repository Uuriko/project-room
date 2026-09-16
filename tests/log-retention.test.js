// F022: log retention policy + enforcement tests.
//
// Pure unit tests over the module's own API with an injectable clock and an
// in-memory store spy: policy evaluation (due vs retained vs held), the
// archive/purge routing, legal-hold protection, dry-run write-freedom, and
// failure tolerance in the enforcement batch.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_ARCHIVE,
  ACTION_PURGE,
  DEFAULT_POLICY,
  createPolicy,
  evaluateRetention,
  enforceRetention
} from "../src/log-retention.mjs";

const NOW = "2026-09-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;

// Entry factory: { sequence, event, logType, legalHold } — the F022 shape
// over the F004 event { id, type, roomId, actorId, at, data }.
const makeEntry = (seq, { ageDays = 0, logType = "operational", hold = false } = {}) => ({
  sequence: seq,
  logType,
  legalHold: hold,
  event: {
    id: `e_${seq}`,
    type: "message.posted",
    roomId: "room_1",
    actorId: "m_avery",
    at: new Date(NOW_MS - ageDays * DAY).toISOString(),
    data: { messageId: `m_${seq}` }
  }
});

const makeStore = (entries, { failOn = new Set(), writes = null } = {}) => {
  const calls = writes ?? { archive: [], purge: [] };
  return {
    calls,
    list() { return entries; },
    archive(entry) {
      if (failOn.has(entry.event.id)) throw new Error("archive backend down");
      calls.archive.push(entry);
    },
    purge(entry) {
      if (failOn.has(entry.event.id)) throw new Error("purge backend down");
      calls.purge.push(entry);
    }
  };
};

test("default policy has the documented windows", () => {
  assert.equal(DEFAULT_POLICY.windows.audit.days, 2555);
  assert.equal(DEFAULT_POLICY.windows.audit.action, ACTION_ARCHIVE);
  assert.equal(DEFAULT_POLICY.windows.security.days, 365);
  assert.equal(DEFAULT_POLICY.windows.security.action, ACTION_ARCHIVE);
  assert.equal(DEFAULT_POLICY.windows.operational.days, 90);
  assert.equal(DEFAULT_POLICY.windows.operational.action, ACTION_PURGE);
  assert.equal(DEFAULT_POLICY.default.action, ACTION_PURGE);
});

test("createPolicy merges overrides and validates", () => {
  const p = createPolicy({ windows: { operational: { days: 30, action: ACTION_PURGE } }, name: "strict" });
  assert.equal(p.windows.operational.days, 30);
  assert.equal(p.name, "strict");
  assert.equal(p.default.days, DEFAULT_POLICY.default.days);
  assert.throws(() => createPolicy({ windows: { operational: { days: -1, action: ACTION_PURGE } } }), TypeError);
  assert.throws(() => createPolicy({ windows: { operational: { days: 30, action: "shred" } } }), TypeError);
  assert.throws(() => createPolicy({ windows: { operational: { days: 30.5, action: ACTION_PURGE } } }), TypeError);
  assert.throws(() => createPolicy(null), TypeError);
});

test("entries inside their window are retained, expired ones are due", () => {
  const entries = [
    makeEntry(1, { ageDays: 3000, logType: "audit" }),     // 8.2y > 7y audit window -> due, archive
    makeEntry(2, { ageDays: 100, logType: "audit" }),      // within audit window -> retained
    makeEntry(3, { ageDays: 100, logType: "operational" }), // > 90d operational -> due, purge
    makeEntry(4, { ageDays: 10, logType: "operational" })   // within -> retained
  ];
  const { due, held, retained } = evaluateRetention(entries, DEFAULT_POLICY, NOW);
  assert.equal(due.length, 2);
  assert.equal(held.length, 0);
  assert.equal(retained.length, 2);
  const byId = Object.fromEntries(due.map(d => [d.eventId, d]));
  assert.equal(byId.e_1.action, ACTION_ARCHIVE);
  assert.equal(byId.e_1.logType, "audit");
  assert.equal(byId.e_3.action, ACTION_PURGE);
  assert.equal(byId.e_3.logType, "operational");
  assert.deepEqual(retained.map(r => r.eventId).sort(), ["e_2", "e_4"]);
  assert.equal(retained[0].reason, "within-window");
});

test("an entry exactly at the cutoff is due", () => {
  const entries = [makeEntry(1, { ageDays: 90, logType: "operational" })];
  const { due } = evaluateRetention(entries, DEFAULT_POLICY, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0].action, ACTION_PURGE);
});

test("unknown log types fall back to the default window", () => {
  const entries = [makeEntry(1, { ageDays: 100, logType: "webhook-callbacks" })];
  const { due } = evaluateRetention(entries, DEFAULT_POLICY, NOW);
  assert.equal(due.length, 1);
  // The original log type is reported; the default window's action applies.
  assert.equal(due[0].logType, "webhook-callbacks");
  assert.equal(due[0].action, ACTION_PURGE);
});

test("legal hold protects entries that would otherwise be purged", () => {
  const entries = [
    makeEntry(1, { ageDays: 3000, logType: "audit", hold: true }),
    makeEntry(2, { ageDays: 3000, logType: "audit", hold: false })
  ];
  const { due, held, retained } = evaluateRetention(entries, DEFAULT_POLICY, NOW);
  assert.equal(held.length, 1);
  assert.equal(held[0].eventId, "e_1");
  assert.equal(held[0].reason, "legal-hold");
  assert.equal(due.length, 1);
  assert.equal(due[0].eventId, "e_2");
  assert.equal(retained.length, 0);
});

test("legal hold on the event or event.data also protects", () => {
  const a = makeEntry(1, { ageDays: 3000, logType: "operational" });
  delete a.legalHold;
  a.event.legalHold = true;
  const b = makeEntry(2, { ageDays: 3000, logType: "operational" });
  delete b.legalHold;
  b.event.data.legalHold = true;
  const { due, held } = evaluateRetention([a, b], DEFAULT_POLICY, NOW);
  assert.equal(due.length, 0);
  assert.equal(held.length, 2);
});

test("entries with unparseable timestamps are retained, never due", () => {
  const entries = [
    { sequence: 1, logType: "operational", event: { id: "e_1", at: "not-a-date" } },
    { sequence: 2, logType: "operational", event: { id: "e_2" } }
  ];
  const { due, retained } = evaluateRetention(entries, DEFAULT_POLICY, NOW);
  assert.equal(due.length, 0);
  assert.equal(retained.length, 2);
  assert.ok(retained.every(r => r.reason === "unparseable-timestamp"));
});

test("bare events are tolerated", () => {
  const entries = [{ id: "e_1", type: "message.posted", at: new Date(NOW_MS - 100 * DAY).toISOString() }];
  const { due } = evaluateRetention(entries, DEFAULT_POLICY, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0].action, ACTION_PURGE);
});

test("evaluateRetention throws on a bad policy and skips null rows", () => {
  assert.throws(() => evaluateRetention([], null, NOW), TypeError);
  assert.throws(() => evaluateRetention([], {}, NOW), TypeError);
  const { due, held, retained } = evaluateRetention([null, undefined, 42], DEFAULT_POLICY, NOW);
  assert.equal(due.length + held.length + retained.length, 0);
});

test("enforceRetention archives audit entries and purges operational ones", () => {
  const entries = [
    makeEntry(1, { ageDays: 3000, logType: "audit" }),
    makeEntry(2, { ageDays: 100, logType: "operational" }),
    makeEntry(3, { ageDays: 1, logType: "operational" })
  ];
  const store = makeStore(entries);
  const report = enforceRetention(store, DEFAULT_POLICY, { now: NOW });
  assert.equal(report.dryRun, false);
  assert.equal(report.scanned, 3);
  assert.equal(report.archived, 1);
  assert.equal(report.purged, 1);
  assert.equal(report.held, 0);
  assert.equal(report.retained, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.runAt, new Date(NOW_MS).toISOString());
  assert.deepEqual(store.calls.archive.map(e => e.event.id), ["e_1"]);
  assert.deepEqual(store.calls.purge.map(e => e.event.id), ["e_2"]);
  assert.equal(report.actions.length, 2);
  assert.ok(report.actions.every(a => a.status === "done"));
});

test("dry run plans actions and performs no writes", () => {
  const entries = [
    makeEntry(1, { ageDays: 3000, logType: "audit" }),
    makeEntry(2, { ageDays: 100, logType: "operational" })
  ];
  const readOnly = { list: () => entries };
  const seen = [];
  const report = enforceRetention(readOnly, DEFAULT_POLICY, { now: NOW, dryRun: true, onAction: r => seen.push(r) });
  assert.equal(report.dryRun, true);
  assert.equal(report.archived, 0);
  assert.equal(report.purged, 0);
  assert.equal(report.actions.length, 2);
  assert.ok(report.actions.every(a => a.status === "planned"));
  assert.deepEqual(seen, report.actions);
  // No archive/purge methods existed to be called — a read-only store plans fine.
});

test("a store write failure is recorded, not thrown, and the batch continues", () => {
  const entries = [
    makeEntry(1, { ageDays: 3000, logType: "audit" }),
    makeEntry(2, { ageDays: 100, logType: "operational" })
  ];
  const store = makeStore(entries, { failOn: new Set(["e_1"]) });
  const report = enforceRetention(store, DEFAULT_POLICY, { now: NOW });
  assert.equal(report.failed, 1);
  assert.equal(report.archived, 0);
  assert.equal(report.purged, 1);
  const failed = report.actions.find(a => a.eventId === "e_1");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /archive backend down/);
});

test("enforceRetention validates the store shape", () => {
  assert.throws(() => enforceRetention(null, DEFAULT_POLICY, { now: NOW }), TypeError);
  assert.throws(() => enforceRetention({}, DEFAULT_POLICY, { now: NOW }), TypeError);
  // Non-dry-run without archive/purge is rejected; dry-run accepts a list-only store.
  assert.throws(() => enforceRetention({ list: () => [] }, DEFAULT_POLICY, { now: NOW }), TypeError);
  const report = enforceRetention({ list: () => [] }, DEFAULT_POLICY, { now: NOW, dryRun: true });
  assert.equal(report.scanned, 0);
});

test("held entries never reach the store", () => {
  const entries = [
    makeEntry(1, { ageDays: 3000, logType: "audit", hold: true }),
    makeEntry(2, { ageDays: 100, logType: "operational", hold: true })
  ];
  const store = makeStore(entries);
  const report = enforceRetention(store, DEFAULT_POLICY, { now: NOW });
  assert.equal(report.held, 2);
  assert.equal(store.calls.archive.length, 0);
  assert.equal(store.calls.purge.length, 0);
  assert.equal(report.actions.length, 0);
});

test("custom policy windows are honored end to end", () => {
  const policy = createPolicy({ windows: { audit: { days: 10, action: ACTION_ARCHIVE, label: "Audit" } } });
  const entries = [makeEntry(1, { ageDays: 20, logType: "audit" })];
  const store = makeStore(entries);
  const report = enforceRetention(store, policy, { now: NOW });
  assert.equal(report.archived, 1);
  assert.equal(report.policyName, DEFAULT_POLICY.name);
  assert.equal(report.policyVersion, 1);
});
