// Successful request logs are sampled. Errors are not. The platform head
// sample stays at 1; dropping it would discard the error lines too.
import test from "node:test";
import assert from "node:assert/strict";
import { logRoomRequest, shouldSampleRequestLog, SUCCESS_REQUEST_LOG_RATE } from "../cloudflare/request-timing.mjs";

test("a completed success is kept at the sample rate and every other status is kept", () => {
  assert.equal(SUCCESS_REQUEST_LOG_RATE, 0.1);
  const random = () => 0.09;
  assert.equal(shouldSampleRequestLog(200, random), true);
  assert.equal(shouldSampleRequestLog(204, () => 0.1), false);
  assert.equal(shouldSampleRequestLog(304, () => 0.5), false);
  for (const status of [199, 400, 401, 404, 409, 429, 500, 0, null, undefined]) {
    assert.equal(shouldSampleRequestLog(status, () => 1), true, String(status));
  }
});

test("one hundred successes emit about ten lines and every error is emitted", () => {
  const lines = [];
  const info = console.info;
  console.info = line => lines.push(line);
  try {
    let i = 0;
    const random = () => (i += 1) / 100;
    for (let n = 0; n < 100; n += 1) logRoomRequest({ method: "GET", path: "/api/health", status: 200, totalMs: 3, servedBy: "edge" }, random);
    for (const status of [400, 500, 401]) logRoomRequest({ method: "POST", path: "/api/rooms/r/commands", status, totalMs: 4, servedBy: "object" }, () => 1);
  } finally {
    console.info = info;
  }
  const parsed = lines.map(line => JSON.parse(line));
  assert.equal(parsed.filter(entry => entry.status === 200).length, 9);
  assert.deepEqual(parsed.filter(entry => entry.status !== 200).map(entry => entry.status), [400, 500, 401]);
  assert.equal(parsed.every(entry => entry.event === "room.request" && !("url" in entry)), true);
});
