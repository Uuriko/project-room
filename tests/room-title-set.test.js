// QA 2026-10-20: owner rename (room.title_set) through the reducer, the
// command allowlist, hosted MCP and the Settings form.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMAND_TYPES } from "../server/store.mjs";
import { classifyCommand } from "../server/action-classes.mjs";
import { mcpRoomToolScope } from "../server/mcp-room-profile.mjs";
import { applyEvent, emptyRoomState, event, EVENT_TYPES as T, PERMISSIONS, normalizeRoomTitle } from "../src/events.js";

const owner = "owner";
const seed = () => [
  event({ type: T.ROOM_CREATED, actorId: owner, roomId: "r", data: { roomId: "r", ownerId: owner, title: "Before", purpose: "Rename test" } }),
  event({ type: T.MEMBER_ADDED, actorId: owner, roomId: "r", data: { memberId: owner, displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] } }),
  event({ type: T.MEMBER_ADDED, actorId: owner, roomId: "r", data: { memberId: "m", displayName: "Member", kind: "human", permissions: ["steer"] } })
].reduce(applyEvent, emptyRoomState());
const rename = (actorId, title) => event({ type: T.ROOM_TITLE_SET, actorId, roomId: "r", data: { title } });

test("room.title_set is an owner-only act command that replaces the title", () => {
  assert.equal(T.ROOM_TITLE_SET, "room.title_set");
  assert.ok(COMMAND_TYPES.includes(T.ROOM_TITLE_SET));
  assert.equal(classifyCommand(T.ROOM_TITLE_SET), "act");
  const renamed = applyEvent(seed(), rename(owner, "  After  "));
  assert.equal(renamed.room.title, "After");
  assert.throws(() => applyEvent(seed(), rename("m", "Hijack")), /Only the Room owner may rename/);
});

test("room.title_set rejects empty, long and control-character names, and archived rooms", () => {
  for (const bad of ["", "   ", "x".repeat(121), "a\nb", 7]) assert.throws(() => applyEvent(seed(), rename(owner, bad)), /Room name must be|Invalid title/);
  assert.equal(normalizeRoomTitle("x".repeat(120)), "x".repeat(120));
  const archived = applyEvent(seed(), event({ type: T.ROOM_ARCHIVED, actorId: owner, roomId: "r", data: {} }));
  assert.throws(() => applyEvent(archived, rename(owner, "Late")), /archived/);
});

test("hosted MCP room_rename is a write tool that sends room.title_set", () => {
  assert.equal(mcpRoomToolScope("room_rename"), "rooms:write");
  const hosted = readFileSync(new URL("../server/mcp-hosted-tools.mjs", import.meta.url), "utf8");
  assert.match(hosted, /tool\("room_rename",/);
  const profile = readFileSync(new URL("../server/mcp-room-profile.mjs", import.meta.url), "utf8");
  assert.match(profile, /type: "room\.title_set", data: \{ title: args\.title \}/);
  const openapi = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
  assert.match(openapi, /`room\.title_set`/);
});

test("Settings shows a rename form to the owner only and keeps the header in sync", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(html, /<form id="room-rename-form"[^>]*hidden>/);
  assert.match(html, /<input id="room-rename-input"[^>]*maxlength="120"/);
  assert.match(app, /\$\("#room-rename-form"\)\.hidden = !roomOwner \|\| archived;/);
  assert.match(app, /type: T\.ROOM_TITLE_SET, data: \{ title \}/);
  assert.match(app, /if \(room\?\.title\) \{ \$\("#room-title"\)\.textContent = room\.title;/);
});

test("room.title_set writes are gated until ROOM_TITLE_SET_WRITES=1; replay always applies", async () => {
  const { createAcceptanceFixture } = await import("../scripts/acceptance-fixture.mjs");
  const { randomUUID } = await import("node:crypto");
  const saved = process.env.ROOM_TITLE_SET_WRITES;
  try {
    delete process.env.ROOM_TITLE_SET_WRITES;
    const off = createAcceptanceFixture();
    assert.throws(() => off.store.command(off.keys.owner, "commons", { id: randomUUID(), type: T.ROOM_TITLE_SET, data: { title: "Gated" } }), /not enabled/);
    process.env.ROOM_TITLE_SET_WRITES = "1";
    const on = createAcceptanceFixture();
    on.store.command(on.keys.owner, "commons", { id: randomUUID(), type: T.ROOM_TITLE_SET, data: { title: "Open" } });
    assert.equal(on.store.room("commons").state.room.title, "Open");
  } finally {
    if (saved === undefined) delete process.env.ROOM_TITLE_SET_WRITES; else process.env.ROOM_TITLE_SET_WRITES = saved;
  }
  // Replay of a stored rename does not depend on the write gate.
  assert.equal(applyEvent(seed(), rename(owner, "Replayed")).room.title, "Replayed");
});
