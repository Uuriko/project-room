// PERF-F-S5 cure: a swallowed or failed request-runs read must recover
// promptly, not wait for the 60s forced backstop (which exceeds the
// chat-performance browser check's 30s budget).
// refreshRequestRuns lives in browser wiring with no unit harness, so this
// test extracts the function from src/app.js and runs it against stubs —
// the same source-as-contract approach as client-polling-cadence.test.js,
// extended to behaviour: a failed first read is retried by the next
// unforced refresh, and the read never joins a stale in-flight GET.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const start = app.indexOf("async function refreshRequestRuns");
const end = app.indexOf("\n}\n", start);
assert.ok(start >= 0 && end > start, "refreshRequestRuns is extractable from src/app.js");
const functionSource = app.slice(start, end + 3);

function loadHarness() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`
    let requestRuns = {}, requestRunsReading = false, requestRunsReadKey = "";
    let state = { replyRequests: { q1: { id: "q1", status: "open" } }, room: { id: "room1" } };
    let session = { member: { id: "me" } };
    const calls = [];
    const behaviour = { fail: false, block: null };
    const client = { generation: 1, path: suffix => "/api/rooms/room1" + suffix,
      request: async (path, options) => {
        calls.push({ path, options: options ?? null });
        if (behaviour.block) await behaviour.block;
        if (behaviour.fail) throw new Error("read failed");
        return { roomId: "room1", viewerId: "me", runs: { q1: { state: "working", updatedAt: 1000 } } };
      } };
    const document = { hidden: false, querySelectorAll: () => [] };
    function requestRunLabel(id) { return ""; }
    ${functionSource}
    globalThis.control = {
      calls, refreshRequestRuns,
      setFail(value) { behaviour.fail = value; },
      blockOn(promise) { behaviour.block = promise; },
      addRequest(id) { state.replyRequests[id] = { id, status: "open" }; },
      readKey: () => requestRunsReadKey,
    };
  `, sandbox);
  return sandbox.control;
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1)); };

test("a failed request-runs read is retried by the next unforced refresh", async () => {
  const control = loadHarness();
  control.setFail(true);
  await control.refreshRequestRuns();
  assert.equal(control.calls.length, 1, "first read attempted");
  control.setFail(false);
  await control.refreshRequestRuns();
  assert.equal(control.calls.length, 2,
    "the dedupe key must not be spent by a failed read — the next unforced refresh (10s tick) retries it well inside the forced 60s backstop");
  await control.refreshRequestRuns();
  assert.equal(control.calls.length, 2, "a successful read still dedupes an unchanged open-request set");
});

test("the request-runs read is fresh, so it cannot join a stale in-flight GET", async () => {
  const control = loadHarness();
  await control.refreshRequestRuns();
  assert.equal(control.calls.length, 1);
  assert.equal(control.calls[0].options?.fresh, true,
    "a GET issued before the new request arrived would resolve with stale runs and issue no network read; the prompt read must bypass the GET flight cache");
});

test("a request arriving during an in-flight read is fetched when that read completes", async () => {
  const control = loadHarness();
  let release;
  control.blockOn(new Promise(resolve => { release = resolve; }));
  const pending = control.refreshRequestRuns();
  await flush();
  assert.equal(control.calls.length, 1, "first read in flight");
  control.addRequest("q2");
  await control.refreshRequestRuns();
  assert.equal(control.calls.length, 1, "no parallel read while one is in flight");
  control.blockOn(null);
  release();
  await pending;
  await flush();
  assert.equal(control.calls.length, 2, "the changed key is read promptly once the in-flight read completes");
});
