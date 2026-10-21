// The safety-net cron wakes one Durable Object. That is only correct while
// every request is served by that same object. If a room is ever routed to
// a different object, this fails until scheduled() wakes that object too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../cloudflare/room.mjs", import.meta.url), "utf8");

test("every Durable Object lookup in the worker uses the one room object name", () => {
  const lookups = [...source.matchAll(/env\.ROOM\.(getByName|idFromName|idFromString|newUniqueId|get)\(([^)]*)\)/g)];
  assert.ok(lookups.length >= 4, "worker addresses the room object");
  for (const [call, , arg] of lookups) assert.equal(arg.trim(), "ROOM_OBJECT_NAME", `${call} must use ROOM_OBJECT_NAME`);
});

test("the scheduled handler wakes that same object", () => {
  const start = source.indexOf("async scheduled(");
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf("\n  }", start));
  assert.match(body, /env\.ROOM\.getByName\(ROOM_OBJECT_NAME\)/);
  assert.match(body, /ensureJobAlarm\(\)/);
});
