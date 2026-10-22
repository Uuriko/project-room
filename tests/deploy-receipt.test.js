// Issue #3897, secondary leg: the deploy receipt must be recorded through a
// GitHub-side channel that does not depend on the production API it reports
// on, and a delivery failure must be visible instead of swallowed by
// continue-on-error. These tests execute the actual CLI the workflow runs
// (scripts/deploy-receipt.mjs record | deliver) against a healthy fake room
// API and against a dead one.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceiptBody } from "../scripts/deploy-receipt.mjs";

const execFileAsync = promisify(execFile);
const script = new URL("../scripts/deploy-receipt.mjs", import.meta.url).pathname;
const SHA = "a".repeat(40);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-receipt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseEnv(dir, extra = {}) {
  return {
    ...process.env,
    RUNNER_TEMP: dir,
    RECEIPT_DIR: join(dir, "receipt"),
    SHA,
    OUTCOME: "success",
    PROD_ORIGIN: "http://127.0.0.1:9",
    RECEIPT_ROOM: "muse-room",
    PROD_NEW: "11111111-2222-4333-8444-555555555555",
    ENTRY_NEW: "66666666-7777-4888-8999-000000000000",
    PROD_PRE: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ENTRY_PRE: "ffffffff-1111-4222-8333-444444444444",
    RUN_URL: "https://example.invalid/actions/runs/1",
    REASON: "",
    PROBE_OVERRIDE: "",
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    GITHUB_OUTPUT: join(dir, "output.txt"),
    ...extra,
  };
}

async function cli(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function fakeRoomApi(t) {
  const requests = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: data ? JSON.parse(data) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

async function deadOrigin(t) {
  const server = createServer(() => {});
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return `http://127.0.0.1:${port}`;
}

test("receipt body format is unchanged for success and recovery shapes", () => {
  const env = baseEnv("/unused");
  assert.equal(
    buildReceiptBody(env, null),
    `PROD DEPLOY aaaaaaaa · prod 11111111 (rollback aaaaaaaa) · entry 66666666 (rollback ffffffff) · smoke ok · ${env.RUN_URL}`,
  );
  const recovery = { status: "ROLLBACK VERIFIED", workers: { prod: { disposition: "rollback_verified", previousCodeSchemaVersion: 37, candidateCodeSchemaVersion: 38, previousVersionId: "v-old" } } };
  const body = buildReceiptBody(env, recovery);
  assert.match(body, /^PROD DEPLOY aaaaaaaa FAILED · ROLLBACK VERIFIED · prod: rollback_verified/);
  assert.doesNotMatch(body, /FAILED · rolled back/);
});

test("healthy API: record is durable first, delivery posts exactly the recorded body", async t => {
  const dir = tempDir(t);
  const api = await fakeRoomApi(t);
  const env = baseEnv(dir, { PROD_ORIGIN: api.origin, ROOM_RECEIPT_TOKEN: "present" });

  const recorded = await cli(["record"], env);
  assert.equal(recorded.code, 0, recorded.stderr);
  const recordPath = join(dir, "receipt", "deploy-receipt.json");
  const before = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(before.delivery.status, "pending");
  assert.equal(readFileSync(join(dir, "receipt", "deploy-receipt.txt"), "utf8"), before.body + "\n");
  assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /Deploy receipt \(durable record\)/);
  assert.match(readFileSync(join(dir, "output.txt"), "utf8"), /record=ok/);

  const delivered = await cli(["deliver"], env);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.match(delivered.stdout, /receipt: HTTP 200/);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].method, "POST");
  assert.equal(api.requests[0].url, "/api/rooms/muse-room/commands");
  assert.equal(api.requests[0].body.type, "message.posted");
  assert.equal(api.requests[0].body.data.body, before.body);
  const after = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(after.delivery.status, "posted");
  assert.equal(after.delivery.httpStatus, 200);
});

test("dead API: the durable record still exists and the delivery failure is visible", async t => {
  const dir = tempDir(t);
  const env = baseEnv(dir, { PROD_ORIGIN: await deadOrigin(t), ROOM_RECEIPT_TOKEN: "present" });

  const recorded = await cli(["record"], env);
  assert.equal(recorded.code, 0, recorded.stderr);
  const recordPath = join(dir, "receipt", "deploy-receipt.json");
  const before = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.ok(before.body.length > 0, "record produced the receipt body without any production API");

  const delivered = await cli(["deliver"], env);
  assert.notEqual(delivered.code, 0, "delivery against a dead API must fail the step (the workflow keeps the job green via continue-on-error)");
  assert.match(delivered.stdout + delivered.stderr, /::error title=deploy receipt delivery failed::/);
  const after = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(after.delivery.status, "failed");
  assert.ok(after.delivery.error, "the failure reason is written into the durable record");
  assert.equal(after.body, before.body, "the recorded receipt itself is untouched by the failed delivery");
  assert.match(readFileSync(join(dir, "output.txt"), "utf8"), /delivery=failed/);
});

test("no token: delivery is explicitly skipped and the record stands", async t => {
  const dir = tempDir(t);
  const env = baseEnv(dir, { ROOM_RECEIPT_TOKEN: "" });
  const recorded = await cli(["record"], env);
  assert.equal(recorded.code, 0, recorded.stderr);
  const delivered = await cli(["deliver"], env);
  assert.equal(delivered.code, 0, delivered.stderr);
  const after = JSON.parse(readFileSync(join(dir, "receipt", "deploy-receipt.json"), "utf8"));
  assert.equal(after.delivery.status, "skipped-no-token");
});

test("recovery receipt: record reads deploy-recovery.json from the runner temp dir", async t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "deploy-recovery.json"), JSON.stringify({
    status: "ROLLBACK VERIFIED",
    workers: { prod: { disposition: "rollback_verified", previousCodeSchemaVersion: 37, candidateCodeSchemaVersion: 38, previousVersionId: "v-old" } },
  }));
  const env = baseEnv(dir, { OUTCOME: "failure" });
  const recorded = await cli(["record"], env);
  assert.equal(recorded.code, 0, recorded.stderr);
  const record = JSON.parse(readFileSync(join(dir, "receipt", "deploy-receipt.json"), "utf8"));
  assert.match(record.body, /^PROD DEPLOY aaaaaaaa FAILED · ROLLBACK VERIFIED/);
  assert.equal(record.recovery.status, "ROLLBACK VERIFIED");
});
