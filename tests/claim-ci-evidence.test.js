import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWork, claimWork } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { syncClaimPullRequests, collectPullRequestLookups, commitPullRequestLookup } from "../server/claim-pr-sync.mjs";
import { rollupClaimCi } from "../server/claim-coordination.mjs";

const NOW = Date.UTC(2026, 9, 11, 12);
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const URL = "https://github.com/acme/demo/pull/7";
const run = (id, name, conclusion = "success", extra = {}) => ({ id, name, head_sha: HEAD,
  status: "completed", conclusion, app: { id: 10 }, ...extra });

function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db);
  const hold = (id, number) => registry.set("room", claimWork(createWork({ id, pullRequest: `https://github.com/acme/demo/pull/${number}` }, { now: NOW, agentId: "owner" }), "owner", { now: NOW, leaseHours: null }));
  hold("ci", 7);
  for (let n = 1; n < (options.claimCount ?? 1); n++) hold(`ci-${n}`, 7 + n);
  const scene = { head: HEAD, runs: [run(1, "required")], statuses: [], required: [{ context: "required", app_id: 10 }], rules: [], workflows: [], ...options };
  scene.workflows = scene.workflows.map(row => ({ status: "completed", event: "pull_request", run_attempt: 1, ...row }));
  const calls = [];
  const fetchImpl = async input => {
    const url = new globalThis.URL(input);
    calls.push(url);
    const override = scene.respond?.(url);
    if (override) return override;
    const page = Number(url.searchParams.get("page") ?? 1);
    const size = Number(url.searchParams.get("per_page") ?? 30);
    const slice = rows => rows.slice((page - 1) * size, page * size);
    if (/\/pulls\/\d+$/.test(url.pathname)) return Response.json({ state: "open", head: { sha: scene.head }, base: { ref: "main" } }, { headers: { etag: '"pull"' } });
    if (url.pathname.endsWith("/status")) return Response.json({ state: scene.statuses.some(row => row.state === "failure") ? "failure" : "success", total_count: scene.statuses.length, statuses: slice(scene.statuses) });
    if (url.pathname.endsWith("/check-runs")) return Response.json({ total_count: scene.runs.length, check_runs: slice(scene.runs) });
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ total_count: scene.workflows.length, workflow_runs: slice(scene.workflows) });
    if (url.pathname.endsWith("/rules/branches/main")) return Response.json(slice(scene.rules));
    if (url.pathname.endsWith("/branches/main")) return Response.json({ name: "main", protected: true, protection: { required_status_checks: { checks: scene.required, contexts: scene.required.map(row => row.context) } } });
    throw new Error(`unexpected GitHub request ${url}`);
  };
  let tick = 0;
  const poll = async (token = null, advanceMs = 60_000) => {
    const before = calls.length;
    const summary = await syncClaimPullRequests({ db, workClaims: registry }, { fetchImpl, token, env: { CLAIM_PR_SEARCH_BATCH: "0" }, nowMs: NOW + tick });
    tick += advanceMs;
    assert.ok(calls.length - before <= (token ? 4 : 1), "every endpoint shares the existing per-tick budget");
    return summary;
  };
  const item = () => registry.get("room", "ci");
  const finish = async () => {
    for (let n = 0; n < 20; n++) { await poll(); if (item().pullRequest.ciCursor === "done") return item(); }
    assert.fail("CI read never completed within the bounded fixture");
  };
  return { db, registry, scene, calls, poll, item, finish, fetchImpl, hold, get now() { return NOW + tick; } };
}

test("anonymous ticks preserve status and a page-two required failure through durable reads", async t => {
  const f = fixture(t, { runs: [...Array.from({ length: 30 }, (_, i) => run(i + 1, `optional-${i}`)), run(31, "required", "failure")] });
  await f.poll();
  assert.equal(f.item().ci, null, "one PR lookup does not establish any CI verdict");
  await f.poll();
  assert.equal(f.item().ci, null, "combined status alone is incomplete");
  assert.equal((await f.finish()).ci.state, "failure");
  assert.ok(f.calls.some(url => url.pathname.endsWith("/check-runs") && url.searchParams.get("page") === "2"));
});

