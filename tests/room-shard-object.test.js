// RoomShard must extend the workerd DurableObject, and a default env must
// not open its storage. The shim stands in for cloudflare:workers so this
// runs under Node.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "room-shard-object-"));
const shimUrl = pathToFileURL(join(dir, "shim.mjs")).href;
writeFileSync(join(dir, "shim.mjs"), [
  "export class DurableObject {",
  "  constructor(ctx, env) { this.ctx = ctx; this.env = env; }",
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

const { RoomShard } = await import("../cloudflare/room-shard.mjs");
const { DurableObject } = await import("cloudflare:workers");

test("a default RoomShard does not open storage and answers 404", async () => {
  assert.equal(Object.getPrototypeOf(RoomShard.prototype), DurableObject.prototype);
  let opened = false;
  const ctx = { get storage() { opened = true; throw new Error("storage opened"); } };
  const shard = new RoomShard(ctx, { ROOM_ORIGIN: "https://room.example.test" });
  assert.equal(opened, false);
  assert.equal(shard.store, null);
  assert.equal(shard.state, ctx);
  const response = await shard.fetch(new Request("https://room.example.test/api/rooms/commons"));
  assert.equal(response.status, 404);
});
