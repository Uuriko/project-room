// A team_skill call must not break the recovery audit, which gates
// backupRoom, room export and restore for the whole database.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { callSkillTool } from "../server/skill-tool-dispatch.mjs";

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), "r229-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  return store;
}
// The hosted MCP dispatcher always passes kind "agent" (server/mcp-full-profile.mjs).
const agentA = { kind: "agent", id: "agent-a", label: "Agent A" };

test("recovery audit passes before any team_skill call (baseline)", t => {
  const store = fresh(t);
  assert.doesNotThrow(() => auditRecovery(store));
});

test("recovery audit still passes after one team_skill save", t => {
  const store = fresh(t);
  callSkillTool(store, "commons", agentA, "team_skill", { action: "save", name: "Release notes", instructions: "Write release notes from the merged PR list." });
  assert.doesNotThrow(() => auditRecovery(store));
});

