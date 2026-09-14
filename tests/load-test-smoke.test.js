// BUILD-01 E1: the load-test script must stay runnable. A tiny configuration
// (3 streams, 5 messages, 5 wakes) proves the streams and wake-queue modes exit 0
// with parseable JSON on stdout, and that the legacy positional mode is intact.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/load-test.mjs", import.meta.url));
const run = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 60000 });

test("streams and queue modes finish in a tiny configuration with parseable JSON", () => {
  const result = run(["--mode", "all", "--streams", "3", "--messages", "5", "--message-interval-ms", "20", "--stream-interval-ms", "50",
    "--wakes", "5", "--wake-interval-ms", "1", "--poll-ms", "10", "--agents", "2", "--iterations", "1", "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "all");
  assert.equal(report.streams.streamsOpen, 3);
  assert.deepEqual(report.streams.openFailures, {});
  assert.equal(report.streams.posted, 5);
  assert.equal(report.streams.deliveries.expected, 15);
  assert.equal(report.streams.deliveries.received, 15, "every message reaches every open stream");
  assert.equal(report.streams.closedByServer.count, 0);
  assert.equal(report.streams.deliveryLatencyMs.count, 15);
  assert.ok(report.streams.deliveryLatencyMs.p95 >= 0);
  assert.equal(report.streams.deliveryHistogram.reduce((n, b) => n + b.count, 0), 15);
  assert.equal(report.queue.enqueued, 5);
  assert.equal(report.queue.leased, 5);
  assert.equal(report.queue.completed, 5);
  assert.deepEqual(report.queue.errors, {});
  assert.equal(report.queue.lagMs.count, 5);
  assert.equal(report.queue.lagHistogram.reduce((n, b) => n + b.count, 0), 5);
  assert.equal(report.commands.agents, 2);
  assert.ok(report.commands.ops > 0);
  assert.equal(result.stderr.split("\n").filter(line => line && !line.startsWith("room diagnostic")).length, 0, "--quiet prints no table");
});

test("legacy positional mode still prints the flat JSON blob", () => {
  const result = run(["2", "1"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.agents, 2);
  assert.equal(report.iterations, 1);
  assert.ok(report.ops > 0);
  assert.equal(typeof report.latencyMs.p95, "string");
});

test("bad flags fail fast with usage", () => {
  for (const args of [["--mode", "nope"], ["--streams", "0"], ["--streams", "100"], ["--bogus", "1"], ["--messages"]]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /Usage:/);
  }
});
