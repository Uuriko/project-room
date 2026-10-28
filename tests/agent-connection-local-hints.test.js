import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAgentConnection, agentConnectionFromEnvironment, connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";

// qa1-r1 (2026-10-09, prod a82c8d43): a new agent following Add agent ->
// "Import only if needed: pbpaste | node scripts/agent-inbox.mjs import <dir>"
// into a directory it had just created got config_exists with the hint
// "Unknown error 'config_exists' ... this code has no known recovery" and
// next room_check_access / room_list_work, tools it cannot reach without a
// saved connection. Local setup codes must name their own recovery.

const config = { version: 1, origin: "https://room.example", roomId: "room-a", memberId: "agent-a", token: "T".repeat(43) };
const LOCAL = ["usage_error", "invalid_config", "config_not_found", "config_not_private", "ambiguous_config", "config_exists", "config_save_failed"];

test("every local setup code gets a specific hint and runnable next steps", () => {
  for (const code of LOCAL) {
    const output = connectionDiagnostic(new ConnectionError(code));
    assert.equal(output.code, code);
    assert.equal(output.reason, code, code);
    assert.equal(output.status, "action_required", code);
    assert.doesNotMatch(output.hint, /Unknown error|no known recovery/, code);
    assert.ok(output.next.length >= 1, code);
    for (const step of output.next) {
      assert.ok(typeof step.command === "string" && step.command.length > 0, code);
      assert.equal(step.tool, undefined, `${code} must not send the agent to a room tool it cannot reach`);
    }
  }
});

test("import into an existing directory says how to recover (real save path)", t => {
  const root = mkdtempSync(join(tmpdir(), "qa1-conn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "room-agent");
  mkdirSync(target, { mode: 0o700 });
  let caught;
  try { saveAgentConnection(target, config); } catch (error) { caught = error; }
  const output = connectionDiagnostic(caught);
  assert.equal(output.code, "config_exists");
  assert.match(output.next.map(step => step.command).join(" "), /does not exist yet/);
  assert.ok(!JSON.stringify(output).includes(config.token));
});

test("a missing saved connection points at ROOM_AGENT_CONFIG and import", () => {
  let caught;
  try { agentConnectionFromEnvironment({ ROOM_AGENT_CONFIG: join(tmpdir(), "qa1-missing-" + Date.now()) }); } catch (error) { caught = error; }
  const output = connectionDiagnostic(caught);
  assert.equal(output.code, "config_not_found");
  assert.match(output.next.map(step => step.command).join(" "), /ROOM_AGENT_CONFIG/);
});

test("server-side failures still use the shared agent error guidance", () => {
  const output = connectionDiagnostic(new TypeError("fetch failed"));
  assert.equal(output.code, "service_unavailable");
  assert.ok(output.next.some(step => step.tool === "room_check_access"));
});
