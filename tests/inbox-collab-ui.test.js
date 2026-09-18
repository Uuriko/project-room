// LANE C (quill/inbox-agent-collab): client wiring for the collaboration
// surface — assignment, internal notes, and the approval queue. The DOM is a
// minimal fake (the real panels are covered by browser checks); the service
// is the real pure modules behind an async duck-typed facade, exactly the
// shape the future HTTP layer will implement.
import test from "node:test";
import assert from "node:assert/strict";
import { CollabUiError, approvalDecisions, approvalDecisionLabels, buildApprovalRequest,
  collabKinds, installInboxCollab, validateAssignInput, validateNoteInput } from "../src/inbox-collab-ui.js";
import { createAssignmentJournal } from "../server/inbox-assign.mjs";
import { createInternalNotes } from "../server/inbox-internal-notes.mjs";
import { createApprovalQueue } from "../server/inbox-approval.mjs";

const human = { kind: "human", id: "john", label: "John" };
const agent = { kind: "agent", id: "claude", label: "Claude" };
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof CollabUiError); assert.equal(error.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};

// --- minimal fake DOM: only what installInboxCollab touches ---
function makeFakeDocument() {
  const byId = new Map();
  class FakeElement {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.dataset = {};
      this.textContent = ""; this.value = ""; this.className = "";
      this.type = ""; this.placeholder = ""; this.listeners = {};
      this.attributes = {}; this.parent = null; this._id = "";
    }
    get id() { return this._id; }
    set id(value) { this._id = value; if (value) byId.set(value, this); }
    append(...kids) { for (const kid of kids) this.appendChild(kid); return this; }
    appendChild(kid) { if (kid == null) return kid; this.children.push(kid); kid.parent = this; return kid; }
    replaceChildren() { this.children = []; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    click() { for (const fn of this.listeners.click ?? []) fn({ preventDefault() {} }); }
  }
  const body = new FakeElement("body");
  return {
    createElement: tag => new FakeElement(tag),
    getElementById: id => byId.get(id) ?? null,
    querySelector: selector => selector.startsWith("#") ? (byId.get(selector.slice(1)) ?? null) : null,
    body, __byId: byId,
  };
}
const buttonsIn = root => {
  const found = [];
  const walk = node => { if (node.listeners?.click?.length) found.push(node); for (const kid of node.children) walk(kid); };
  walk(root);
  return found;
};
const clickByLabel = (root, label) => {
  const match = buttonsIn(root).find(b => b.textContent === label);
  assert.ok(match, `button "${label}" exists`);
  match.click();
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function makeService() {
  const assign = createAssignmentJournal();
  const notes = createInternalNotes();
  const approvals = createApprovalQueue();
  return {
    async getAssignment(threadId) { return assign.get(threadId); },
    async assign(threadId, assignee, opts) { return assign.assign(threadId, assignee, opts); },
    async release(threadId, opts) { return assign.release(threadId, opts); },
    async claim(threadId, identity) { return assign.claim(threadId, identity); },
    async addNote(threadId, fields) { return notes.addNote(threadId, fields); },
    async listNotes(threadId) { return notes.listNotes(threadId); },
    async listApprovals({ status } = {}) { return approvals.list({ status }); },
    async approve(proposalId, args) { return approvals.approve(proposalId, args); },
    async requestEdits(proposalId, args) { return approvals.requestEdits(proposalId, args); },
    async reject(proposalId, args) { return approvals.reject(proposalId, args); },
    _approvals: approvals,
  };
}
test("pure validators accept good input and reject bad input with codes", () => {
  assert.deepEqual(validateAssignInput({ kind: "agent", id: "claude", label: "Claude" }),
    { kind: "agent", id: "claude", label: "Claude" });
  assert.deepEqual(validateAssignInput({ kind: "human", id: "john" }), { kind: "human", id: "john", label: null });
  expectCode(() => validateAssignInput({ kind: "robot", id: "x" }), "collab_invalid_kind");
  expectCode(() => validateAssignInput({ kind: "agent", id: "not an id!" }), "collab_invalid_id");
  assert.deepEqual(validateNoteInput("  remember this  ", "followup"), { body: "remember this", tag: "followup" });
  expectCode(() => validateNoteInput("   "), "collab_invalid_note");
  expectCode(() => validateNoteInput("ok", "BAD"), "collab_invalid_tag");
  const approved = buildApprovalRequest("p-1", "approve", { by: human, note: "fine" });
  assert.equal(approved.decision, "approve");
  assert.deepEqual(approved.args.by, human);
  const edits = buildApprovalRequest("p-1", "requestEdits", { by: human, edits: " softer " });
  assert.equal(edits.args.edits, "softer");
  const rejected = buildApprovalRequest("p-1", "reject", { by: human, reason: " wrong thread " });
  assert.equal(rejected.args.reason, "wrong thread");
  expectCode(() => buildApprovalRequest("p-1", "approve", { by: agent }), "collab_invalid_actor");
  expectCode(() => buildApprovalRequest("p-1", "requestEdits", { by: human, edits: "" }), "collab_invalid_edits");
  expectCode(() => buildApprovalRequest("p-1", "reject", { by: human, reason: "" }), "collab_invalid_reason");
  expectCode(() => buildApprovalRequest("p-1", "vaporize", { by: human }), "collab_invalid_decision");
});
test("install validates its wiring arguments", () => {
  const doc = makeFakeDocument();
  expectCode(() => installInboxCollab({ ownerKey: "nope", service: makeService(), actor: human, document: doc }), "collab_invalid_owner");
  expectCode(() => installInboxCollab({ ownerKey: () => "o", service: null, actor: human, document: doc }), "collab_invalid_service");
  expectCode(() => installInboxCollab({ ownerKey: () => "o", service: makeService(), actor: { kind: "robot", id: "x" }, document: doc }), "collab_invalid_actor");
  // An agent identity is a legitimate actor (agents assign/claim/note too);
  // human-only gating lives on the approval actions themselves.
  installInboxCollab({ ownerKey: () => "o", service: makeService(), actor: agent, document: doc });
});
test("section builds once and mounts the three cards", () => {
  const doc = makeFakeDocument();
  const ui = installInboxCollab({ ownerKey: () => "owner", service: makeService(), actor: human, document: doc });
  const first = ui.section(), second = ui.section();
  assert.equal(first, second, "section is built once");
  assert.equal(first.id, "inbox-collab");
  assert.ok(doc.getElementById("inbox-collab-assign-status"));
  assert.ok(doc.getElementById("inbox-collab-note-body"));
  assert.ok(doc.getElementById("inbox-collab-approvals"));
});
test("assign flow: inputs → service → assignee line updates", async () => {
  const doc = makeFakeDocument();
  const ui = installInboxCollab({ ownerKey: () => "owner", service: makeService(), actor: human, document: doc });
  await ui.setThread("thread:1");
  await flush();
  assert.equal(doc.getElementById("inbox-collab-assignee").textContent, "Unassigned");
  doc.getElementById("inbox-collab-kind").value = "agent";
  doc.getElementById("inbox-collab-id").value = "claude";
  clickByLabel(doc.getElementById("inbox-collab"), "Assign");
  await flush();
  assert.match(doc.getElementById("inbox-collab-assignee").textContent, /claude/);
  clickByLabel(doc.getElementById("inbox-collab"), "Release");
  await flush();
  assert.equal(doc.getElementById("inbox-collab-assignee").textContent, "Unassigned");
});
test("note flow: composer → service → note renders in the private list", async () => {
  const doc = makeFakeDocument();
  const ui = installInboxCollab({ ownerKey: () => "owner", service: makeService(), actor: human, document: doc });
  await ui.setThread("thread:1");
  await flush();
  doc.getElementById("inbox-collab-note-body").value = "Sender wants Tuesday.";
  doc.getElementById("inbox-collab-note-tag").value = "followup";
  clickByLabel(doc.getElementById("inbox-collab"), "Add note");
  await flush();
  const list = doc.getElementById("inbox-collab-notes");
  assert.equal(list.children.length, 1);
  assert.match(list.children[0].children[1].textContent, /Sender wants Tuesday/);
  assert.equal(doc.getElementById("inbox-collab-note-body").value, "");
});
test("approval flow: pending proposals render; Approve clears them", async () => {
  const doc = makeFakeDocument();
  const service = makeService();
  service._approvals.propose("thread:1", { draft: { body: "Draft reply here." }, byAgent: agent, channel: "email" });
  const ui = installInboxCollab({ ownerKey: () => "owner", service, actor: human, document: doc });
  await ui.setThread("thread:1");
  await ui.renderApprovals();
  await flush();
  assert.match(doc.getElementById("inbox-collab-approval-status").textContent, /1 awaiting review/);
  const list = doc.getElementById("inbox-collab-approvals");
  assert.equal(list.children.length, 1);
  clickByLabel(list, "Approve");
  await flush();
  assert.equal(list.children.length, 0);
  assert.equal(doc.getElementById("inbox-collab-approval-status").textContent, "Queue clear.");
});
test("actions are inert without ownership or a selected thread", async () => {
  const doc = makeFakeDocument();
  const service = makeService();
  const ui = installInboxCollab({ ownerKey: () => null, service, actor: human, document: doc });
  await ui.setThread("thread:1");
  await flush();
  doc.getElementById("inbox-collab-kind").value = "agent";
  doc.getElementById("inbox-collab-id").value = "claude";
  clickByLabel(doc.getElementById("inbox-collab"), "Assign");
  await flush();
  // Without ownership the panel never renders state and the service is untouched.
  assert.equal(doc.getElementById("inbox-collab-assignee").textContent, "");
  assert.equal(await service.getAssignment("thread:1"), null);
});
test("exported labels stay frozen", () => {
  assert.deepEqual([...collabKinds], ["agent", "human"]);
  assert.deepEqual([...approvalDecisions], ["approve", "requestEdits", "reject"]);
  assert.equal(approvalDecisionLabels.pending, "Awaiting review");
  assert.ok(Object.isFrozen(collabKinds) && Object.isFrozen(approvalDecisions) && Object.isFrozen(approvalDecisionLabels));
});
