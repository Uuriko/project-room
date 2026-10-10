// Tripwire evaluator tests (200-hard-tasks #20).
// Contract guarded: the kill-criteria rules file evaluates machine-
// checkably — synthetic snapshots produce exactly GO / PAUSE / KILL with
// the right reasons, the YAML subset parser round-trips the real rules
// file, and missing signals are reported rather than silently treated as
// zero (a missing doublePayouts signal must not read as "no double
// payouts"). Credible regression: if a condition ever evaluated a missing
// signal as 0, the kill-double-payout rule would silently disarm; the
// missing-signal test pins the report.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlSubset, evaluateRules } from "../scripts/evaluate-tripwires.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = join(ROOT, "research", "tripwire-rules.yaml");

const baseSnapshot = () => ({
  settlement: {
    doublePayouts: 0, forgedReceiptRate: 0, unauthorizedMints: 0,
    liabilitiesRaw: "1000000", bondedRaw: "5000000",
    meanAbsDivergence: 0.02, disputeRate: 0.01, attestationDelaySec: 60,
  },
  compute: { jobFailRate: 0.02, p95WaitSec: 10 },
  providers: { cheatConfirmed: 0, suspendedCount: 0 },
});

describe("tripwire rules", () => {
  it("the real rules file parses: 12 signals, 12 rules", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    assert.equal(doc.version, "tripwire-rules/v1");
    assert.equal(Object.keys(doc.signals).length, 12);
    assert.equal(doc.rules.length, 12);
    for (const r of doc.rules) {
      assert.ok(r.id && ["WARN", "PAUSE", "KILL"].includes(r.verdict) && r.when && r.reason, r.id);
    }
  });

  it("clean snapshot -> GO", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    const r = evaluateRules(doc, baseSnapshot());
    assert.equal(r.verdict, "GO");
    assert.deepEqual(r.fired, []);
    assert.deepEqual(r.missingSignals, []);
  });

  it("high divergence -> PAUSE with reason and action", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    const snap = baseSnapshot();
    snap.settlement.meanAbsDivergence = 0.15;
    const r = evaluateRules(doc, snap);
    assert.equal(r.verdict, "PAUSE");
    const fired = r.fired.find((f) => f.id === "pause-high-divergence");
    assert.ok(fired);
    assert.match(fired.reason, /divergence/);
    assert.ok(fired.action.length > 0);
  });

  it("double payout -> KILL", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    const snap = baseSnapshot();
    snap.settlement.doublePayouts = 1;
    const r = evaluateRules(doc, snap);
    assert.equal(r.verdict, "KILL");
    assert.ok(r.fired.some((f) => f.id === "kill-double-payout"));
  });

  it("insolvency (liabilities > bonded, string amounts) -> KILL", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    const snap = baseSnapshot();
    snap.settlement.liabilitiesRaw = "9000000";
    const r = evaluateRules(doc, snap);
    assert.equal(r.verdict, "KILL");
    assert.ok(r.fired.some((f) => f.id === "kill-insolvency"));
  });

  it("multi-fire: KILL wins and every reason is reported", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    const snap = baseSnapshot();
    snap.settlement.doublePayouts = 2;
    snap.compute.p95WaitSec = 200;
    snap.providers.suspendedCount = 3;
    const r = evaluateRules(doc, snap);
    assert.equal(r.verdict, "KILL");
    assert.equal(r.fired.length, 3);
    assert.deepEqual(r.fired.map((f) => f.id).sort(), ["kill-double-payout", "pause-queue-blowout", "warn-suspensions"]);
  });

  it("warn-only snapshot -> WARN (not GO, not PAUSE)", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    const snap = baseSnapshot();
    snap.settlement.meanAbsDivergence = 0.07;
    const r = evaluateRules(doc, snap);
    assert.equal(r.verdict, "WARN");
  });

  it("missing signals are reported, never treated as zero", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    const snap = baseSnapshot();
    delete snap.settlement.doublePayouts;
    const r = evaluateRules(doc, snap);
    // The kill rule must NOT fire on missing data, but the gap is reported.
    assert.ok(!r.fired.some((f) => f.id === "kill-double-payout"));
    assert.ok(r.missingSignals.includes("settlement.doublePayouts"));
  });

  it("cheat confirmed -> PAUSE (quarantine)", () => {
    const doc = parseYamlSubset(readFileSync(RULES, "utf8"));
    const snap = baseSnapshot();
    snap.providers.cheatConfirmed = 1;
    const r = evaluateRules(doc, snap);
    assert.equal(r.verdict, "PAUSE");
    assert.ok(r.fired.some((f) => f.id === "pause-cheat-confirmed"));
  });
});

describe("evaluate-tripwires CLI", () => {
  const cli = (...a) => spawnSync("node", [join(ROOT, "scripts", "evaluate-tripwires.mjs"), ...a], { encoding: "utf8" });
  const snapFile = join(ROOT, "tests", ".tmp-tripwire-snap.json");

  it("exits 0/1/2 for GO/PAUSE/KILL and prints the verdict", () => {
    try {
      writeFileSync(snapFile, JSON.stringify(baseSnapshot()));
      const go = cli(RULES, snapFile);
      assert.equal(go.status, 0);
      assert.match(go.stdout, /verdict: GO/);

      const snap = baseSnapshot();
      snap.settlement.meanAbsDivergence = 0.2;
      writeFileSync(snapFile, JSON.stringify(snap));
      const pause = cli(RULES, snapFile);
      assert.equal(pause.status, 1);
      assert.match(pause.stdout, /verdict: PAUSE/);
      assert.match(pause.stdout, /pause-high-divergence/);

      snap.settlement.doublePayouts = 1;
      writeFileSync(snapFile, JSON.stringify(snap));
      const kill = cli(RULES, snapFile);
      assert.equal(kill.status, 2);
      assert.match(kill.stdout, /verdict: KILL/);
    } finally {
      try {
        unlinkSync(snapFile);
      } catch {}
    }
  });

  it("exits 2 on usage errors", () => {
    assert.equal(cli().status, 2);
  });
});
