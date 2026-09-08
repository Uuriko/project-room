import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const guide = readFileSync(new URL("../docs/AGENT-WRITE-GUIDE.md", import.meta.url), "utf8");
const examples = new Map([...guide.matchAll(/<!-- room-command: ([a-z-]+) -->\s*```json\n([\s\S]*?)\n```/g)]
  .map(([, name, json]) => [name, JSON.parse(json)]));
function code(kind, name) {
  const match = guide.match(new RegExp(`<!-- room-${kind}: ${name} -->\\s*\x60\x60\x60js\\n([\\s\\S]*?)\\n\x60\x60\x60`));
  assert.ok(match, `Missing documented ${kind} example: ${name}`);
  return match[1];
}
const prepareCommand = new Function(`${code("code", "prepare")}\nreturn prepareCommand;`)();
const readAssignment = new (Object.getPrototypeOf(async function () {}).constructor)("client", "workId",
  `${code("read", "assignment")}\nreturn { orientation, addressedToMe, work, current, source };`);
const version = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-agent-write-guide-"));
  const store = new RoomStore(join(directory, "synthetic.sqlite"));
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.initialize(initialRoom());
  const ownerToken = store.issueAccessKey("commons", "owner");
  for (const [memberId, permissions] of [["worker", ["accept_work", "complete_work"]], ["author", []], ["reviewer", ["verify"]]]) {
    store.command(ownerToken, "commons", { id: `fixture-add-${memberId}`, type: T.MEMBER_ADDED, data: {
      memberId, displayName: `${memberId} (synthetic guide fixture)`, kind: "agent", permissions, accountableHumanId: "owner"
    } });
  }
  store.command(ownerToken, "commons", { id: "fixture-source", type: T.MESSAGE_POSTED, data: {
    messageId: "guide-source", body: "Synthetic task: prepare an agenda that names its owner. No real work or approval is represented."
  } });
  store.command(ownerToken, "commons", { id: "fixture-propose", type: T.WORK_PROPOSED, data: {
    workItemId: "guide-work", title: "Synthetic guide exercise", definitionOfDone: "Agenda names its owner; exact artifact is reviewed.",
    accountableMemberId: "worker", verifierMemberId: "reviewer", independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner", sourceMessageId: "guide-source", mode: "read"
  } });
  server = createRoomServer({ store });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = token => new RoomAgentClient({ origin, roomId: "commons", token });
  const owner = client(ownerToken), worker = client(store.issueAccessKey("commons", "worker")), reviewer = client(store.issueAccessKey("commons", "reviewer"));
  const current = async actor => (await actor.orient()).work.find(item => item.id === "guide-work");
  const prepared = async (actor, name, fields = {}) => {
    assert.ok(examples.has(name), `No command example ${name}`);
    return prepareCommand(examples.get(name), await current(actor), fields);
  };
  const send = async (actor, name, fields = {}) => actor.command(await prepared(actor, name, fields));
  const complete = async text => {
    // Non-retrievable fixture evidence is deliberate; no hosted artifact or AI execution claim.
    const evidenceVersion = version(text);
    await send(worker, "complete", { summary: text, evidenceVersion,
      evidenceUrl: `https://example.invalid/agent-guide/${evidenceVersion.slice(7)}.txt` });
    return current(reviewer);
  };
  const review = async name => {
    const item = await current(reviewer);
    return prepared(reviewer, name, { completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion });
  };
  return { owner, worker, reviewer, current, prepared, send, complete, review };
}

test("guide shapes stay explicit and complete", () => {
  assert.deepEqual([...examples.keys()], ["accept", "start", "complete", "review-pass", "review-fail", "resolve", "block"]);
  for (const [name, example] of examples) {
    assert.deepEqual(Object.keys(example).sort(), ["data", "id", "type"], name);
    assert.equal(example.data.workItemId, "guide-work", name);
    assert.ok(Number.isSafeInteger(example.data.expectedRevision), name);
  }
  assert.match(guide, /Node 24\.19\+/);
  assert.match(guide, /snapshot\.state\.messages\.find/);
  assert.match(guide, /service validates HTTPS URL syntax, not reachability/);
  assert.match(guide, /Do not call `prepareCommand` again/);
  assert.match(guide, /16,384 UTF-8 bytes/);
});

