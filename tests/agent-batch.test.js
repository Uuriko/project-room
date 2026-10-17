import test from "node:test";
import assert from "node:assert/strict";
import { runAgentBatch } from "../client/agent-batch.mjs";
import { batchCommand } from "../cli/commands/batch.mjs";

const commands = n => Array.from({ length: n }, (_, i) => ({ id: `command-${i}`, type: "message.posted",
  data: { messageId: `message-${i}`, body: `Independent message ${i}` } }));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("overlaps independent requests, bounds concurrency and preserves input order", async () => {
  const release = gate(), started = gate();
  let active = 0, peak = 0;
  const client = { async command(command) {
    active++; peak = Math.max(peak, active);
    if (active === 3) started.resolve();
    await release.promise; active--;
    return { sequence: Number(command.id.split("-")[1]) + 1, duplicate: false };
  } };
  const run = runAgentBatch(client, commands(9), { concurrency: 3 });
  await started.promise;
  assert.equal(peak, 3, "three requests start before any is released");
  release.resolve();
  const report = await run;
  assert.equal(peak, 3);
  assert.deepEqual(report.counts, { accepted: 9, rejected: 0, unknown: 0, not_sent: 0 });
  assert.deepEqual(report.results.map(row => row.id), commands(9).map(row => row.id));
});

test("rejects malformed batches before any command is sent", async () => {
  let writes = 0;
  const client = { command() { writes++; } };
  for (const input of [[], commands(101), [commands(1)[0], commands(1)[0]],
    [...commands(2), { id: "bad", type: "unknown", data: {} }], [{ ...commands(1)[0], token: "private" }]])
    await assert.rejects(runAgentBatch(client, input));
  await assert.rejects(runAgentBatch(client, commands(1), { concurrency: 9 }));
  assert.equal(writes, 0);
});

test("known individual conflicts don't prevent unrelated commands", async () => {
  const called = [];
  const report = await runAgentBatch({ async command(c) {
    called.push(c.id);
    if (c.id === "command-1") throw Object.assign(new Error("conflict"), { status: 409, code: "revision_conflict" });
    return { sequence: called.length, duplicate: false };
  } }, commands(4), { concurrency: 1 });
  assert.equal(called.length, 4);
  assert.deepEqual(report.counts, { accepted: 3, rejected: 1, unknown: 0, not_sent: 0 });
});

test("uncertain outcomes stop queued work without retries or invented success", async () => {
  let writes = 0;
  const report = await runAgentBatch({ async command() { writes++; throw new Error("Secret must not leak into output"); } }, commands(4), { concurrency: 1 });
  assert.equal(writes, 1);
  assert.deepEqual(report.counts, { accepted: 0, rejected: 0, unknown: 1, not_sent: 3 });
  assert.equal(report.results[0].code, "request_unconfirmed");
  assert.ok(!JSON.stringify(report).includes("Secret"));
});

test("throttling stops the queue and retains retry delay; already-started work settles", async () => {
  const release = gate(); let writes = 0;
  const report = await runAgentBatch({ async command(c) {
    writes++;
    if (c.id === "command-0") { release.resolve(); throw Object.assign(new Error("throttle"), { status: 429, code: "rate_limited", retryAfterMs: 1000 }); }
    await release.promise; return { sequence: 7, duplicate: false };
  } }, commands(5), { concurrency: 2 });
  assert.equal(writes, 2);
  assert.deepEqual(report.counts, { accepted: 1, rejected: 1, unknown: 0, not_sent: 3 });
  assert.equal(report.results[0].retryAfterMs, 1000);
});

test("cancelled batches distinguish unsent work and an in-flight unknown outcome", async () => {
  const controller = new AbortController();
  const report = await runAgentBatch({ async command() { controller.abort(); throw new Error("aborted after send"); } }, commands(3), { concurrency: 1, signal: controller.signal });
  assert.deepEqual(report.counts, { accepted: 0, rejected: 0, unknown: 1, not_sent: 2 });
  const untouched = await runAgentBatch({ command() { assert.fail("must not start"); } }, commands(2), { signal: controller.signal });
  assert.equal(untouched.counts.not_sent, 2);
});

test("CLI returns compact receipts with stable IDs and no response bodies", async () => {
  const printed = [], input = commands(2), called = [];
  const code = await batchCommand(["--file", "actions.json", "--concurrency", "2"], {
    readFile: async () => JSON.stringify(input), out: text => printed.push(text),
    client: { async command(c) { called.push(c); return { sequence: 42, duplicate: true, event: { body: "private payload" } }; } }
  });
  assert.equal(code, 0);
  assert.deepEqual(called, input);
  assert.equal(JSON.parse(printed[0]).results[0].duplicate, true);
  assert.ok(!printed[0].includes("private payload"));
  await assert.rejects(batchCommand(["--file", "actions.json", "--bogus", "1"], { out() {} }));
});

test("malformed success receipts are unknown, not accepted", async () => {
  const report = await runAgentBatch({ async command() { return { ok: true }; } }, commands(3), { concurrency: 1 });
  assert.deepEqual(report.counts, { accepted: 0, rejected: 0, unknown: 1, not_sent: 2 });
  assert.equal(report.results[0].code, "invalid_response");
});
