import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { HEAD_CHECK_NAMES, choosePullRequest, dispatchArgs, headCheckDecision, indexRuns, landingExitCode, mergeArgs, rerunArgs, rerunTarget, resolveRerun, runLanding, scheduledDeployBlocked, selectDeployCandidate, selectLandingBatch } from "../scripts/repo-automations.mjs";

const sha = char => char.repeat(40);
const required = (at = "2026-10-25T00:00:00Z") => HEAD_CHECK_NAMES.map(name => ({
  name, status: "completed", conclusion: "success", startedAt: at,
}));

function pull(overrides = {}) {
  return {
    number: 10,
    state: "open",
    draft: false,
    base: "main",
    labels: ["ready-to-land"],
    sha: sha("a"),
    mergeable: "UNKNOWN",
    mergeStateStatus: "CLEAN",
    green: true,
    ...overrides,
  };
}

test("head is green only when the required checks succeeded and every latest check is done", () => {
  assert.equal(headCheckDecision(required()).green, true);
  assert.equal(headCheckDecision([...required(), { name: "pin-gate", status: "completed", conclusion: "skipped", startedAt: "2026-10-25T00:00:00Z" }]).green, true);
  assert.equal(headCheckDecision([...required(), { name: "Cursor Approval Agent", status: "completed", conclusion: "neutral", startedAt: "2026-10-25T00:00:00Z" }]).green, true);
  const olderFailure = [
    ...required().filter(run => run.name !== "test"),
    { name: "test", status: "completed", conclusion: "failure", startedAt: "2026-10-25T00:00:00Z" },
    { name: "test", status: "completed", conclusion: "success", startedAt: "2026-10-25T01:00:00Z" },
  ];
  assert.equal(headCheckDecision(olderFailure).green, true);
  assert.equal(headCheckDecision(required().filter(run => run.name !== "lint")).green, false);
  assert.equal(headCheckDecision(required().map(run => run.name === "browser" ? { ...run, status: "in_progress", conclusion: null } : run)).green, false);
  assert.equal(headCheckDecision([...required(), { name: "pin-gate", status: "completed", conclusion: "failure", startedAt: "2026-10-25T02:00:00Z" }]).green, false);
  assert.equal(headCheckDecision([...required(), { name: "pin-gate", status: "in_progress", conclusion: null, startedAt: "2026-10-25T02:00:00Z" }]).green, false);
});

test("a pending or failed commit status blocks, and a missing status does not", () => {
  assert.equal(headCheckDecision(required(), []).green, true);
  assert.equal(headCheckDecision(required(), [{ context: "room/release-lease", state: "pending", updatedAt: "2026-10-25T00:00:00Z" }]).green, false);
  assert.equal(headCheckDecision(required(), [{ context: "room/release-lease", state: "failure", updatedAt: "2026-10-25T00:00:00Z" }]).green, false);
  const cleared = [
    { context: "room/release-lease", state: "pending", updatedAt: "2026-10-25T00:00:00Z" },
    { context: "room/release-lease", state: "success", updatedAt: "2026-10-25T01:00:00Z" },
  ];
  assert.equal(headCheckDecision(required(), cleared).green, true);
});

