import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHelperAgentExercise } from "../scripts/helper-agent-exercise.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";

test("helper acceptance fixture seeds only context, separates credentials and leaves review pending", async t => {
  const f = await startHelperAgentExercise(); t.after(f.close);
  const config = readAgentConnection(f.manifest.configDirectory), client = new RoomAgentClient(config);
  const access = await client.checkConnection(); assert.equal(access.memberId, "helper");
  const context = await client.workContext(f.manifest.workItemId, { includeOffers: true });
  assert.equal(context.offers.availability.canOffer, true);
  const mcp = await openMcpTestClient(f.manifest.configDirectory);
  try {
    const listed = await mcp.request("tools/list");
    const descriptor = listed.result.tools.find(tool => tool.name === "room_read_work");
    assert.match(descriptor.description, /conversational fallback, not a second offer/);
    const selected = (await mcp.call("room_read_work", { workItemId: f.manifest.workItemId, includeOffers: true })).result;
    assert.equal(selected.structuredContent.offers.availability.canOffer, true);
  } finally { await mcp.close(); }
  const e = f.evidence(); assert.equal(e.messages.length, 1); assert.deepEqual(e.participantEvents, []);
  assert.equal(e.work.accountableMemberId, "owner"); assert.equal(e.work.verification, null); assert.equal(e.work.decision, null);
  assert.ok(e.cursors.every(c => c.sequence === 0));
  const owner = JSON.parse(readFileSync(f.manifest.ownerPath));
  assert.equal(JSON.stringify(e).includes(config.token), false); assert.equal(JSON.stringify(e).includes(owner.token), false);
  await f.close(); assert.equal(existsSync(f.directory), false); await f.close();
});

test("CLI rejects flag-like args instead of treating them as the evidence path (guild-06 fuzz)", t => {
  const script = fileURLToPath(new URL("../scripts/helper-agent-exercise.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "helper-exercise-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const arg of ["--help", "--bogus-flag-xyz"]) {
    const r = spawnSync(process.execPath, [script, arg], { encoding: "utf8", timeout: 20000, cwd: dir });
    assert.equal(r.status, 2, `expected exit 2 for ${arg}, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace on usage error");
    assert.equal(existsSync(join(dir, arg)), false, `must not create a file named ${arg}`);
  }
});
