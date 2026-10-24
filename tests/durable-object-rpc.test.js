// Production cron calls Durable Object stub methods (Gmail sync, channel drain,
// webhook delivery, land-queue refresh, retention). Workerd rejects those RPC
// calls unless the receiving class extends DurableObject from cloudflare:workers.
import test from "node:test";
import assert from "node:assert/strict";
import { emailRoutingRejections } from "../server/email-routing-inbound.mjs";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = path => readFileSync(path, "utf8");

function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      out += " ";
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (/\.(mjs|js)$/.test(name) && !name.endsWith(".check.mjs") && !name.includes(".test-fixture.")) acc.push(path);
  }
  return acc;
}

function skipString(source, i) {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") { j += 1; continue; }
    if (source[j] === quote) return j;
  }
  return source.length;
}

function sliceBalanced(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"') { i = skipString(source, i); continue; }
    if (ch === "`") { i = skipTemplate(source, i); continue; }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

function skipTemplate(source, i) {
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") { j += 1; continue; }
    if (source[j] === "`") return j;
    if (source[j] === "$" && source[j + 1] === "{") {
      const inner = sliceBalanced(source, j + 1);
      j += inner.length;
    }
  }
  return source.length;
}

function functionBodyContaining(source, index) {
  const method = /\n {2}(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g;
  for (const match of [...source.matchAll(method)].reverse()) {
    const brace = match.index + match[0].lastIndexOf("{");
    if (brace > index) continue;
    const body = sliceBalanced(source, brace);
    if (index < brace + body.length) return body;
  }
  // A caller may pass an already-sliced method body.
  return source;
}

// Non-fetch calls on a stub from env.<binding>.getByName(). fetch() is the
// HTTP path and works without the DurableObject superclass.
function rpcStubCalls(source) {
  const calls = [];
  const assign = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*env\.([A-Za-z_$][\w$]*)\.getByName\s*\(/g;
  for (const match of source.matchAll(assign)) {
    const body = functionBodyContaining(source, match.index);
    const call = new RegExp(`\\b${match[1]}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
    for (const hit of body.matchAll(call)) {
      if (hit[1] === "fetch") continue;
      calls.push({ binding: match[2], method: hit[1], body });
    }
  }
  const chained = /env\.([A-Za-z_$][\w$]*)\.getByName\s*\([^)]*\)\s*\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const hit of source.matchAll(chained)) {
    if (hit[2] === "fetch") continue;
    calls.push({ binding: hit[1], method: hit[2], body: "" });
  }
  return calls;
}

function bindingClasses(wrangler) {
  const map = new Map();
  const add = config => {
    for (const binding of config?.durable_objects?.bindings ?? []) {
      const names = map.get(binding.name) ?? new Set();
      names.add(binding.class_name);
      map.set(binding.name, names);
    }
  };
  add(wrangler);
  for (const env of Object.values(wrangler.env ?? {})) add(env);
  return map;
}

function installWorkersShim() {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "room-do-rpc-"));
  const shimUrl = pathToFileURL(join(dir, "shim.mjs")).href;
  writeFileSync(join(dir, "shim.mjs"), [
    "export class DurableObject {",
    "  constructor(ctx, env) { this.ctx = ctx; this.env = env; }",
    "}",
    "export function httpServerHandler() {",
    "  return { fetch() { return new Response(null, { status: 500 }); } };",
    "}",
    ""
  ].join("\n"));
  writeFileSync(join(dir, "hook.mjs"), [
    `const shim = ${JSON.stringify(shimUrl)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:node') {",
    "    return { url: shim, shortCircuit: true };",
    "  }",
    "  return nextResolve(specifier, context);",
    "}",
    ""
  ].join("\n"));
  register(pathToFileURL(join(dir, "hook.mjs")).href, import.meta.url);
}

installWorkersShim();
const { default: worker, ProjectRoom, JobWatchdog } = await import(pathToFileURL(join(root, "cloudflare/room.mjs")).href);
const { DurableObject } = await import("cloudflare:workers");

const workerSource = read(join(root, "cloudflare/room.mjs"));
const wrangler = parseJsonc(read(join(root, "cloudflare/wrangler.jsonc")));
const calls = walk(join(root, "cloudflare")).flatMap(path => rpcStubCalls(read(path)).map(call => ({ ...call, path })));

test("RPC stub calls target a class that extends DurableObject", () => {
  assert.ok(wrangler.compatibility_date >= "2024-04-03", "compatibility_date must allow Durable Object RPC");
  for (const env of Object.values(wrangler.env ?? {})) {
    if (env.compatibility_date) assert.ok(env.compatibility_date >= "2024-04-03");
  }
  const methods = [...new Set(calls.map(call => call.method))].sort();
  assert.deepEqual(methods, [
    "beat",
    "ensureArmed",
    "ensureJobAlarm",
    "probeStorage",
    "readHealth",
    "readJobHealth",
    "rebootAlarm",
    "refreshRoomHistory",
    "runSlowJob"
  ]);
  assert.match(workerSource, /env\.ROOM\.getByName\('invite-only-pilot'\)\.fetch\(/);
  assert.match(workerSource, /import\s*\{[^}]*\bDurableObject\b[^}]*\}\s*from\s*['"]cloudflare:workers['"]/);

  const classes = bindingClasses(wrangler);
  const targeted = new Set();
  for (const call of calls) {
    const names = classes.get(call.binding);
    assert.ok(names?.size, `${call.binding} is called over RPC but is not a Durable Object binding`);
    for (const name of names) targeted.add(name);
  }
  assert.deepEqual([...targeted].sort(), ["JobWatchdog", "ProjectRoom"]);
  const owners = { ProjectRoom, JobWatchdog };
  for (const className of targeted) {
    const source = sourceOfClass(className);
    assert.match(source, new RegExp(`export\\s+class\\s+${className}\\s+extends\\s+DurableObject\\b`));
    const start = source.search(new RegExp(`export\\s+class\\s+${className}\\b`));
    const ctor = source.indexOf("constructor(", start);
    const body = sliceBalanced(source, source.indexOf("{", ctor));
    assert.match(body, /super\s*\(\s*ctx\s*,\s*env\s*\)/);
    assert.match(body, /this\.state\s*=\s*ctx\b/);
    assert.match(body, /this\.env\s*=\s*env\b/);
  }
  for (const call of calls) {
    const names = [...classes.get(call.binding)];
    assert.equal(names.length, 1, call.binding);
    assert.equal(typeof owners[names[0]].prototype[call.method], "function", `${names[0]}.${call.method}`);
  }
});

function sourceOfClass(className) {
  for (const path of walk(join(root, "cloudflare"))) {
    const source = read(path);
    if (new RegExp(`export\\s+class\\s+${className}\\s+extends\\s+DurableObject\\b`).test(source)) return source;
  }
  throw new Error(`missing Durable Object class ${className}`);
}

test("scheduled handler invokes cron RPC on the real ProjectRoom shape", async () => {
  assert.equal(Object.getPrototypeOf(ProjectRoom.prototype), DurableObject.prototype);
  const ctx = { get storage() { throw new Error("paused startup must not open storage"); } };
  const paused = new ProjectRoom(ctx, { ROOM_ORIGIN: "https://room.example.test", ROOM_MAINTENANCE: "1" });
  assert.equal(paused.state, ctx);
  assert.equal(paused.env.ROOM_ORIGIN, "https://room.example.test");
  assert.equal(paused.ctx, ctx);

  const scheduledAt = workerSource.indexOf("async scheduled(");
  const scheduledBody = sliceBalanced(workerSource, workerSource.indexOf("{", scheduledAt));
  const expected = rpcStubCalls(scheduledBody).map(call => call.method).sort();
  assert.deepEqual([...new Set(expected)], ["ensureJobAlarm", "runSlowJob"]);

  await worker.scheduled({ cron: "*/30 * * * *" }, {
    ROOM_MAINTENANCE: "1",
    ROOM: { getByName() { throw new Error("maintenance must not resolve the room"); } }
  }, { waitUntil() { throw new Error("maintenance must not schedule work"); } });

  const invoked = [];
  let name = null;
  // Strict stub: like workerd RPC, only methods the real class defines are
  // callable. A permissive "any method" stub is how #985 slipped through.
  const stub = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof ProjectRoom.prototype[prop] !== "function") {
        return () => Promise.reject(new TypeError(`ProjectRoom has no RPC method ${String(prop)}`));
      }
      return () => {
        invoked.push(String(prop));
        return Promise.resolve({ ok: true });
      };
    }
  });
  const pending = [];
  await worker.scheduled({ cron: "*/30 * * * *" }, {
    ROOM_MAINTENANCE: "0",
    ROOM_GMAIL_ENABLED: "1",
    TELEGRAM_BOT_TOKEN: "123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFa",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-16",
    ROOM: { getByName(value) { name = value; return stub; } }
  }, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(name, "invite-only-pilot");
  assert.deepEqual([...new Set(invoked)].sort(), [...new Set(expected)]);
  assert.equal(invoked.filter(method => method === "runSlowJob").length, 4);
});

test("ROOM_DURABLE_ALARM_QUEUE makes scheduled enqueue instead of running slow jobs", async () => {
  const invoked = [];
  const stub = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof ProjectRoom.prototype[prop] !== "function") {
        return () => Promise.reject(new TypeError(`ProjectRoom has no RPC method ${String(prop)}`));
      }
      return (...args) => {
        invoked.push({ method: String(prop), args });
        return Promise.resolve({ ok: true });
      };
    }
  });
  await worker.scheduled({ cron: "*/30 * * * *" }, {
    ROOM_MAINTENANCE: "0",
    ROOM_DURABLE_ALARM_QUEUE: "1",
    ROOM: { getByName() { return stub; } }
  }, { waitUntil() {} });
  assert.deepEqual(invoked.map(call => call.method), ["ensureJobAlarm"]);
  assert.deepEqual(invoked[0].args, [{ includeSlow: true }]);
});