test("documented reads and writes: real client/store, synthetic pass leaves human decision pending", async t => {
  const f = await fixture(t);
  const read = await readAssignment(f.worker, "guide-work");
  assert.equal(read.orientation.member.id, "worker");
  assert.equal(read.orientation.scope.externalExecution, false);
  assert.equal(read.work.next.action, "accept");
  assert.equal(read.source.id, "guide-source");
  assert.match(read.source.body, /Synthetic task/);
  assert.equal(read.current.mode, "read");

  const pending = await f.prepared(f.worker, "accept");
  const retained = structuredClone(pending);
  const first = await f.worker.command(pending);
  assert.equal(first.duplicate, false);
  assert.equal(first.event.actorId, "worker");
  assert.notEqual(first.event.id, pending.id);
  assert.equal((await f.current(f.worker)).revision, 1);
  // Simulate the caller having lost the first response: resend the retained full command.
  const retry = await f.worker.command(retained);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.sequence, first.sequence);
  assert.deepEqual(retry.event, first.event);
  assert.equal((await f.current(f.worker)).revision, 1);

  await f.send(f.worker, "start");
  assert.equal((await f.current(f.worker)).next.needsAttention, false);
  const text = "Synthetic artifact. Owner: test operator. Agenda: discuss the proposal.";
  const completed = await f.complete(text);
  assert.equal(completed.receipt.evidenceVersion, version(text));
  assert.equal(completed.receipt.reportedById, "worker");
  assert.equal(completed.receipt.producerId, "author");
  assert.equal(completed.receipt.producerAttribution, "reported");
  assert.equal(completed.next.action, "verify");
  await f.reviewer.command(await f.review("review-pass"));
  const waiting = await f.current(f.owner);
  assert.equal(waiting.verification.result, "pass");
  assert.equal(waiting.verification.independenceConfirmed, true);
  assert.equal(waiting.next.action, "decide");
  assert.equal(waiting.next.memberId, "owner");
  assert.equal(waiting.decision, null, "No agent or fixture manufactures human approval");
});

test("documented failed review: resolve, new completion and exact-version rereview", async t => {
  const f = await fixture(t);
  await f.send(f.worker, "accept");
  await f.send(f.worker, "start");
  const draft = await f.complete("Synthetic draft agenda: discuss the proposal.");
  await f.reviewer.command(await f.review("review-fail"));
  const blocked = await f.current(f.worker);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.next.action, "revise");
  assert.match(blocked.blocker.nextAction, /owner/);
  await f.send(f.worker, "resolve");
  assert.equal((await f.current(f.worker)).state, "accepted");
  await f.send(f.worker, "start");
  const corrected = await f.complete("Synthetic corrected agenda. Owner: test operator. Discuss the proposal and record the decision.");
  assert.notEqual(corrected.receipt.eventId, draft.receipt.eventId);
  assert.notEqual(corrected.receipt.evidenceVersion, draft.receipt.evidenceVersion);
  assert.equal(corrected.verification, null);
  assert.equal(corrected.decision, null);
  await f.reviewer.command(await f.review("review-pass"));
  const waiting = await f.current(f.owner);
  assert.equal(waiting.next.action, "decide");
  assert.equal(waiting.verification.completionEventId, corrected.receipt.eventId);
  assert.equal(waiting.verification.evidenceVersion, corrected.receipt.evidenceVersion);
  assert.equal(waiting.decision, null);
  const item = (await f.owner.snapshot()).state.workItems["guide-work"];
  assert.equal(item.receiptHistory.length, 1);
  assert.equal(item.receiptHistory[0].eventId, draft.receipt.eventId);
});

test("documented accountable blocker and recovery use current revisions", async t => {
  const f = await fixture(t);
  await f.send(f.worker, "accept");
  await f.send(f.worker, "start");
  await f.send(f.worker, "block");
  const blocked = await f.current(f.worker);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.blocker.reason, examples.get("block").data.reason);
  await f.send(f.worker, "resolve", { resolution: "Synthetic operator supplied the missing context." });
  await f.send(f.worker, "start");
  assert.equal((await f.current(f.worker)).state, "working");
});