test("the landing batch is the oldest green ready pull requests, including an unknown mergeability", () => {
  const batch = selectLandingBatch([
    pull({ number: 30, sha: sha("c") }),
    pull({ number: 8, sha: sha("b"), mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    pull({ number: 12, draft: true }),
    pull({ number: 13, state: "closed" }),
    pull({ number: 14, base: "release" }),
    pull({ number: 15, labels: [] }),
    pull({ number: 16, green: false }),
    pull({ number: 17, mergeable: false }),
    pull({ number: 18, mergeable: "CONFLICTING" }),
    pull({ number: 19, mergeStateStatus: "DIRTY" }),
    pull({ number: 20, sha: "abc" }),
  ]);
  assert.deepEqual(batch, [
    { number: 8, sha: sha("b") },
    { number: 30, sha: sha("c") },
  ]);
});

test("landing merges oldest first, dispatches after a direct merge, and not when the queue holds the pull request", async () => {
  const merged = [];
  const dispatched = [];
  const result = await runLanding({
    listPulls: async () => [pull({ number: 30, sha: sha("c") }), pull({ number: 8, sha: sha("b") }), pull({ number: 4, sha: sha("d") })],
    checksFor: async value => ({
      checkRuns: value === sha("d")
        ? [...required(), { name: "pin-gate", status: "completed", conclusion: "failure", startedAt: "2026-10-25T03:00:00Z" }]
        : required(),
    }),
    merge: async pr => { merged.push(pr.number); },
    view: async () => "MERGED",
    dispatch: async workflow => { dispatched.push(workflow); },
  });
  assert.deepEqual(merged, [8, 30]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(dispatched, ["test.yml", "schema-gate.yml"]);
  assert.equal(result.dispatched, true);

  const queued = [];
  const queuedResult = await runLanding({
    listPulls: async () => [pull()],
    checksFor: async () => ({ checkRuns: required(), statuses: [] }),
    merge: async pr => { queued.push(pr); },
    view: async () => "OPEN",
    dispatch: async () => { throw new Error("dispatch"); },
  });
  assert.equal(queuedResult.dispatched, false);
  assert.equal(queuedResult.attempted[0].queued, true);
  assert.deepEqual(mergeArgs("Uuriko/project-room", queued[0]), [
    "pr", "merge", "10", "--repo", "Uuriko/project-room", "--merge", "--match-head-commit", sha("a"),
  ]);
  assert.equal(mergeArgs("Uuriko/project-room", queued[0]).includes("--admin"), false);
});

test("a failed merge does not stop the rest of the batch, and a fully failed batch exits 1", async () => {
  const seen = [];
  const result = await runLanding({
    listPulls: async () => [pull({ number: 2, sha: sha("b") }), pull({ number: 3, sha: sha("c") })],
    checksFor: async () => ({ checkRuns: required() }),
    merge: async pr => { seen.push(pr.number); if (pr.number === 2) throw new Error("protected"); },
    view: async number => (number === 2 ? "OPEN" : "MERGED"),
    dispatch: async () => {},
  });
  assert.deepEqual(seen, [2, 3]);
  assert.equal(result.attempted.some(item => item.number === 2 && item.error), true);
  assert.equal(result.attempted.some(item => item.number === 3 && item.merged), true);
  assert.equal(result.dispatched, true);
  assert.equal(landingExitCode(result), 0);
  const allFailed = await runLanding({
    listPulls: async () => [pull()],
    checksFor: async () => ({ checkRuns: required() }),
    merge: async () => { throw new Error("protected"); },
    view: async () => "OPEN",
    dispatch: async () => { throw new Error("dispatch"); },
  });
  assert.equal(allFailed.dispatched, false);
  assert.equal(landingExitCode(allFailed), 1);
  assert.equal(landingExitCode({ attempted: [] }), 0);
});

test("a superseded ready pull request reruns the head's first cancelled attempt once", async () => {
  const head = sha("b");
  const older = sha("a");
  const pullRequest = { state: "open", draft: false, labels: ["ready-to-land"], headSha: head };
  const oldRun = { id: 1, name: "test", workflowId: 9, headSha: older, conclusion: "cancelled", event: "pull_request", runAttempt: 1 };
  const headRun = { id: 44, name: "test", workflowId: 9, headSha: head, conclusion: "cancelled", event: "pull_request", runAttempt: 1, createdAt: "2026-10-25T01:00:00Z" };
  assert.equal(rerunTarget({ run: oldRun, pullRequest, headRuns: [headRun] }).rerun, 44);
  assert.equal(rerunTarget({ run: { ...headRun, headSha: head }, pullRequest, headRuns: [headRun], pullRuns: [] }).reason, "cancelled run is still the head commit");
  assert.equal(rerunTarget({ run: { ...headRun }, pullRequest, headRuns: [headRun], pullRuns: [oldRun] }).rerun, 44);
  assert.equal(rerunTarget({ run: oldRun, pullRequest, headRuns: [{ ...headRun, status: "in_progress", conclusion: null }] }).rerun, null);
  assert.equal(rerunTarget({ run: oldRun, pullRequest, headRuns: [{ ...headRun, conclusion: "success" }] }).rerun, null);
  assert.equal(rerunTarget({ run: oldRun, pullRequest, headRuns: [{ ...headRun, runAttempt: 2 }] }).retry, false);
  assert.equal(rerunTarget({ run: oldRun, pullRequest: { ...pullRequest, draft: true }, headRuns: [headRun] }).rerun, null);
  assert.equal(rerunTarget({ run: oldRun, pullRequest: { ...pullRequest, labels: [] }, headRuns: [headRun] }).rerun, null);
  assert.equal(rerunTarget({ run: { ...oldRun, event: "push" }, pullRequest, headRuns: [headRun] }).rerun, null);
  assert.deepEqual(rerunArgs("Uuriko/project-room", 44), ["run", "rerun", "44", "--repo", "Uuriko/project-room"]);
  assert.equal(rerunArgs("Uuriko/project-room", 44).includes("--failed"), false);

  let loads = 0;
  const slept = [];
  const decision = await resolveRerun({
    run: oldRun,
    pullRequest,
    load: async () => {
      loads += 1;
      return loads === 1 ? { headRuns: [], pullRuns: [] } : { headRuns: [headRun], pullRuns: [] };
    },
    sleep: async ms => { slept.push(ms); },
  });
  assert.deepEqual(slept, [15000]);
  assert.equal(loads, 2);
  assert.equal(decision.rerun, 44);
  assert.equal(decision.retry, false);
});

test("choosePullRequest prefers the open ready-to-land pull request into main", () => {
  const chosen = choosePullRequest([
    { number: 1, state: "closed", base: { ref: "main" }, labels: [{ name: "ready-to-land" }], head: { sha: sha("a"), ref: "old" } },
    { number: 2, state: "open", base: { ref: "main" }, labels: [], head: { sha: sha("b"), ref: "other" } },
    { number: 3, state: "OPEN", baseRefName: "main", labels: ["ready-to-land"], headRefOid: sha("c"), headRefName: "ready", isDraft: false },
  ]);
  assert.equal(chosen.number, 3);
  assert.equal(chosen.headSha, sha("c"));
  assert.equal(chosen.branch, "ready");
});

test("hourly deploy picks the newest green main commit and will not roll production backward", () => {
  const tip = sha("c");
  const mid = sha("b");
  const old = sha("a");
  const commits = [tip, mid, old];
  const green = { test: "success", "schema-gate": "success" };
  const ancestor = (older, newer) => {
    const order = [old, mid, tip];
    const left = order.indexOf(older);
    const right = order.indexOf(newer);
    if (left < 0 || right < 0) return null;
    return left <= right;
  };
  assert.equal(selectDeployCandidate({
    commits,
    runsBySha: { [tip]: { test: "in_progress", "schema-gate": "success" }, [mid]: green },
    prodSha: old,
    isAncestor: ancestor,
  }).sha, null);
  assert.equal(selectDeployCandidate({
    commits,
    runsBySha: { [tip]: { test: "failure", "schema-gate": "success" }, [mid]: green },
    prodSha: old,
    isAncestor: ancestor,
  }).sha, mid);
  assert.equal(selectDeployCandidate({
    commits,
    runsBySha: { [tip]: green },
    prodSha: tip,
    isAncestor: ancestor,
  }).reason, "production is already on the newest green commit");
  assert.equal(selectDeployCandidate({
    commits,
    runsBySha: { [tip]: { test: "failure", "schema-gate": "cancelled" }, [old]: green },
    prodSha: mid,
    isAncestor: ancestor,
  }).reason, "the newest green commit is behind production");
  assert.equal(selectDeployCandidate({
    commits,
    runsBySha: { [tip]: green },
    prodSha: sha("d"),
    isAncestor: () => false,
  }).reason, "production is not an ancestor of the newest green commit");
  assert.equal(selectDeployCandidate({
    commits,
    runsBySha: { [tip]: green },
    prodSha: sha("e"),
    isAncestor: () => null,
  }).sha, tip);
  assert.equal(selectDeployCandidate({
    commits,
    runsBySha: { [tip]: { test: "failure", "schema-gate": "missing" } },
    prodSha: null,
    isAncestor: ancestor,
  }).reason, "no green main commit");
});

test("indexRuns keeps the latest test and schema-gate result and ignores other workflows", () => {
  const head = sha("a");
  const indexed = indexRuns([
    { name: "test", head_sha: head, created_at: "2026-10-25T00:00:00Z", conclusion: "failure", id: 1 },
    { name: "pin-gate", head_sha: head, created_at: "2026-10-25T02:00:00Z", conclusion: "success", id: 3 },
    { name: "test", head_sha: head, created_at: "2026-10-25T01:00:00Z", conclusion: null, status: "in_progress", id: 2 },
    { name: "schema-gate", headSha: head, createdAt: "2026-10-25T01:30:00Z", conclusion: "success", id: 4 },
  ]);
  assert.deepEqual(indexed, { [head]: { test: "in_progress", "schema-gate": "success" } });
});

test("a scheduled deploy inside the last hour blocks another, and this run does not block itself", () => {
  const now = Date.parse("2026-10-25T02:00:00Z");
  assert.equal(scheduledDeployBlocked([{ id: 7, createdAt: "2026-10-25T01:30:00Z" }], { now, runId: 8 }), true);
  assert.equal(scheduledDeployBlocked([{ id: 7, createdAt: "2026-10-25T00:30:00Z" }], { now, runId: 8 }), false);
  assert.equal(scheduledDeployBlocked([{ id: 8, createdAt: "2026-10-25T01:59:00Z" }], { now, runId: "8" }), false);
  assert.equal(scheduledDeployBlocked([{ id: 9, createdAt: "not-a-date" }], { now, runId: 8 }), false);
});

test("dispatch args target main and do not watch a run", () => {
  assert.deepEqual(dispatchArgs("Uuriko/project-room", "schema-gate.yml"), [
    "workflow", "run", "schema-gate.yml", "--ref", "main", "--repo", "Uuriko/project-room",
  ]);
});

test("landing and rerun workflows merge or rerun without forging a status or deleting a run", () => {
  const pin = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
  const land = parse(readFileSync(new URL("../.github/workflows/land-ready.yml", import.meta.url), "utf8"));
  const rerun = parse(readFileSync(new URL("../.github/workflows/rerun-superseded.yml", import.meta.url), "utf8"));
  const schema = parse(readFileSync(new URL("../.github/workflows/schema-gate.yml", import.meta.url), "utf8"));
  const deploy = parse(readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8"));
  assert.equal(land.concurrency["cancel-in-progress"], false);
  assert.equal(land.concurrency.group, "land-ready");
  assert.deepEqual(Object.keys(land.jobs), ["land"]);
  assert.match(land.jobs.land.if, /workflow_run\.event == 'pull_request'/);
  assert.equal(land.jobs.land.steps.some(step => step.run?.includes("npm ci")), false);
  assert.ok(land.jobs.land.steps.some(step => step.uses?.startsWith(pin)));
  assert.match(land.jobs.land.steps.find(step => step.run).run, /node scripts\/repo-automations\.mjs land/);
  assert.equal(land.permissions.contents, "write");
  assert.equal(land.permissions.actions, "write");
  assert.ok(land.on.workflow_run.workflows.includes("test"));
  assert.ok(land.on.schedule[0].cron);

  assert.match(rerun.jobs.rerun.if, /conclusion == 'cancelled'/);
  assert.match(rerun.jobs.rerun.if, /event == 'pull_request'/);
  assert.equal(rerun.concurrency["cancel-in-progress"], false);
  assert.match(rerun.jobs.rerun.steps.find(step => step.run).run, /node scripts\/repo-automations\.mjs rerun/);
  assert.equal(rerun.permissions.actions, "write");
  assert.ok(rerun.jobs.rerun.steps.some(step => step.uses?.startsWith(pin)));

  assert.ok(Object.hasOwn(schema.on, "workflow_dispatch"));
  assert.deepEqual(deploy.on.schedule, [{ cron: "47 * * * *" }]);
  assert.match(deploy.jobs.gate.if, /github\.event_name == 'schedule'/);
  const gate = deploy.jobs.gate.steps.find(step => step.id === "gate").run;
  assert.match(gate, /node scripts\/repo-automations\.mjs deploy-candidate/);
  assert.match(gate, /event=push/);
  assert.match(gate, /EVENT" != "schedule"/);
  const receipt = deploy.jobs.deploy.steps.find(step => step.name === "Receipt to muse-room");
  assert.match(receipt.env.REASON, /hourly/);
  assert.match(receipt.env.REASON, /schedule/);

  const ruleset = JSON.parse(readFileSync(new URL("../.github/rulesets/main.json", import.meta.url), "utf8"));
  const queue = ruleset.rules.find(rule => rule.type === "merge_queue");
  const checks = ruleset.rules.find(rule => rule.type === "required_status_checks");
  assert.equal(ruleset.enforcement, "active");
  assert.deepEqual(ruleset.conditions.ref_name.include, ["refs/heads/main"]);
  assert.equal(queue.parameters.grouping_strategy, "HEADGREEN");
  assert.equal(queue.parameters.merge_method, "MERGE");
  assert.equal(queue.parameters.min_entries_to_merge, 2);
  assert.equal(queue.parameters.min_entries_to_merge_wait_minutes, 5);
  assert.equal(checks.parameters.strict_required_status_checks_policy, false);
  assert.deepEqual(checks.parameters.required_status_checks.map(item => item.context), [...HEAD_CHECK_NAMES]);
  assert.equal(JSON.stringify(ruleset).includes("room/release-lease"), false);

  for (const file of ["scripts/repo-automations.mjs", ".github/workflows/land-ready.yml", ".github/workflows/rerun-superseded.yml"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\/statuses/);
    assert.doesNotMatch(source, /run delete/);
    assert.doesNotMatch(source, /--admin/);
    assert.doesNotMatch(source, /run watch/);
  }
});
