import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_CHECKS,
  evaluateHeadChecks,
  isEligiblePr,
  squashTitle,
  autoland,
} from "./autoland.mjs";

function run(name, conclusion = "success", status = "completed", completed_at = "2026-11-10T00:00:00Z", id = name.length) {
  return { name, conclusion, status, completed_at, id };
}

function allRequired(overrides = {}) {
  return REQUIRED_CHECKS.map((name) => run(name, ...(overrides[name] ? [overrides[name].conclusion, overrides[name].status] : [])));
}

describe("evaluateHeadChecks", () => {
  it("passes when every required check is present and green", () => {
    const result = evaluateHeadChecks(allRequired());
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.pending, []);
  });

  it("accepts a neutral conclusion", () => {
    const result = evaluateHeadChecks(allRequired({ contract: { conclusion: "neutral" } }));
    assert.equal(result.ok, true);
  });

  it("does not let a required check pass on skipped alone (the labeled suite never ran)", () => {
    const result = evaluateHeadChecks(allRequired({ lint: { conclusion: "skipped" } }));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((line) => line.startsWith("lint: only skipped")));
  });

  it("lets a later skipped run from another event hide neither a failure nor a pass", () => {
    const failedThenSkipped = [...allRequired().filter((r) => r.name !== "browser"), run("browser", "failure", "completed", "2026-11-10T00:00:00Z", 1), run("browser", "skipped", "completed", "2026-11-10T01:00:00Z", 2)];
    const red = evaluateHeadChecks(failedThenSkipped);
    assert.equal(red.ok, false);
    assert.ok(red.problems.includes("browser: failure"));
    const passedThenSkipped = [...allRequired().filter((r) => r.name !== "browser"), run("browser", "success", "completed", "2026-11-10T00:00:00Z", 1), run("browser", "skipped", "completed", "2026-11-10T01:00:00Z", 2)];
    assert.equal(evaluateHeadChecks(passedThenSkipped).ok, true);
  });

  it("takes the newer of two real results (a re-run that went green)", () => {
    const rerun = [...allRequired().filter((r) => r.name !== "cloudflare"), run("cloudflare", "failure", "completed", "2026-11-10T00:00:00Z", 1), run("cloudflare", "success", "completed", "2026-11-10T01:00:00Z", 2)];
    assert.equal(evaluateHeadChecks(rerun).ok, true);
  });

  it("reports missing required checks so autoland cannot skip the ready-to-land suite", () => {
    const result = evaluateHeadChecks([run("safety-net"), run("mechanical")]);
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes("test: missing"));
    assert.ok(result.problems.includes("browser: missing"));
    assert.ok(result.problems.includes("cloudflare: missing"));
  });

  it("treats a failed browser shard as a hard failure, not advisory", () => {
    const result = evaluateHeadChecks([
      ...allRequired(),
      run("browser (3)", "failure"),
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes("browser (3): failure"));
  });

  it("does not require pin-gate or schema-gate when they are absent", () => {
    const result = evaluateHeadChecks(allRequired());
    assert.equal(result.ok, true);
    assert.ok(!result.problems.some((line) => line.startsWith("pin-gate:") || line.startsWith("schema-gate:")));
  });

  it("requires pin-gate to be green when it is present", () => {
    const result = evaluateHeadChecks([...allRequired(), run("pin-gate", "failure")]);
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes("pin-gate: failure"));
  });

  it("waits on in-progress checks", () => {
    const result = evaluateHeadChecks(allRequired({ browser: { conclusion: null, status: "in_progress" } }));
    assert.equal(result.ok, false);
    assert.ok(result.pending.includes("browser: in_progress"));
  });

  it("fails a red commit status that is not also a check run", () => {
    const result = evaluateHeadChecks(allRequired(), [
      { context: "custom-gate", state: "failure", updated_at: "2026-11-10T00:00:00Z", id: 1 },
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes("custom-gate: failure"));
  });
});

describe("isEligiblePr and squash title", () => {
  const base = {
    state: "open",
    draft: false,
    base: { ref: "main" },
    labels: [{ name: "autoland" }],
    mergeable_state: "clean",
    number: 42,
    title: "Fix the thing",
  };

  it("accepts an open non-draft autoland PR that is CLEAN with green checks", () => {
    assert.deepEqual(isEligiblePr(base, { ok: true }), { ok: true, reason: "eligible" });
  });

  it("rejects drafts, dirty merge state, other bases, and missing labels", () => {
    assert.equal(isEligiblePr({ ...base, draft: true }, { ok: true }).ok, false);
    assert.equal(isEligiblePr({ ...base, mergeable_state: "dirty" }, { ok: true }).reason, "mergeable_state is dirty");
    assert.equal(isEligiblePr({ ...base, labels: [] }, { ok: true }).reason, "missing autoland label");
    assert.equal(isEligiblePr({ ...base, base: { ref: "develop" } }, { ok: true }).reason, "base is develop");
  });

  it("keeps the ordinary squash title; no title prefix is needed to start a deploy", () => {
    assert.equal(squashTitle(base), "Fix the thing (#42)");
    assert.ok(squashTitle({ ...base, title: "x".repeat(400) }).length <= 200);
  });
});

