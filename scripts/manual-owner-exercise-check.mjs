// Scripted answers qualify the harness only; they are not actual-agent acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHelperAgentExercise } from "./helper-agent-exercise.mjs";
import { runManualOwnerExercise } from "./manual-owner-exercise.mjs";

for (const mobile of [false, true]) test(`manual owner exercise ${mobile ? "mobile" : "desktop"}: copy, reconnect, exact return, unknown producer`, async t => {
  const f = await startHelperAgentExercise(); t.after(f.close);
  const exported = await runManualOwnerExercise({ ownerPath: f.manifest.ownerPath, stage: "export", output: join(f.directory, "export"), mobile });
  assert.equal(exported.beforeSequence, exported.afterSequence);
  const body = "A scripted test answer — not a model exercise.";
  const answerPath = join(f.directory, "answer.md");
  writeFileSync(answerPath, exported.packet.split("\n").find(line => line.startsWith("ROOM-RETURN ")) + "\n\n" + body, { flag: "wx" });
  const returned = await runManualOwnerExercise({ ownerPath: f.manifest.ownerPath, stage: "return", answerPath, output: join(f.directory, "return"), mobile });
  // The return posts two commands (message.posted, work.completed); the
  // server appends a third event — completion also settles the work item's
  // claim (work_claim.updated, claimState "delivered"; server/work-claims.mjs),
  // a coupling added after this check was written. Pin the exact event
  // sequence so the "nothing unexpected happened" guarantee keeps its strength.
  assert.equal(returned.afterSequence, exported.afterSequence + 3);
  assert.deepEqual(f.evidence().participantEvents.map(entry => entry.event.type),
    ["message.posted", "work.completed", "work_claim.updated"]);
  assert.equal(returned.selectedResult.result.text.body, body);
  assert.equal(returned.work.receipt.producerId, null); assert.equal(returned.work.verification, null); assert.equal(returned.work.decision, null);
  assert.ok(f.evidence().cursors.every(cursor => cursor.sequence === 0));
});