function strictStub(prototype, invoked, label) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof prototype[prop] !== "function") {
        return () => Promise.reject(new TypeError(`${label} has no RPC method ${String(prop)}`));
      }
      return (...args) => {
        invoked.push({ method: String(prop), args });
        return Promise.resolve({ ok: true, alarmAt: 1 });
      };
    }
  });
}

test("scheduled arms the watchdog and still runs slow jobs when only the watchdog flag is on", async () => {
  const room = [];
  const watchdog = [];
  await worker.scheduled({ cron: "*/30 * * * *" }, {
    ROOM_MAINTENANCE: "0",
    ROOM_JOB_WATCHDOG: "1",
    ROOM: { getByName: () => strictStub(ProjectRoom.prototype, room, "ProjectRoom") },
    JOB_WATCHDOG: { getByName: name => { watchdog.push({ name }); return strictStub(JobWatchdog.prototype, watchdog, "JobWatchdog"); } }
  }, { waitUntil() {} });
  assert.deepEqual(room.map(call => call.method), ["ensureJobAlarm", "runSlowJob", "runSlowJob", "runSlowJob", "runSlowJob"]);
  assert.deepEqual(watchdog.filter(call => call.method).map(call => call.method), ["ensureArmed"]);
  assert.equal(watchdog[0].name, "job-watchdog");
});

