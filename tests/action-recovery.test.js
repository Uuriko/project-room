import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { confirmsWorkAction } from "../src/workflow.js";
import { retryUnconfirmed } from "../src/client.js";

test("all nine work actions confirm only the exact owned operation, including ordered claim paths", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const item = () => f.store.snapshot(f.keys.owner, "commons").state.workItems.recovery;
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "recovery", title: "Synthetic action recovery", definitionOfDone: "One exact reviewed result", mode: "write",
    accountableMemberId: "owner", independentVerificationRequired: true, verifierMemberId: "reviewer", ownerDecisionRequired: true, humanDecisionMakerId: "owner"
  } });
  const scope = { repository: "test/recovery", ref: "synthetic", paths: ["src/app.js", "test/**"], expiresAt: new Date(Date.now() + 3600000).toISOString() };
  let previous = null;
  const send = async (type, data = {}, actor = "owner") => {
    const command = { id: crypto.randomUUID(), type, ...(previous ? { causationId: previous } : {}), data: { workItemId: "recovery", expectedRevision: item().revision, ...data } };
    const receipt = f.store.command(f.keys[actor], "commons", command), match = candidate => confirmsWorkAction(candidate, command, "commons", actor);
    assert.equal(await match(receipt), true, type);
    assert.equal(await match(f.store.command(f.keys[actor], "commons", command)), true, "exact duplicate");
    for (const candidate of [null, {}, { sequence: 1 }, { ...receipt, sequence: 0 }, { ...receipt, sequence: 1.5 }, { ...receipt, duplicate: 1 }, { ...receipt, event: null }]) assert.equal(await match(candidate), false);
    for (const [key, value] of [["roomId", "elsewhere"], ["actorId", "guest"], ["type", T.MESSAGE_POSTED], ["id", "bad/id"], ["idempotencyKey", "0".repeat(64)], ["at", null], ["at", "invalid"], ["causationId", "not-the-cause"]]) {
      assert.equal(await match({ ...receipt, event: { ...receipt.event, [key]: value } }), false, `${type}/${key}`);
    }
    const reordered = Object.fromEntries(Object.entries(receipt.event.data).reverse());
    assert.equal(await match({ ...receipt, event: { ...receipt.event, data: reordered } }), true, "object key order has no meaning");
    for (const data of [null, [], {}, { ...command.data, extra: true }, { ...command.data, expectedRevision: item().revision }]) {
      assert.equal(await match({ ...receipt, event: { ...receipt.event, data } }), false);
    }
    assert.equal(await confirmsWorkAction(receipt, { ...command, id: crypto.randomUUID() }, "commons", actor), false, "same payload is not another operation's receipt");
    if (type === T.CLAIM_ACQUIRED) {
      assert.equal(await match({ ...receipt, event: { ...receipt.event, data: { ...command.data, paths: [...command.data.paths].reverse() } } }), false);
    }
    previous = receipt.event.id;
    return receipt;
  };
  await send(T.WORK_ACCEPTED);
  await send(T.CLAIM_ACQUIRED, scope);
  await send(T.WORK_STARTED);
  await send(T.CLAIM_RELEASED);
  await send(T.CLAIM_ACQUIRED, scope);
  await send(T.WORK_BLOCKED, { reason: "Synthetic blocker", nextAction: "Resolve it" });
  await send(T.WORK_BLOCKER_RESOLVED, { resolution: "Synthetic resolution" });
  await send(T.WORK_COMPLETED, { summary: "Synthetic result", evidenceUrl: "https://example.invalid/result", evidenceVersion: "v1", producerId: "owner", nextAction: "Review it" });
  const evidence = { completionEventId: item().receipt.eventId, evidenceVersion: "v1" };
  await send(T.VERIFICATION_RECORDED, { ...evidence, result: "pass", summary: "Checked exact v1" }, "reviewer");
  await send(T.OWNER_DECISION_RECORDED, { ...evidence, decision: "approved", reason: "Accept v1" });
});

test("only exact post-ledger scope refusal pairs unlock a pending work action", () => {
  for (const pending of [false, true]) {
    for (const error of [{ status: 409, code: "claim_conflict" }, { status: 422, code: "invalid_claim_scope" }]) assert.equal(retryUnconfirmed(error, pending), false);
    for (const error of [{ status: 422, code: "claim_conflict" }, { status: 409, code: "invalid_claim_scope" }, { status: 500, code: "claim_conflict" }]) assert.equal(retryUnconfirmed(error, pending), true);
  }
});
