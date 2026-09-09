import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { startHelperAgentExercise } from "../scripts/helper-agent-exercise.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { readAgentConnection } from "../client/agent-connection.mjs";

test("helper acceptance fixture seeds only context, separates credentials and leaves review pending", async t => {
  const f = await startHelperAgentExercise(); t.after(f.close);
  const config = readAgentConnection(f.manifest.configDirectory), client = new RoomAgentClient(config);
  const access = await client.checkConnection(); assert.equal(access.memberId, "helper");
  const context = await client.workContext(f.manifest.workItemId, { includeOffers: true });
  assert.equal(context.offers.availability.canOffer, true);
  const e = f.evidence(); assert.equal(e.messages.length, 1); assert.deepEqual(e.participantEvents, []);
  assert.equal(e.work.accountableMemberId, "owner"); assert.equal(e.work.verification, null); assert.equal(e.work.decision, null);
  assert.ok(e.cursors.every(c => c.sequence === 0));
  const owner = JSON.parse(readFileSync(f.manifest.ownerPath));
  assert.equal(JSON.stringify(e).includes(config.token), false); assert.equal(JSON.stringify(e).includes(owner.token), false);
  await f.close(); assert.equal(existsSync(f.directory), false); await f.close();
});