test("ROOM_SQLITE_HISTORY refreshes one room from scheduled and leaves the queue path to the alarm", async () => {
  const history = [];
  const room = [];
  const stub = () => strictStub(ProjectRoom.prototype, room, "ProjectRoom");
  await worker.scheduled({ cron: "*/30 * * * *" }, {
    ROOM_MAINTENANCE: "0",
    ROOM_SQLITE_HISTORY: "1",
    ROOM: { getByName: () => stub() }
  }, { waitUntil() {} });
  assert.deepEqual(room.map(call => call.method), ["ensureJobAlarm", "runSlowJob", "runSlowJob", "runSlowJob", "runSlowJob", "refreshRoomHistory"]);
  room.length = 0;
  await worker.scheduled({ cron: "*/30 * * * *" }, {
    ROOM_MAINTENANCE: "0",
    ROOM_SQLITE_HISTORY: "1",
    ROOM_DURABLE_ALARM_QUEUE: "1",
    ROOM: {
      getByName() {
        return new Proxy({}, {
          get(_target, prop) {
            if (prop === "then") return undefined;
            if (typeof ProjectRoom.prototype[prop] !== "function") {
              return () => Promise.reject(new TypeError(`ProjectRoom has no RPC method ${String(prop)}`));
            }
            return (...args) => {
              history.push({ method: String(prop), args });
              return Promise.resolve({ ok: true });
            };
          }
        });
      }
    }
  }, { waitUntil() {} });
  assert.deepEqual(history.map(call => call.method), ["ensureJobAlarm"]);
  assert.deepEqual(history[0].args, [{ includeSlow: true }]);
});

