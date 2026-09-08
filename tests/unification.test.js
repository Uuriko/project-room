import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextWorkStep, terminalWork, workStatus } from "../src/workflow.js";
import * as compatibility from "../src/work-status.js";
import { needsAttention, workInvolvingMe } from "../server/return-selectors.mjs";
import { ConversationDrafts, DraftRecovery, draftRecoveryScope } from "../src/conversation.js";
import { ReturnBrief } from "../src/return-brief.js";

const work = () => ({
  id: "work", revision: 5, state: "completed", accountableMemberId: "producer",
  verifierMemberId: "reviewer", humanDecisionMakerId: "owner",
  independentVerificationRequired: true, ownerDecisionRequired: true,
  receipt: { eventId: "completion", evidenceVersion: "v2", producerAttribution: "reported", producerId: "producer" },
  verification: { result: "pass", completionEventId: "completion", evidenceVersion: "v2", verifierId: "reviewer", independenceConfirmed: true },
  decision: { decision: "approved", completionEventId: "completion", evidenceVersion: "v2" }
});

test("one work model drives browser compatibility, API next step and return selectors", () => {
  assert.equal(compatibility.workStatus, workStatus);
  assert.equal(compatibility.terminalWork, terminalWork);
  const cases = [
    [i => {}, "complete", false],
    [i => { i.decision.evidenceVersion = "v1"; }, "decide", true],
    [i => { i.decision.completionEventId = "old"; }, "decide", true],
    [i => { i.verification.evidenceVersion = "v1"; }, "verify", true],
    [i => { i.verification.independenceConfirmed = false; }, "verify", true],
    [i => { i.receipt.producerId = "reviewer"; }, "resolve_independence", true],
    [i => { i.receipt.producerAttribution = "unknown"; }, "establish_provenance", true],
    [i => { i.receipt = null; }, "provide_evidence", true],
    [i => { i.state = "blocked"; }, "revise", true],
    [i => { i.state = "working"; }, "in_progress", false],
    [i => { i.state = "superseded"; }, "superseded", false]
  ];
  for (const [change, action, attention] of cases) {
    const item = work(); change(item);
    const next = nextWorkStep(item);
    assert.equal(next.action, action);
    assert.equal(next.needsAttention, attention);
    assert.equal(workStatus(item).owner, next.memberId);
    assert.equal(terminalWork(item), ["complete", "superseded"].includes(action));
    const allAttention = ["producer", "reviewer", "owner"].flatMap(memberId => needsAttention({ workItems: { work: item }, memberId }));
    assert.equal(allAttention.length, attention ? 1 : 0);
    if (attention) assert.equal(allAttention[0].step, action);
    assert.equal(workInvolvingMe({ workItems: { work: item }, memberId: "producer" }).length, terminalWork(item) ? 0 : 1);
  }
});

test("draft recovery isolates account, epoch, room, member and session without storing credentials", () => {
  const identity = { account: { id: "account", authEpoch: 0 }, roomId: "room", member: { id: "person" }, sessionBinding: "binding", csrf: "not-a-draft-field" };
  const memory = new Map();
  const storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) };
  const recovery = new DraftRecovery(storage);
  const drafts = new ConversationDrafts(); drafts.save(null, { body: "Unsent thought" });
  const state = { messages: [], members: { person: { active: true } } };
  const scope = draftRecoveryScope(identity);
  assert.ok(scope);
  assert.equal(recovery.write(scope, drafts, null), true);
  assert.equal(recovery.read(scope, state).drafts.get(null).body, "Unsent thought");
  assert.ok(!storage.getItem(recovery.key).includes(identity.csrf));
  for (const change of [
    i => { i.account.id = "replacement"; }, i => { i.account.authEpoch++; },
    i => { i.roomId = "other"; }, i => { i.member.id = "other"; },
    i => { i.sessionBinding = "replacement"; }, i => { delete i.account; }
  ]) {
    recovery.write(scope, drafts, null);
    const changed = structuredClone(identity); change(changed);
    assert.equal(recovery.read(draftRecoveryScope(changed), state), null);
    assert.equal(memory.size, 0);
  }
  assert.equal(recovery.write(null, drafts, null), false);
});

test("an unchanged member cannot own catch-up work from another account epoch or browser session", () => {
  for (const change of [
    s => { s.account.id = "other"; }, s => { s.account.authEpoch++; },
    s => { s.sessionBinding = "other"; }
  ]) {
    const client = { generation: 0, session: { account: { id: "a", authEpoch: 0 }, roomId: "r", member: { id: "m" }, sessionBinding: "s" } };
    const view = new ReturnBrief(client);
    const chain = view.chain = { owner: view.owner() };
    assert.equal(view.owns(chain), true);
    change(client.session);
    assert.equal(view.owns(chain), false);
  }
});

test("browser entry wires both invitation paths and unified catch-up, not two next-step displays", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  for (const name of ["installShareLinks", "AccountClient", "ReturnBrief", "draftRecoveryScope", "nextWorkStep"]) assert.ok(app.includes(name));
  assert.equal((app.match(/function renderComposerError\(/g) || []).length, 1);
  assert.ok(!app.includes('next.className = "work-next"'));
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).scripts;
  assert.ok(scripts["test:browser"].includes("invitation-check.mjs"));
  assert.ok(scripts["test:browser"].includes("composer-browser-check.mjs"));
});
