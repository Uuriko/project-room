import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { retryDelay, watchLoop, writeJson } from "../scripts/agent-watch.mjs";
import { RoomAgentClient, RoomClientError } from "../client/room-agent.mjs";
import { WatchError, WatchJournal } from "../client/watch-journal.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event, replay } from "../src/events.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = new URL("../scripts/agent-inbox.mjs", import.meta.url);
const origin = "https://room.example";
const roomId = "commons";
const token = "T".repeat(43); // Synthetic credential; no test performs a network request.
const jsonLines = text => text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
const hasCode = code => error => error instanceof WatchError && error.code === code;

function privateDirectory(t) {
  const parent = mkdtempSync(join(tmpdir(), "room-watch-cli-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return join(parent, "private-state");
}

function fixture(withWork = false) {
  const events = initialRoom(roomId, "owner");
  if (withWork) events.push(event({ type: T.WORK_PROPOSED, actorId: "owner", roomId, data: {
    workItemId: "work-one", title: 'Review "one"\nline', definitionOfDone: "PRIVATE_DEFINITION_NOT_A_NOTICE",
    accountableMemberId: "owner", mode: "read"
  } }));
  return { events, snapshot: { roomId, sequence: events.length, viewerId: "owner", viewerAccountId: "account-owner",
    viewerAuthEpoch: 0, state: replay(events) } };
}

// Import the actual CLI in a subprocess, but replace fetch before import. Unknown
// reads and all writes are hard failures, never fall through to the real network.
function runCli(args, { data, credentials = false, failure } = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("ROOM_AGENT_") || name === "NODE_OPTIONS") delete env[name];
  if (credentials) Object.assign(env, { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: roomId, ROOM_AGENT_TOKEN: token });
  const source = `
    const data = ${JSON.stringify(data ?? null)};
    globalThis.fetch = async (input, options) => {
      if (${JSON.stringify(failure ?? null)}) throw new Error(${JSON.stringify(failure ?? null)});
      if (!data) { process.stderr.write("FORBIDDEN_NETWORK\\n"); throw new Error("Unexpected fetch"); }
      const url = new URL(input);
      if (url.origin !== ${JSON.stringify(origin)} || options.method !== "GET"
          || options.credentials !== "omit" || options.redirect !== "error"
          || options.headers.Authorization !== ${JSON.stringify(`Bearer ${token}`)}) {
        process.stderr.write("FORBIDDEN_REQUEST\\n"); throw new Error("Unexpected request");
      }
      if (url.pathname === "/api/rooms/commons" && !url.search) return Response.json(data.snapshot);
      if (url.pathname === "/api/rooms/commons/events") {
        const after = Number(url.searchParams.get("after")), limit = Number(url.searchParams.get("limit"));
        const events = data.events.map((event, i) => ({ sequence: i + 1, event })).slice(after, after + limit);
        return Response.json({ events, next: events.at(-1)?.sequence ?? after, hasMore: after + limit < data.events.length });
      }
      process.stderr.write("FORBIDDEN_REQUEST\\n"); throw new Error("Unexpected route");
    };
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(cli.href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root, env, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_NETWORK|FORBIDDEN_REQUEST/);
  return result;
}

test("top-level and watcher help discover the notify-only foreground workflow without credentials", () => {
  const top = runCli(["--help"]);
  assert.equal(top.status, 0); assert.equal(top.stderr, "");
  assert.match(top.stdout, /watch --help/);
  const result = runCli(["watch", "--help"]);
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  for (const text of ["watch start", "watch status", "watch stop", "--once", "Foreground only", "stdout", "stderr", "not permission to act"])
    assert.ok(result.stdout.includes(text), text);
});

test("invalid watcher syntax returns one sanitized stderr record and creates no state", t => {
  const directory = privateDirectory(t);
  for (const args of [[], ["start"], ["unknown", directory], ["status", directory, "--once"],
    ["start", directory, "--wrong"], ["start", "--once"], ["start", directory, "--once", "extra"]]) {
    const result = runCli(["watch", ...args]);
    assert.equal(result.status, 1, JSON.stringify(args)); assert.equal(result.stdout, "");
    const errors = jsonLines(result.stderr);
    assert.equal(errors.length, 1); assert.equal(errors[0].type, "watch_error"); assert.equal(errors[0].code, "usage_error");
    assert.equal(existsSync(directory), false);
  }
});

test("status and stop need no credentials and do not bootstrap missing state", t => {
  const directory = privateDirectory(t);
  for (const action of ["status", "stop"]) {
    const result = runCli(["watch", action, directory]);
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(jsonLines(result.stderr)[0].code, "state_not_found");
    assert.equal(existsSync(directory), false);
  }
});

test("local status and stop use one stdout result and distinguish requested stop from stopped", t => {
  const directory = privateDirectory(t), journal = new WatchJournal(directory);
  t.after(() => journal.close());
  const status = runCli(["watch", "status", directory]);
  assert.equal(status.status, 0); assert.equal(status.stderr, "");
  assert.equal(jsonLines(status.stdout).length, 1); assert.equal(jsonLines(status.stdout)[0].state, "held");
  const stop = runCli(["watch", "stop", directory]);
  assert.equal(stop.status, 0); assert.equal(stop.stderr, "");
  assert.equal(jsonLines(stop.stdout).length, 1); assert.equal(jsonLines(stop.stdout)[0].state, "stop_requested");
  assert.equal(journal.shouldStop(), true);
  journal.close();
  const stopped = runCli(["watch", "status", directory]);
  assert.equal(stopped.status, 0); assert.equal(stopped.stderr, "");
  assert.equal(jsonLines(stopped.stdout)[0].state, "stopped");
  assert.equal(jsonLines(stopped.stdout)[0].health, "not_running");
});

test("start without credentials fails before creating a local journal", t => {
  const directory = privateDirectory(t), result = runCli(["watch", "start", directory, "--once"]);
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(jsonLines(result.stderr)[0].type, "watch_error"); assert.equal(existsSync(directory), false);
});

test("a successful one-shot with no attention keeps stdout empty and health on stderr", t => {
  const result = runCli(["watch", "start", privateDirectory(t), "--once"], { data: fixture(), credentials: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
  assert.deepEqual(jsonLines(result.stderr).map(record => record.state), ["starting", "watching", "stopped"]);
  assert.ok(jsonLines(result.stderr).every(record => record.type === "watch_status" && record.notifyOnly === true));
});

test("one-shot stdout contains only attention JSONL; restart is quiet for unchanged work", t => {
  const directory = privateDirectory(t), data = fixture(true);
  const first = runCli(["watch", "start", directory, "--once"], { data, credentials: true });
  assert.equal(first.status, 0, first.stderr);
  const notices = jsonLines(first.stdout);
  assert.equal(notices.length, 1); assert.equal(notices[0].workItemId, "work-one");
  assert.equal(notices[0].title, 'Review "one"\nline'); assert.equal(notices[0].notifyOnly, true);
  assert.equal(notices[0].next.action, "accept"); assert.match(notices[0].message, /Check current scope/);
  assert.doesNotMatch(first.stdout + first.stderr, new RegExp(`${token}|PRIVATE_DEFINITION_NOT_A_NOTICE`));
  const second = runCli(["watch", "start", directory, "--once"], { data, credentials: true });
  assert.equal(second.status, 0, second.stderr); assert.equal(second.stdout, "");
});

test("transport error text, credentials and stack traces never become CLI diagnostics", t => {
  const result = runCli(["watch", "start", privateDirectory(t), "--once"], { credentials: true,
    failure: `PRIVATE_TRANSPORT_TEXT ${token}` });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /PRIVATE_TRANSPORT_TEXT|at globalThis|Bearer/);
  assert.ok(!result.stderr.includes(token));
  const records = jsonLines(result.stderr);
  assert.deepEqual(records.map(record => record.state ?? record.code), ["starting", "watch_failed"]);
});

test("retry delays are bounded, exponential and restricted to transient failures", () => {
  for (const error of [new TypeError("offline"), new DOMException("timed out", "TimeoutError"),
    ...[408, 429, 500, 503].map(status => new RoomClientError(status, "temporary", "temporary"))]) {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(failures => retryDelay(error, failures)), [10000, 20000, 40000, 60000, 60000, null]);
  }
  for (const error of [new Error("unknown"), new WatchError("output_failed"),
    ...[200, 401, 403, 404, 409, 422].map(status => new RoomClientError(status, "terminal", "terminal"))])
    assert.equal(retryDelay(error, 1), null);
  for (const [header, expected] of [[0, 10000], [90000, 90000], [300000, 300000], [300001, null]])
    assert.equal(retryDelay(new RoomClientError(429, "rate_limit", "wait", header), 1), expected);
});

function loopFixture(tick) {
  const controller = new AbortController(), health = [], reports = [];
  return { controller, health, reports,
    watcher: { signal: controller.signal, journal: { health: state => health.push(state) }, tick },
    report: async value => reports.push(value) };
}

test("watchLoop does not claim watching until the first successful authenticated tick", async () => {
  let release;
  const f = loopFixture(() => new Promise(resolve => { release = resolve; }));
  const pending = watchLoop(f.watcher, { once: true, report: f.report, wait: () => assert.fail("one-shot must not wait") });
  await nextTurn(); assert.deepEqual(f.reports.map(record => record.state), ["starting"]);
  release(); await pending;
  assert.deepEqual(f.reports.map(record => record.state), ["starting", "watching", "stopped"]);
});

test("watchLoop keeps steady healthy and retrying polls quiet while resetting backoff after success", async () => {
  let ticks = 0;
  const f = loopFixture(async () => { ticks++; if ([1, 2, 4].includes(ticks)) throw new TypeError("offline"); });
  const delays = [];
  await watchLoop(f.watcher, { report: f.report, wait: async (delay, _, options) => {
    assert.equal(options.signal, f.controller.signal); delays.push(delay); if (ticks === 6) f.controller.abort();
  } });
  assert.equal(ticks, 6); assert.deepEqual(delays, [10000, 20000, 10000, 10000, 10000, 10000]);
  assert.deepEqual(f.reports.map(record => record.state), ["starting", "retrying", "watching", "retrying", "watching", "stopped"]);
});

test("watchLoop stops after six consecutive transient failures, with no infinite retry", async () => {
  let ticks = 0; const failure = new TypeError("offline"), delays = [];
  const f = loopFixture(async () => { ticks++; throw failure; });
  await assert.rejects(watchLoop(f.watcher, { report: f.report, wait: async delay => delays.push(delay) }), error => error === failure);
  assert.equal(ticks, 6); assert.deepEqual(delays, [10000, 20000, 40000, 60000, 60000]);
  assert.deepEqual(f.reports.map(record => record.state), ["starting", "retrying"]);
});

test("watchLoop never retries revoked access, storage failure or excessive Retry-After", async () => {
  for (const failure of [new RoomClientError(401, "revoked", "revoked"), new WatchError("state_invalid"),
    new RoomClientError(429, "rate_limit", "wait", 300001)]) {
    let ticks = 0; const f = loopFixture(async () => { ticks++; throw failure; });
    await assert.rejects(watchLoop(f.watcher, { report: f.report, wait: () => assert.fail("terminal failure retried") }), error => error === failure);
    assert.equal(ticks, 1); assert.deepEqual(f.reports.map(record => record.state), ["starting"]);
  }
});

test("watchLoop one-shot retries a transient read then exits after one successful check", async () => {
  let ticks = 0; const delays = [];
  const f = loopFixture(async () => { if (++ticks === 1) throw new RoomClientError(429, "rate_limit", "wait", 30000); });
  await watchLoop(f.watcher, { once: true, report: f.report, wait: async delay => delays.push(delay) });
  assert.equal(ticks, 2); assert.deepEqual(delays, [30000]);
  assert.deepEqual(f.reports.map(record => record.state), ["starting", "retrying", "watching", "stopped"]);
});

test("watchLoop interrupt cancels a real pending wait without performing another tick", async () => {
  let ticks = 0;
  const f = loopFixture(async () => { ticks++; setImmediate(() => f.controller.abort()); });
  await watchLoop(f.watcher, { intervalMs: 60000, report: f.report });
  assert.equal(ticks, 1); assert.equal(f.reports.at(-1).state, "stopped");
});

test("watchLoop interrupt cancels an in-flight read and pre-aborted runs never tick", async () => {
  let ticks = 0;
  const f = loopFixture(() => {
    ticks++;
    return new Promise((_, reject) => {
      f.controller.signal.addEventListener("abort", () => reject(f.controller.signal.reason), { once: true });
      setImmediate(() => f.controller.abort());
    });
  });
  await watchLoop(f.watcher, { report: f.report, wait: () => assert.fail("interrupted tick must not retry") });
  assert.equal(ticks, 1); assert.deepEqual(f.reports.map(record => record.state), ["starting", "stopped"]);
  const before = loopFixture(() => assert.fail("already stopped")); before.controller.abort();
  await watchLoop(before.watcher, { report: before.report });
  assert.ok(before.reports.every(record => record.state !== "watching"));
});

test("unexpected wait failures propagate instead of silently starting another poll", async () => {
  let ticks = 0; const failure = new Error("wait failed"), f = loopFixture(async () => { ticks++; });
  await assert.rejects(watchLoop(f.watcher, { wait: async () => { throw failure; } }), error => error === failure);
  assert.equal(ticks, 1);
});

const clientWith = fetchImpl => new RoomAgentClient({ origin, roomId, token, fetchImpl });

test("RoomAgentClient parses Retry-After seconds, dates, past dates, absent and invalid values", async t => {
  const now = Date.UTC(2026, 8, 7, 12); t.mock.method(Date, "now", () => now);
  for (const [header, expected] of [["0", 0], ["12", 12000], [new Date(now + 45000).toUTCString(), 45000],
    [new Date(now - 10000).toUTCString(), 0], ["not-a-date", null], [null, null]]) {
    const client = clientWith(async () => Response.json({ error: { code: "rate_limit", message: "Wait" } }, {
      status: 429, headers: header === null ? {} : { "Retry-After": header }
    }));
    await assert.rejects(client.snapshot(), error => error instanceof RoomClientError && error.status === 429
      && error.code === "rate_limit" && error.retryAfterMs === expected);
  }
});

test("non-JSON failure responses preserve HTTP status and Retry-After; invalid successes are terminal", async () => {
  const unavailable = clientWith(async () => new Response("temporary upstream page", { status: 503, headers: { "Retry-After": "25" } }));
  await assert.rejects(unavailable.changes(), error => error instanceof RoomClientError && error.status === 503 && error.retryAfterMs === 25000);
  const malformed = clientWith(async () => new Response("not json", { status: 200 }));
  await assert.rejects(malformed.snapshot(), error => error.code === "invalid_response" && retryDelay(error, 1) === null);
});

test("snapshot and changes pass cancellation to reads without cookies, redirects or writes", async () => {
  for (const read of [(client, signal) => client.snapshot({ signal }), (client, signal) => client.changes(2, 1, { signal })]) {
    const controller = new AbortController(); let request;
    const client = clientWith((url, options) => {
      request = { url, ...options };
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    });
    const pending = read(client, controller.signal);
    assert.equal(request.signal.aborted, false); assert.equal(request.method, "GET");
    assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error");
    assert.equal(request.body, undefined); assert.equal(request.headers.Authorization, `Bearer ${token}`);
    assert.ok(!request.url.includes(token));
    controller.abort(); await assert.rejects(pending, error => error.name === "AbortError");
    assert.equal(request.signal.aborted, true);
  }
});

test("a timed-out response body remains transient rather than becoming invalid JSON", async t => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 15000); return timeout.signal;
  });
  let reading = false;
  const client = clientWith(async (_, options) => ({ ok: true, status: 200,
    json: () => new Promise((_, reject) => {
      reading = true;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  }));
  const pending = client.snapshot();
  await nextTurn(); assert.equal(reading, true);
  timeout.abort(new DOMException("Timed out while reading the body", "TimeoutError"));
  await assert.rejects(pending, error => error.name === "TimeoutError" && retryDelay(error, 1) === 10000);
});

test("caller cancellation while reading a response body stays cancellation, not invalid JSON", async () => {
  const controller = new AbortController(); let reading = false;
  const client = clientWith(async (_, options) => ({ ok: true, status: 200,
    json: () => new Promise((_, reject) => {
      reading = true;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  }));
  const pending = client.changes(0, 1, { signal: controller.signal });
  await nextTurn(); assert.equal(reading, true);
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
});

test("writeJson emits one parseable line and waits for the writable callback, not write acceptance", async () => {
  let written, release, settled = false;
  const stream = new Writable({ highWaterMark: 1, write(chunk, _, callback) { written = chunk.toString(); release = callback; } });
  const value = { title: 'two\n"lines"', notifyOnly: true };
  const pending = writeJson(stream, value).then(() => { settled = true; });
  await nextTurn(); assert.equal(settled, false); assert.equal(stream.writableNeedDrain, true);
  assert.equal(written, JSON.stringify(value) + "\n"); assert.deepEqual(jsonLines(written), [value]);
  release(); await pending; assert.equal(stream.listenerCount("error"), 0); assert.equal(stream.destroyed, false);
  stream.destroy();
});

test("writeJson maps a broken pipe callback and error event to a sanitized output failure", async () => {
  const stream = new Writable({ write(_, __, callback) { callback(Object.assign(new Error("PRIVATE_EPIPE_DETAIL"), { code: "EPIPE" })); } });
  await assert.rejects(writeJson(stream, { notice: true }), error => hasCode("output_failed")(error) && !error.message.includes("PRIVATE_EPIPE_DETAIL"));
  await nextTurn(); // Node emits the stream error after its failed write callback.
});

test("writeJson rejects a synchronous broken write and a stuck pipe within its timeout", async () => {
  const broken = new EventEmitter(); broken.write = () => { throw new Error("PRIVATE_WRITE_DETAIL"); };
  await assert.rejects(writeJson(broken, { notice: true }), hasCode("output_failed"));
  const stuck = new Writable({ write() {} });
  await assert.rejects(writeJson(stuck, { notice: true }, undefined, 20), hasCode("output_failed"));
  assert.equal(stuck.destroyed, true);
});

test("writeJson abort destroys a slow pipe and remains settled when its callback arrives later", async () => {
  const controller = new AbortController(); let release;
  const stream = new Writable({ write(_, __, callback) { release = callback; } });
  const pending = writeJson(stream, { notice: true }, controller.signal);
  controller.abort(); await assert.rejects(pending, hasCode("stopped"));
  assert.equal(stream.destroyed, true); release(); await nextTurn();
});

test("writeJson with an already aborted signal performs no write or stream destruction", async () => {
  const controller = new AbortController(); controller.abort();
  const stream = new EventEmitter();
  stream.write = () => assert.fail("must not write after stop"); stream.destroy = () => assert.fail("unused pipe must not be destroyed");
  await assert.rejects(writeJson(stream, { notice: true }, controller.signal), hasCode("stopped"));
  assert.equal(stream.listenerCount("error"), 0);
});