test("a failed required legacy context is retained while checks continue next tick", async t => {
  const f = fixture(t, { required: [{ context: "legacy", app_id: null }], statuses: [{ id: 10, context: "legacy", state: "failure", target_url: "https://ci.example/10" }] });
  assert.equal((await f.finish()).ci.state, "failure");
});

test("reruns supersede only the same app and workflow identity", () => {
  const result = rollupClaimCi({ checkRuns: [
    run(1, "required", "cancelled", { check_suite: { id: 11 } }),
    run(2, "required", "success", { check_suite: { id: 12 } })
  ], workflowRuns: [{ id: 1, check_suite_id: 11, workflow_id: 100 }, { id: 2, check_suite_id: 12, workflow_id: 100 }] });
  assert.equal(result.state, "success");
  const distinct = rollupClaimCi({ checkRuns: [run(1, "required", "failure", { app: { id: 10 } }), run(2, "required", "success", { app: { id: 20 } })] });
  assert.equal(distinct.state, "failure", "another app must not erase a failing check");
  const workflow = rollupClaimCi({ checkRuns: [run(1, "required", "failure", { check_suite: { id: 11 } }), run(2, "required", "success", { check_suite: { id: 12 } })], workflowRuns: [{ id: 1, check_suite_id: 11, workflow_id: 100 }, { id: 2, check_suite_id: 12, workflow_id: 200 }] });
  assert.equal(workflow.state, "failure", "same job name in another workflow is independent");
});

test("an optional failure is diagnostic, separate from configured required checks", () => {
  const result = rollupClaimCi({ checkRuns: [run(1, "required"), run(2, "optional", "failure")], requiredChecks: [{ context: "required", app_id: 10 }] });
  assert.equal(result.state, "failure");
  assert.equal(result.requiredState, "success");
});

test("head change during paginated reads invalidates the old evidence before publishing", async t => {
  const f = fixture(t);
  await f.poll(); await f.poll(); await f.poll();
  f.scene.head = NEXT;
  f.scene.runs = [run(2, "required", "failure", { head_sha: NEXT })];
  const completed = await f.finish();
  assert.equal(completed.ci.headSha, NEXT);
  assert.equal(completed.ci.state, "failure");
});

test("failed endpoints remain unknown and do not turn partial successes green", async t => {
  const f = fixture(t, { respond: url => url.pathname.endsWith("/check-runs") ? new Response("unavailable", { status: 503 }) : null });
  for (let i = 0; i < 8; i++) await f.poll();
  assert.equal(f.item().ci, null);
});

test("rate limits preserve earlier evidence and stop all core calls until reset", async t => {
  let limited = false;
  const f = fixture(t, { required: [{ context: "legacy", app_id: null }], statuses: [{ id: 1, context: "legacy", state: "failure" }], respond: url => {
    if (url.pathname.endsWith("/check-runs") && !limited) { limited = true; return new Response("", { status: 429, headers: { "retry-after": "120" } }); }
    return null;
  } });
  await f.poll(); await f.poll();
  assert.equal((await f.poll()).rateLimited, true);
  const count = f.calls.length;
  await f.poll(); assert.equal(f.calls.length, count);
  assert.equal((await f.finish()).ci.state, "failure");
});