describe("autoland", () => {
  const sha = "a".repeat(40);
  const tip = "b".repeat(40);
  const greenPr = {
    number: 10,
    state: "open",
    draft: false,
    title: "Green change",
    base: { ref: "main" },
    labels: [{ name: "autoland" }],
    mergeable_state: "clean",
    head: { sha },
  };

  function mockApi(options = {}) {
    const calls = [];
    const request = (args, extra) => {
      calls.push({ args, extra });
      const path = args[args.length - 1];
      if (path.endsWith("/labels/autoland")) return { name: "autoland" };
      if (path.includes("/issues?")) return options.issues ?? [{ number: 10, pull_request: {} }];
      if (path.includes("/pulls/10")) return options.pr ?? greenPr;
      if (path.includes("/check-runs")) return { check_runs: options.checks ?? allRequired() };
      if (path.includes("/statuses")) return options.statuses ?? [];
      if (path.includes("/actions/runs")) {
        return { workflow_runs: options.schemaGreen === false ? [] : [{ name: "schema-gate", conclusion: "success", created_at: "2026-11-10T00:00:00Z" }] };
      }
      if (path.includes("/commits/main")) return { sha: options.tip ?? tip };
      if (args[0] === "--method" && args[1] === "PUT") return { merged: true, sha: tip };
      return {};
    };
    return { request, calls };
  }

  it("refuses to merge when LANDING_TOKEN is missing", async () => {
    const result = await autoland({
      repo: "Uuriko/project-room",
      token: "",
      env: {},
      request: () => {
        throw new Error("should not call github");
      },
    });
    assert.deepEqual(result.merged, []);
    assert.ok(result.missing.includes("LANDING_TOKEN"));
  });

  it("squash-merges an eligible PR and dispatches deploy-prod at once, without waiting for schema-gate (the deploy gate waits)", async () => {
    const { request } = mockApi();
    const dispatched = [];
    const room = [];
    const result = await autoland({
      repo: "Uuriko/project-room",
      token: "test-token",
      request,
      dispatch: (repo, sha, reason) => dispatched.push({ repo, sha, reason }),
      room: async (line) => room.push(line),
      env: { ROOM_RECEIPT_TOKEN: "room-token" },
    });
    assert.equal(result.merged.length, 1);
    assert.equal(result.merged[0].number, 10);
    assert.equal(result.dispatched, true);
    assert.equal(dispatched[0].sha, tip);
    assert.ok(room[0].startsWith("AUTOLAND MERGE · #10"));
    assert.ok(room[1].startsWith("AUTOLAND DEPLOY · dispatched deploy-prod"));
  });

  it("posts a Room line and fails loudly when the dispatch itself fails after a merge", async () => {
    const { request } = mockApi();
    const room = [];
    await assert.rejects(
      autoland({
        repo: "Uuriko/project-room",
        token: "test-token",
        request,
        dispatch: () => {
          throw new Error("HTTP 403");
        },
        room: async (line) => room.push(line),
        env: {},
      }),
      /HTTP 403/,
    );
    assert.ok(room.some((line) => line.includes("FAILED") && line.includes("Dispatch it by hand")));
  });

  it("does not merge in dry-run, and leaves deploy-prod untriggered", async () => {
    const { request, calls } = mockApi();
    const result = await autoland({
      repo: "Uuriko/project-room",
      token: "test-token",
      dryRun: true,
      request,
      dispatch: () => {
        throw new Error("should not dispatch");
      },
      room: async () => {},
      env: {},
    });
    assert.equal(result.merged.length, 0);
    assert.equal(result.skipped[0].eligible, true);
    assert.equal(result.dispatched, false);
    assert.ok(!calls.some((call) => call.args.includes("PUT")));
  });

  it("skips a labeled PR whose browser shard failed", async () => {
    const { request } = mockApi({ checks: [...allRequired(), run("browser (2)", "failure")] });
    const result = await autoland({
      repo: "Uuriko/project-room",
      token: "test-token",
      request,
      dispatch: () => {
        throw new Error("should not dispatch");
      },
      room: async () => {},
      env: {},
    });
    assert.equal(result.merged.length, 0);
    assert.match(result.skipped[0].reason, /browser \(2\): failure/);
  });
});
