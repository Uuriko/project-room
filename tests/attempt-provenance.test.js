import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { receiptCostOf } from "../server/receipt-cards.mjs";
import { collectPublicReceipts } from "../server/public-read-model.mjs";
import { currentWorkRecord } from "../server/work-context.mjs";
import { attemptDeclarationLabel, completionAttemptSnapshot, validateAttemptDeclaration } from "../src/work-item-session.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "attempt-provenance-"));
  const store = new RoomStore(join(dir, "room.sqlite")); store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const token = store.issueAccessKey("commons", "owner");
  const command = (type, data, id = randomUUID()) => store.command(token, "commons", { id, type, data });
  command(T.WORK_PROPOSED, { workItemId: "w", title: "Result", definitionOfDone: "A result", accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false });
  const session = fields => store.mutateWorkSession(token, "commons", { requestId: randomUUID(), workItemId: "w", action: "set_status", ...fields });
  const item = () => store.room("commons").state.workItems.w;
  const complete = () => {
    const messageId = randomUUID(), eventId = randomUUID(), body = "Exact useful result";
    const posted = command(T.MESSAGE_POSTED, { messageId, body, workItemId: "w" }, eventId);
    return { workItemId: "w", summary: "Result", nextAction: "Read", evidenceKind: "room_text", evidenceMessageId: messageId, evidenceMessageEventId: posted.event.id,
      evidenceVersion: `sha256:${createHash("sha256").update(body).digest("hex")}`, previousCompletionEventId: null, producerId: "owner", attempt: 1 };
  };
  return { store, command, session, item, complete };
}

test("completion pins declared attempt metadata through retry, later attempts, and selected read", t => {
  const f = fixture(t);
  const requestId = randomUUID();
  f.session({ requestId, status: "processing", provider: " Local provider ", client: " CLI ", model: " m1 ", budget: { maxSpendCents: 100 } });
  f.session({ requestId, status: "processing", provider: " Local provider ", client: " CLI ", model: " m1 ", budget: { maxSpendCents: 100 } });
  assert.throws(() => f.session({ requestId, status: "processing", provider: "Other", client: "CLI", model: "m1" }));
  f.session({ status: "done", spendCents: 12 });
  const data = f.complete(), id = randomUUID();
  f.command(T.WORK_COMPLETED, data, id);
  const snapshot = structuredClone(f.item().receipt);
  assert.equal(snapshot.attemptSnapshot.provider, "Local provider");
  assert.equal(snapshot.attemptSnapshot.client, "CLI");
  assert.equal(snapshot.attemptSnapshot.attribution, "declared-unverified");
  assert.equal(collectPublicReceipts(f.store).length, 0, "private by default");
  f.command(T.ROOM_PUBLIC_RECEIPTS_SET, { enabled: true });
  const publicRows = collectPublicReceipts(f.store);
  assert.equal(publicRows.length, 1, "published result exists for privacy control");
  for (const privateValue of ["Local provider", "CLI", "attemptSnapshot", "declared-unverified"])
    assert.ok(!JSON.stringify(publicRows).includes(privateValue), privateValue);
  f.session({ status: "processing", provider: "New provider", client: "New client", model: "m2", budget: { maxSpendCents: 2000 } });
  f.session({ status: "done", spendCents: 999 });
  f.command(T.WORK_COMPLETED, data, id);
  assert.deepEqual(f.item().receipt, snapshot);
  assert.deepEqual(currentWorkRecord(f.item()).receipt.attemptSnapshot, snapshot.attemptSnapshot);
  assert.deepEqual(receiptCostOf(f.item()), { spentCents: 12, capCents: 100, model: "m1" });
  assert.equal(f.item().attempts[1].provider, "New provider");
  assert.deepEqual(f.store.rebuildProjection("commons").state.workItems.w.receipt, snapshot);
  assert.match(attemptDeclarationLabel(snapshot.attemptSnapshot), /^Declared, unverified/);
  assert.match(attemptDeclarationLabel(snapshot.attemptSnapshot), /provider: Local provider · client: CLI · model: m1/);
  assert.equal(attemptDeclarationLabel(null), "");
});

test("completion cannot bind missing, running, foreign producer or malformed attempts", t => {
  const f = fixture(t);
  f.session({ status: "processing", provider: "p" });
  const data = f.complete();
  assert.throws(() => f.command(T.WORK_COMPLETED, data), /finished successful attempt/);
  f.session({ status: "done" });
  for (const attempt of [null, 0, -1, 1.5, "1", 2]) assert.throws(() => f.command(T.WORK_COMPLETED, { ...data, attempt }));
  assert.throws(() => f.command(T.WORK_COMPLETED, { ...data, producerId: null }), /reporter.*producer/);
  assert.throws(() => completionAttemptSnapshot(f.item(), 1, "other", "other"), /reporter.*producer/);
  const failed = structuredClone(f.item()); failed.attempts[0].outcome = "failed";
  assert.throws(() => completionAttemptSnapshot(failed, 1, "owner", "owner"), /finished successful attempt/);
  assert.throws(() => completionAttemptSnapshot({ attempts: [] }, 1, "owner", "owner"), /finished successful attempt/);
  const { attempt, ...unbound } = data;
  f.command(T.WORK_COMPLETED, unbound);
  assert.equal(f.item().receipt.attemptSnapshot, undefined);
  assert.deepEqual(receiptCostOf(f.item()), { spentCents: null, capCents: null, model: null });
});

test("provider/client declarations are bounded start-only assertions", t => {
  const f = fixture(t);
  for (const value of ["", " ", "a".repeat(101), "a\nb", "a\u007fb", {}, [], 1]) {
    assert.throws(() => validateAttemptDeclaration(value));
    for (const key of ["provider", "client"]) assert.throws(() => f.session({ status: "processing", [key]: value }));
  }
  assert.equal(validateAttemptDeclaration(" p "), "p");
  f.session({ status: "processing", provider: "p", client: "c" });
  assert.throws(() => f.session({ status: "done", provider: "p" }), e => e.code === "invalid_session_declaration");
  assert.throws(() => f.session({ status: "active", client: "c" }), e => e.code === "invalid_session_declaration");
});


test("SDK forwards bounded start declarations and exact completion attempt", async () => {
  const { RoomAgentClient } = await import("../client/room-agent.mjs");
  const calls = [];
  const client = new RoomAgentClient({ origin: "https://example.test", roomId: "commons", token: "x".repeat(43), memberId: "owner",
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } });
  client.checkConnection = async () => ({ status: "credential_accepted" }); // isolate request field forwarding
  await client.workSessionAction({ requestId: "r1", workItemId: "w", action: "set_status", status: "processing", provider: "p", client: "c", model: "m", environment: "local" });
  assert.deepEqual(calls[0].body, { requestId: "r1", workItemId: "w", action: "set_status", status: "processing", provider: "p", client: "c", model: "m", environment: "local" });
  const { workTools } = await import("../client/work-actions.mjs");
  for (const name of ["room_record_completion", "room_submit_text_result"]) {
    const action = workTools.find(a => a.name === name);
    assert.equal(action.inputSchema.properties.attempt.type, "integer");
    assert.equal(action.inputSchema.required.includes("attempt"), false);
  }
});
