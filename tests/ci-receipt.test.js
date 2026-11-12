import test from "node:test";
import assert from "node:assert/strict";
import { receiptId, verdictOf, receiptBody, runCiReceipt } from "../scripts/ci-receipt.mjs";

const repo = "Uuriko/project-room", SHA = "f5e8e226aa".padEnd(40, "0");
const run = (over = {}) => ({ id: 77, name: "test", event: "pull_request", conclusion: "success", head_sha: SHA,
  html_url: `https://github.com/${repo}/actions/runs/77`, ...over });
const passing = [{ name: "changes", conclusion: "success" }, { name: "unit", conclusion: "success" }, { name: "lint", conclusion: "success" },
  { name: "coverage", conclusion: "skipped" }, { name: "ci-verdict", conclusion: "success" }];

test("verdict: pass, fail, and the runs that say nothing", () => {
  assert.deepEqual(verdictOf(run(), passing), { verdict: "PASSED", failed: [], ran: 3, total: 4 });
  const bad = verdictOf(run({ conclusion: "failure" }), [...passing.slice(0, 2), { name: "browser-shards (2)", conclusion: "failure" }, { name: "unit ", conclusion: "cancelled" }]);
  assert.equal(bad.verdict, "FAILED"); assert.deepEqual(bad.failed, ["browser-shards (2)"]);
  assert.equal(verdictOf(run({ conclusion: "cancelled" }), passing), null, "a superseded run is not a verdict");
  assert.equal(verdictOf(run({ event: "push" }), passing), null);
  assert.equal(verdictOf(run(), [{ name: "changes", conclusion: "success" }, { name: "unit", conclusion: "skipped" }, { name: "ci-verdict", conclusion: "success" }]), null,
    "NOTHING RAN (no ready-to-land label) is not a test result");
});

test("body is compact and never carries pull request text; id is stable per head and verdict", () => {
  const body = receiptBody({ prNumber: 6162, headSha: SHA, result: { verdict: "FAILED", failed: ["unit", "lint"], ran: 4, total: 5 }, runUrl: run().html_url });
  assert.equal(body, `CI #6162 f5e8e226 FAILED unit, lint (2 of 5 jobs) · ${run().html_url}`);
  assert.ok(body.length < 160);
  assert.equal(receiptId(repo, 1, SHA, "PASSED"), receiptId(repo, 1, SHA, "PASSED"));
  assert.notEqual(receiptId(repo, 1, SHA, "PASSED"), receiptId(repo, 1, SHA, "FAILED"));
  assert.match(receiptId(repo, 1, SHA, "PASSED"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

function fakeFetch({ pulls, jobs = passing, roomStatus = [201], seen = [] } = {}) {
  let call = 0;
  return Object.assign(async (url, init = {}) => {
    seen.push({ url: String(url), init });
    const u = String(url);
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/actions/runs/77/jobs")) return json(200, { jobs });
    if (u.includes("/commits/") && u.includes("/pulls")) return json(200, pulls);
    if (u.includes("/api/rooms/")) { const status = roomStatus[Math.min(call++, roomStatus.length - 1)]; return json(status, status < 300 ? { sequence: 1, duplicate: false } : { error: "no" }); }
    throw new Error(`unexpected ${u}`);
  }, { seen });
}
const env = { GITHUB_TOKEN: "gh-token-value", ROOM_RECEIPT_TOKEN: "room-secret-value" };
const open = (over = {}) => ({ number: 6162, state: "open", head: { sha: SHA }, body: "", ...over });

test("posts one receipt to the room, attached to the Room-Work item, with no secret in the body", async () => {
  const f = fakeFetch({ pulls: [open({ body: "Room-Work: wk-digest\nsecret-looking text" })] });
  const out = await runCiReceipt({ event: { workflow_run: run() }, repo, env, fetchImpl: f });
  assert.equal(out.posted, true); assert.equal(out.attached, true);
  const post = f.seen.find(c => c.url.includes("/commands"));
  const sent = JSON.parse(post.init.body);
  assert.equal(sent.type, "message.posted"); assert.equal(sent.data.workItemId, "wk-digest");
  assert.equal(sent.id, sent.data.messageId); assert.match(sent.data.body, /^CI #6162 f5e8e226 PASSED 3\/4 jobs · https:\/\/github\.com\//);
  assert.ok(!sent.data.body.includes("secret"), "pull request text is not copied");
  assert.ok(!JSON.stringify(sent).includes(env.ROOM_RECEIPT_TOKEN) && !out.body.includes("token"));
  assert.equal(post.init.headers.authorization, `Bearer ${env.ROOM_RECEIPT_TOKEN}`);
});

test("a closed or unknown work item still gets the receipt, unattached; no pull request posts nothing", async () => {
  const f = fakeFetch({ pulls: [open({ body: "Room-Work: gone" })], roomStatus: [422, 201] });
  const out = await runCiReceipt({ event: { workflow_run: run() }, repo, env, fetchImpl: f });
  assert.deepEqual([out.posted, out.attached], [true, false]);
  assert.equal(f.seen.filter(c => c.url.includes("/commands")).length, 2);
  assert.equal(JSON.parse(f.seen.filter(c => c.url.includes("/commands"))[1].init.body).data.workItemId, undefined);
  const none = await runCiReceipt({ event: { workflow_run: run() }, repo, env, fetchImpl: fakeFetch({ pulls: [open({ state: "closed" })] }) });
  assert.match(none.skipped, /no open pull request/);
  const quiet = await runCiReceipt({ event: { workflow_run: run({ conclusion: "cancelled" }) }, repo, env, fetchImpl: fakeFetch({ pulls: [open()] }) });
  assert.match(quiet.skipped, /no verdict/);
  const noToken = await runCiReceipt({ event: { workflow_run: run() }, repo, env: { GITHUB_TOKEN: "x" }, fetchImpl: fakeFetch({ pulls: [open()] }) });
  assert.match(noToken.skipped, /ROOM_RECEIPT_TOKEN/);
});

test("a hard room failure is loud", async () => {
  const f = fakeFetch({ pulls: [open()], roomStatus: [500] });
  await assert.rejects(runCiReceipt({ event: { workflow_run: run() }, repo, env, fetchImpl: f }), /HTTP 500/);
});
