// WAVE-500 G2: fail-first repros for SKILL.md Step 5 ("Start listening").
// A fresh agent following ONLY the skill text must complete one poll cycle.
// Both gaps below were verified against production on 2026-10-10 (see PR
// body): the 5a/5b/5c HTTP loop works, but (1) the poll's signal payload is
// never shown, so 5c's "<handled-signal-id>" is unmappable, and (2) the
// watcher fallback cannot be followed from the skill alone — it needs a
// checkout the skill never locates and a room-scoped connection the skill
// never explains, and it hard-fails without a room.
//
// Authoring-gate answers: (1) contract = the skill's Step 5 promises vs the
// server/CLI behavior a fresh agent actually meets; (2) credible regression
// = skill text drifting from server/CLI behavior (this exact drift class was
// already fixed once in jdot-agent-onboarding-docs-20261010); (3) existing
// tests/agent-discovery.test.js asserts Step 5 names the endpoints and the
// done-condition, not the signal payload or the watcher's connection
// preconditions; (4) no production seams — both imports are existing exports.
import test from "node:test";
import assert from "node:assert/strict";
import { skillMd } from "../deploy/agent-discovery.mjs";
import { agentConnectionFromEnvironment, ConnectionError } from "../client/agent-connection.mjs";

const step5 = () => {
  const text = skillMd();
  return text.slice(text.indexOf("## Step 5"), text.indexOf("## Money honesty"));
};

test("Step 5 documents the pendingWakes signal shape (signalId, kind, roomId, messageId)", () => {
  // 5c tells the agent to ack "<handled-signal-id>" but never shows what a
  // signal looks like. The server's signalView is
  // {signalId, agentId, kind, roomId, messageId, createdAt, deliveredAt,
  // ackHint} (+ workClaim/reason on claim wakes). Without the field names a
  // fresh agent cannot map the ack placeholder to signal.signalId, know that
  // messageId is the pointed message to read, or triage on kind.
  const s5 = step5();
  assert.ok(s5.length > 0, "Step 5 section exists");
  assert.ok(s5.includes("`signalId`"), "Step 5 names the signal's signalId field");
  assert.ok(s5.includes("`messageId`"), "Step 5 names the signal's messageId field (the pointed message)");
  assert.ok(s5.includes("`kind`"), "Step 5 names the signal's kind field");
  assert.ok(
    /acknowledge[\s\S]{0,160}`signalId`/i.test(s5),
    "Step 5 maps the ack's signal id to the signal's signalId field"
  );
});

test("Step 5 watcher fallback states its real preconditions (checkout + room-scoped connection)", () => {
  // The skill says: "Use the read-only watcher from a Project Room checkout:
  // node scripts/agent-inbox.mjs watch start /absolute/private/connection".
  // Following only the skill, a fresh agent cannot run this: the skill gives
  // no checkout location, no way to build ROOM_AGENT_CONFIG (or the env
  // credentials) from the minted identity, and no room — while `watch start`
  // with only an origin + identity credential exits
  // watch_error/invalid_connection (RoomAgentClient requires a valid room).
  // NOTE: the literal ROOM_AGENT_TOKEN must stay out of the skill (existing
  // secret-free contract in tests/agent-discovery.test.js); the fix should
  // name ROOM_AGENT_CONFIG / ROOM_AGENT_ROOM and point at `watch --help`.
  const s5 = step5();
  assert.ok(s5.length > 0, "Step 5 section exists");
  assert.ok(
    s5.includes("github.com/Uuriko/project-room"),
    "Step 5 locates the Project Room checkout (clone URL)"
  );
  assert.ok(
    s5.includes("ROOM_AGENT_CONFIG"),
    "Step 5 explains the saved-connection way to point the watcher at a room"
  );
  assert.ok(
    s5.includes("ROOM_AGENT_ROOM"),
    "Step 5 states the watcher needs a room the agent belongs to"
  );
});

test("watch env mode without ROOM_AGENT_ROOM is invalid_config (watcher needs a room)", () => {
  // Pins the CLI behavior the skill must describe: with only an origin and
  // an identity credential (no room), agentConnectionFromEnvironment throws
  // invalid_config, which `watch start` surfaces as watch_error /
  // invalid_connection. A room-less fresh agent cannot use the fallback.
  assert.throws(
    () => agentConnectionFromEnvironment({
      ROOM_AGENT_ORIGIN: "https://room.trydemigod.com",
      ROOM_AGENT_TOKEN: `pri_${"x".repeat(44)}`,
    }),
    err => err instanceof ConnectionError && err.code === "invalid_config",
    "expected ConnectionError(invalid_config) without ROOM_AGENT_ROOM"
  );
});
