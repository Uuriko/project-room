// Strict Cloudflare doubles. A stub that returns success for every method
// name hides a missing RPC, which is how the cron tick passed while workerd
// rejected ProjectRoom. These checks fail when a double grows an unknown
// method, and when scheduled() calls a method ProjectRoom does not implement.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  strictBinding, strictDurableObjectNamespace, strictDurableObjectStub,
  strictKvNamespace, strictR2Bucket, strictServiceBinding
} from "../cloudflare/platform-fakes.mjs";

test("KV, R2, and service bindings throw on unknown methods and keep real results", async () => {
  const kv = strictKvNamespace();
  assert.equal(await kv.get("missing"), null);
  await kv.put("room/a", JSON.stringify({ n: 1 }));
  assert.deepEqual(await kv.get("room/a", { type: "json" }), { n: 1 });
  await kv.put("room/b", "beta", { metadata: { owner: "room" } });
  const listed = await kv.list({ prefix: "room/" });
  assert.deepEqual(listed.keys.map(key => key.name), ["room/a", "room/b"]);
  assert.equal(listed.list_complete, true);
  await kv.delete("room/a");
  assert.equal(await kv.get("room/a"), null);
  await assert.rejects(kv.put("short", "x", { expirationTtl: 10 }), /at least 60/);
  await assert.rejects(kv.get("room/b", { type: "stream" }), /Unsupported KV/);
  assert.throws(() => kv.createBucket(), /KVNamespace has no method/);
  const expired = strictKvNamespace({ now: () => 1_700_000_000_000 });
  await expired.put("gone", "x", { expiration: 1 });
  assert.equal(await expired.get("gone"), null);

  const bucket = strictR2Bucket();
  assert.equal(await bucket.get("absent"), null);
  assert.equal(await bucket.head("absent"), null);
  const stored = await bucket.put("mail/1", "hello", { customMetadata: { source: "test" } });
  assert.equal(stored.size, 5);
  assert.equal(stored.customMetadata.source, "test");
  assert.equal(await (await bucket.get("mail/1")).text(), "hello");
  assert.equal((await bucket.head("mail/1")).size, 5);
  assert.equal((await (await bucket.get("mail/1")).body).length, 5);
  await bucket.delete("mail/1");
  assert.equal(await bucket.get("mail/1"), null);
  await assert.rejects(bucket.createMultipartUpload(), /does not implement multipart/);
  assert.throws(() => bucket.createBucket("other"), /R2Bucket has no method/);

  const assets = strictServiceBinding(async () => new Response("ok"));
  assert.equal(await (await assets.fetch(new Request("https://room.example.test/"))).text(), "ok");
  assert.throws(() => assets.put("nope"), /Fetcher has no method/);
});

test("a Durable Object namespace rejects unknown names and unknown RPC", () => {
  class Probe { ping() { return "pong"; } }
  const target = new Probe();
  const { namespace, names } = strictDurableObjectNamespace({ pilot: target });
  assert.equal(namespace.getByName("pilot").ping(), "pong");
  assert.deepEqual(names, ["pilot"]);
  assert.throws(() => namespace.getByName("other"), /not registered/);
  assert.throws(() => namespace.idFromName("pilot"), /DurableObjectNamespace has no method/);
  const { stub } = strictDurableObjectStub(target);
  assert.throws(() => stub.syncGmailMailboxes(), /does not implement the method "syncGmailMailboxes"/);
});

function installWorkersShim() {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "room-platform-fakes-"));
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
const { default: worker, ProjectRoom } = await import("../cloudflare/room.mjs");
const { DurableObject } = await import("cloudflare:workers");

test("scheduled RPC hits real ProjectRoom methods and fails on an unknown one", async () => {
  assert.equal(Object.getPrototypeOf(ProjectRoom.prototype), DurableObject.prototype);
  const ctx = { get storage() { throw new Error("paused startup must not open storage"); } };
  const room = new ProjectRoom(ctx, { ROOM_ORIGIN: "https://room.example.test", ROOM_MAINTENANCE: "1" });
  const { stub, invoked } = strictDurableObjectStub(room);
  const names = [];
  const namespace = strictBinding({
    getByName(name) { names.push(name); return stub; }
  }, "DurableObjectNamespace");
  const pending = [];
  const warnings = [];
  const errors = [];
  const original = console.warn;
  const originalError = console.error;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  console.error = (...args) => { errors.push(args.join(" ")); };
  // #992: the room instance is paused, so the two drain jobs throw.
  // runCronJobs warns and continues; scheduled() records the tick (that
  // write fails because paused startup must not open storage), then
  // rejects so Cron Events show channel-drain and webhook-dispatch.
  try {
    await assert.rejects(worker.scheduled({ cron: "* * * * *" }, {
      ROOM_MAINTENANCE: "0",
      ROOM_ORIGIN: "https://room.example.test",
      ROOM: namespace
    }, { waitUntil(promise) { pending.push(promise); } }), /cron jobs failed: channel-drain, webhook-dispatch/);
    await Promise.all(pending);
  } finally {
    console.warn = original;
    console.error = originalError;
  }
  assert.deepEqual(names, ["invite-only-pilot-v2"]);
  assert.deepEqual(invoked, [
    "syncGmailMailboxes",
    "drainChannelBacklog",
    "drainWebhookDeliveries",
    "refreshLandQueue",
    "planRetention",
    "recordCronTick"
  ]);
  assert.deepEqual(warnings.map(line => line.slice(0, line.indexOf("]"))), [
    "[channel-drain",
    "[webhook-dispatch"
  ]);
  assert.ok(warnings.every(line => /Room paused/.test(line)), warnings.join("\n"));
  assert.deepEqual(errors, ["[job-heartbeat] record failed: paused startup must not open storage"]);
  assert.throws(() => stub.notARealCronMethod(), /does not implement the method "notARealCronMethod"/);
  assert.equal((await stub.syncGmailMailboxes()).completed, 0);
});
