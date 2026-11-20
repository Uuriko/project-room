import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { runManagedExactReview } from "../client/managed-exact-review.mjs";

const connection = { origin: "https://room.example", roomId: "commons", memberId: "reviewer" };
const pointer = { tool: "room_read_result", arguments: { roomId: "commons", workItemId: "work", completionEventId: "current" } };
const packet = { viewerId: "reviewer", current: { completionEventId: "current", next: { memberId: "reviewer" } },
  review: { criteria: "Inspect archive.", action: { tool: "room_record_verification", arguments: {
    ...pointer.arguments, evidenceVersion: "sha256:some-digest", expectedRevision: 7 } } },
  result: { text: { body: "Archive succeeded." } }, workThread: { correction: { summary: "Archive previously failed." } } };
const verdict = { result: "pass", summary: "The exact archive passed.", provider: { sessionId: "turn-1" } };
const receipt = { eventId: "verdict-event", sequence: 12 };
function fixture(t) {
  const journalDirectory = mkdtempSync(join(realpathSync(tmpdir()), "managed-exact-review-"));
  t.after(() => rmSync(journalDirectory, { recursive: true, force: true }));
  return { connection, selection: pointer, journalDirectory, client: { workResult: async () => packet },
    execute: async () => verdict, receipt: async () => null, submit: async () => receipt };
}

test("wake and active pickup share the same admission, exact action and receipt", async t => {
  const options = fixture(t);
  let resume, entered, models = 0, writes = 0;
  const running = new Promise(resolve => entered = resolve);
  const parked = new Promise(resolve => resume = resolve);
  options.execute = async evidence => {
    models++; entered();
    await parked;
    assert.equal(evidence.priorFinding, "Archive previously failed.");
    return verdict;
  };
  options.submit = async args => {
    writes++;
    assert.equal(args.completionEventId, "current");
    assert.equal(args.expectedRevision, 7);
    assert.equal(args.evidenceVersion, "sha256:some-digest");
    return receipt;
  };
  const wake = runManagedExactReview({ ...options, selection: { nextRead: pointer, signalId: "wake-1" } });
  await running;
  const active = await runManagedExactReview(options);
  assert.equal(active.status, "already_claimed");
  resume();
  const completed = await wake;
  assert.equal(completed.operationId, active.operationId);
  assert.equal(completed.status, "recorded");
  assert.equal((await runManagedExactReview({ ...options, receipt: async () => receipt })).eventId, receipt.eventId);
  assert.equal(models, 1);
  assert.equal(writes, 1);
});

test("an old completion and stale verdict never rebase", async t => {
  const options = fixture(t);
  const old = { ...pointer, arguments: { ...pointer.arguments, completionEventId: "old" } };
  assert.equal((await runManagedExactReview({ ...options, selection: old, execute: assert.fail })).status, "review_unavailable");
  let submissions = 0;
  options.submit = async () => { submissions++; throw Object.assign(new Error(), { code: "stale_revision" }); };
  assert.equal((await runManagedExactReview(options)).status, "stale_revision");
  assert.equal((await runManagedExactReview(options)).status, "stale_revision");
  assert.equal(submissions, 1);
});

test("a committed verdict with a lost response recovers the original operation", async t => {
  const options = fixture(t);
  let operation;
  const result = await runManagedExactReview({ ...options,
    submit: async args => { operation = args.requestId; throw new Error("connection closed"); },
    receipt: async id => { assert.equal(id, operation); return receipt; } });
  assert.equal(result.eventId, receipt.eventId);
});

for (const phase of ["before-intent", "provider-may-have-started"]) {
  test("process interruption " + phase, async t => {
    const options = fixture(t);
    const code = `import {runManagedExactReview} from ${JSON.stringify(new URL("../client/managed-exact-review.mjs", import.meta.url).href)};
      const args = ${JSON.stringify({ connection, selection: pointer, journalDirectory: options.journalDirectory })};
      const halt = async () => { process.stdout.write("armed"); await new Promise(() => setInterval(() => {},1000)); };
      const execute = ${phase === "provider-may-have-started" ? "halt" : "() => {}"};
      ${phase === "before-intent" ? "execute.prepare = halt;" : ""}
      await runManagedExactReview({...args, execute, client:{workResult: async () => (${JSON.stringify(packet)})}});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => child.kill("SIGKILL"));
    const exited = once(child, "exit");
    assert.equal(String((await once(child.stdout, "data"))[0]), "armed");
    assert.equal((await runManagedExactReview(options)).status, "already_claimed");
    child.kill("SIGKILL");
    await exited;
    if (phase === "before-intent") assert.equal((await runManagedExactReview(options)).status, "recorded");
    else assert.equal((await runManagedExactReview({ ...options, execute: assert.fail })).status, "provider_start_uncertain");
  });
}