test("rebootAlarm only sets the alarm", async () => {
  const paused = new ProjectRoom(
    { get storage() { throw new Error("paused startup must not open storage"); } },
    { ROOM_ORIGIN: "https://room.example.test", ROOM_MAINTENANCE: "1" }
  );
  assert.deepEqual(await paused.rebootAlarm(), { rebooted: false, skipped: "paused" });
  const alarms = [];
  const room = Object.create(ProjectRoom.prototype);
  room.paused = false;
  room.store = {};
  room.ctx = { storage: { setAlarm(when) { alarms.push(when); return Promise.resolve(); } } };
  const before = Date.now();
  const result = await room.rebootAlarm();
  assert.equal(result.rebooted, true);
  assert.equal(alarms.length, 1);
  assert.ok(alarms[0] >= before);
  assert.equal(result.alarmAt, alarms[0]);
});

test("GET /api/health/jobs reads the watchdog and falls through when it has no beat", async () => {
  const roomCalls = [];
  const room = {
    readJobHealth() {
      roomCalls.push("readJobHealth");
      return Promise.resolve({ schema: "room.job-health/1", status: "ok", jobs: [] });
    }
  };
  let watchdogName = null;
  const base = {
    ROOM_ORIGIN: "https://room.trydemigod.com",
    ROOM_JOB_WATCHDOG: "1",
    ROOM: { getByName() { return room; } }
  };
  const ready = await worker.fetch(new Request("https://room.trydemigod.com/api/health/jobs"), {
    ...base,
    JOB_WATCHDOG: {
      getByName(name) {
        watchdogName = name;
        return { readHealth: async () => ({ schema: "room.job-health/1", status: "ok", jobs: [], source: "watchdog" }) };
      }
    }
  });
  assert.equal(ready.status, 200);
  assert.equal(watchdogName, "job-watchdog");
  assert.deepEqual(roomCalls, []);
  assert.equal((await ready.json()).source, "watchdog");
  const missing = await worker.fetch(new Request("https://room.trydemigod.com/api/health/jobs"), {
    ...base,
    JOB_WATCHDOG: { getByName() { return { readHealth: async () => ({ schema: "room.job-health/1", status: "unavailable", jobs: [], source: "watchdog" }) }; } }
  });
  assert.equal(missing.status, 200);
  assert.deepEqual(roomCalls, ["readJobHealth"]);
});

test("inbound mail is rejected while the inbox consumer is not durable", async () => {
  let rawRead = false;
  const reasons = [];
  const message = {
    from: "sender@example.test",
    to: "room@example.test",
    rawSize: 32,
    get raw() { rawRead = true; return new ReadableStream(); },
    setReject(reason) { reasons.push(reason); }
  };
  let woken = false;
  await worker.email(message, {
    ROOM_MAINTENANCE: "0",
    ROOM_ORIGIN: "https://room.example.test",
    ROOM: { getByName() { woken = true; throw new Error("shelved mail must not wake the room"); } }
  }, { waitUntil() { throw new Error("shelved mail must not schedule work"); } });
  assert.deepEqual(reasons, [emailRoutingRejections.notAccepted]);
  assert.equal(rawRead, false, "rejected mail is not read");
  assert.equal(woken, false, "rejected mail does not wake the Durable Object");
  assert.equal(workerSource.includes("routedMail"), false);
  assert.equal(typeof ProjectRoom.prototype.importRoutedEmail, "undefined");
});