test("ruleset required contexts and unavailable policy are fail closed", async t => {
  const f = fixture(t, { rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ruleset-check", integration_id: 10 }] } }] });
  assert.equal((await f.finish()).ci.state, "pending", "a missing ruleset check cannot pass");
  const blocked = fixture(t, { respond: url => url.pathname.endsWith("/rules/branches/main") ? new Response("", { status: 404 }) : null });
  for (let i = 0; i < 12; i++) await blocked.poll();
  assert.equal(blocked.item().ci, null, "an unreadable policy is not no policy");
});


test("completed optional failure remains diagnostic without changing required CI", async t => {
  const f = fixture(t, { runs: [run(1, "required"), run(2, "optional", "failure")] });
  assert.equal((await f.finish()).ci.state, "success");
  const rows = f.db.prepare("SELECT config_json FROM work_claim_config").all().map(row => JSON.parse(row.config_json));
  assert.equal(rows.find(row => row.url === URL).diagnosticState, "failure");
});

test("token polling cannot publish a first-page success before later evidence and head validation", async t => {
  const f = fixture(t, { runs: [...Array.from({ length: 30 }, (_, i) => run(i + 1, `optional-${i}`)), run(31, "required", "failure")] });
  await f.poll("test-token");
  assert.equal(f.item().ci, null);
  assert.equal((await f.finish()).ci.state, "failure");
});

test("a GitHub Actions rerun is matched through the workflow ID, not job name alone", async t => {
  const f = fixture(t, { runs: [run(1, "required", "cancelled", { app: { id: 10, slug: "github-actions" }, check_suite: { id: 11 } }), run(2, "required", "success", { app: { id: 10, slug: "github-actions" }, check_suite: { id: 12 } })], workflows: [{ id: 1, check_suite_id: 11, workflow_id: 7, head_sha: HEAD }, { id: 2, check_suite_id: 12, workflow_id: 7, head_sha: HEAD }] });
  assert.equal((await f.finish()).ci.state, "success");
});

test("an expired cursor re-reads the PR without relying on a detached ETag", async t => {
  const f = fixture(t);
  await f.poll(null, 31 * 60_000);
  f.scene.head = NEXT;
  f.scene.runs = [run(2, "required", "failure", { head_sha: NEXT })];
  await f.poll();
  assert.equal(f.item().ci, null, "expired evidence yields priority and enters normal backoff");
  await f.poll(null, 11 * 60_000);
  const item = await f.finish();
  assert.equal(item.ci.headSha, NEXT);
  assert.equal(item.ci.state, "failure");
  assert.equal(f.calls.filter(url => url.pathname.endsWith("/pulls/7")).length, 3);
});

test("a 304 pull response refreshes checks; it does not preserve a stale green", async t => {
  const f = fixture(t);
  assert.equal((await f.finish()).ci.state, "success");
  f.scene.runs = [run(2, "required", "failure")];
  f.scene.respond = url => url.pathname.endsWith("/pulls/7") ? new Response(null, { status: 304 }) : null;
  await f.poll(null, 11 * 60_000);
  await f.poll();
  assert.equal(f.item().ci, null);
  assert.equal((await f.finish()).ci.state, "failure");
});

test("policy denial, truncated pagination and oversized check sets cannot produce success", async t => {
  for (const [name, respond] of [
    ["classic policy denied", url => url.pathname.endsWith("/branches/main") ? new Response("", { status: 403 }) : null],
    ["truncated check page", url => url.pathname.endsWith("/check-runs") ? Response.json({ total_count: 20, check_runs: [run(1, "required")] }) : null],
    ["more than the bounded total", url => url.pathname.endsWith("/check-runs") ? Response.json({ total_count: 301, check_runs: [run(1, "required")] }) : null]
  ]) {
    await t.test(name, async t => {
      const f = fixture(t, { respond });
      for (let n = 0; n < 8; n++) await f.poll();
      assert.equal(f.item().ci, null);
    });
  }
});


test("a late completed observation cannot overwrite a newer stored head", async t => {
  const f = fixture(t);
  const before = f.item();
  const store = { db: f.db, workClaims: f.registry };
  const batch = await collectPullRequestLookups([before], { store, fetchImpl: f.fetchImpl, token: "test-token", limit: 10, nowMs: NOW });
  const newer = { ...before, ci: { state: "failure", headSha: NEXT, checkedAt: new Date(NOW + 1).toISOString() }, pullRequest: { ...before.pullRequest, syncedAt: new Date(NOW + 1).toISOString() } };
  f.registry.set("room", newer);
  assert.equal(commitPullRequestLookup(store, f.registry, "room", before, batch.results[0], NOW + 2), false);
  assert.equal(f.item().ci.headSha, NEXT);
});


test("a newer queued workflow invalidates old success before jobs exist; optional workflows remain separate", async t => {
  for (const retry of [false, true]) {
    const old = { id: 1, check_suite_id: 11, workflow_id: 7, head_sha: HEAD, status: "completed", run_attempt: 1 };
    const queued = { ...old, id: retry ? 1 : 2, check_suite_id: retry ? 11 : 12, status: "queued", run_attempt: retry ? 2 : 1 };
    const f = fixture(t, { runs: [run(1, "required", "success", { app: { id: 10, slug: "github-actions" }, check_suite: { id: 11 } })], workflows: retry ? [queued] : [queued, old] });
    assert.equal((await f.finish()).ci.state, "pending", retry ? "same workflow retry" : "new workflow execution");
  }
  const unrelated = fixture(t, { runs: [run(1, "required", "success", { app: { id: 10, slug: "github-actions" }, check_suite: { id: 11 } })], workflows: [{ id: 2, check_suite_id: 12, workflow_id: 8, head_sha: HEAD, status: "queued" }, { id: 1, check_suite_id: 11, workflow_id: 7, head_sha: HEAD, status: "completed" }] });
  assert.equal((await unrelated.finish()).ci.state, "success");
});

test("workflow pagination keeps real-sized repository metadata under the body cap", async t => {
  const f = fixture(t, { runs: [run(1, "required", "success", { app: { id: 10, slug: "github-actions" }, check_suite: { id: 11 } })], workflows: Array.from({ length: 7 }, (_, index) => ({ id: index + 1, check_suite_id: index + 11, workflow_id: index + 7, head_sha: HEAD, repository: { description: "x".repeat(13_000) } })) });
  assert.equal((await f.finish()).ci.state, "success");
  assert.ok(f.calls.filter(url => url.pathname.endsWith("/actions/runs")).length > 1);
});


test("a completed retry between check and workflow reads recollects stale jobs", async t => {
  for (const conclusion of ["failure", "success"]) {
    const workflow = { id: 1, check_suite_id: 11, workflow_id: 7, head_sha: HEAD, status: "completed", run_attempt: 1, run_started_at: "2026-10-11T11:00:00Z" };
    const f = fixture(t, { runs: [run(1, "required", "success", { started_at: "2026-10-11T11:00:00Z", app: { id: 10, slug: "github-actions" }, check_suite: { id: 11 } })], workflows: [workflow] });
    await f.poll(); await f.poll(); await f.poll();
    // A failed-only retry may leave this successful job untouched. Both the
    // newly failed and unchanged successful cases need a fresh observation.
    if (conclusion === "failure") f.scene.runs = [run(2, "required", "failure", { started_at: "2026-10-11T12:02:30Z", app: { id: 10, slug: "github-actions" }, check_suite: { id: 11 } })];
    f.scene.workflows = [{ ...workflow, run_attempt: 2, run_started_at: "2026-10-11T12:02:30Z", conclusion: "failure" }];
    const result = await f.finish();
    assert.equal(result.ci.state, conclusion);
    assert.equal(f.calls.filter(url => url.pathname.endsWith("/check-runs")).length, 2);
  }
});

test("malformed app-bound policy cannot fall back to unbound legacy contexts", async t => {
  const f = fixture(t, { required: [{ context: "required", app_id: "broken-app-id" }] });
  for (let n = 0; n < 8; n++) await f.poll();
  assert.equal(f.item().ci, null);
});


test("an anonymous backlog completes its current cursor before fresh claims can expire it", async t => {
  const f = fixture(t, { claimCount: 33 });
  assert.equal((await f.finish()).ci.state, "success");
  assert.ok(f.calls.length < 10, "the current bounded read finishes before starting the backlog");
});

test("a continuously changing head relinquishes continuation priority so older fresh work progresses", async t => {
  const f = fixture(t, { claimCount: 2 });
  f.scene.respond = url => {
    if (url.pathname.endsWith("/pulls/7")) {
      f.scene.head = f.scene.head === HEAD ? NEXT : HEAD;
      f.scene.runs = [run(1, "required", "success", { head_sha: f.scene.head })];
    }
    return null;
  };
  for (let n = 0; n < 38; n++) {
    f.hold(`arrival-${n}`, 100 + n);
    await f.poll();
    if (f.registry.get("room", "ci-1").ci) break;
  }
  assert.equal(f.item().ci, null, "the changing head never acquires a green verdict");
  assert.equal(f.registry.get("room", "ci-1").ci?.state, "success", "continuation cannot starve existing fresh work under sustained arrivals");
});
