// Node and the Worker read one registry. A job that runs on only one of
// them has to say why. Shared jobs keep one cadence.
import test from "node:test";
import assert from "node:assert/strict";
import { JOBS, jobsFor } from "../server/jobs.mjs";

test("node and worker job names match aside from single-runtime jobs", () => {
  const node = new Map(jobsFor("node").map(job => [job.name, job.cadenceMs]));
  const worker = new Map(jobsFor("worker").map(job => [job.name, job.cadenceMs]));
  const onlyNode = [...node.keys()].filter(name => !worker.has(name));
  const onlyWorker = [...worker.keys()].filter(name => !node.has(name));
  assert.deepEqual(onlyNode, ["growth-watch"]);
  assert.deepEqual(onlyWorker, ["room-backup"]);
  for (const name of [...onlyNode, ...onlyWorker]) {
    const job = JOBS.find(item => item.name === name);
    assert.equal(job.runtimes.length, 1);
    assert.equal(typeof job.singleRuntimeReason, "string");
    assert.ok(job.singleRuntimeReason.length > 20, name);
  }
  for (const [name, cadence] of node) {
    if (!worker.has(name)) continue;
    assert.equal(worker.get(name), cadence, name);
    assert.ok(cadence > 0, name);
  }
  const names = JOBS.map(job => job.name);
  assert.equal(new Set(names).size, names.length);
  for (const required of ["webhook-dispatch", "land-queue", "claim-prs", "retention", "integrity", "gmail-sync", "channel-drain", "growth-watch"]) {
    assert.ok(names.includes(required), required);
  }
});
