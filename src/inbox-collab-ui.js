// Collaboration surface for the inbox (lane C, inbox-agent-collab): thread
// assignment, internal notes, and the human approval queue for agent-drafted
// outbound. Mounted alongside the quarantine panel in the inbox sidebar —
// built here so no static markup changes are needed (same pattern as
// installQuarantineReview in src/inbox-quarantine-ui.js).
//
// The installer talks to an injected `service` (duck-typed async methods:
// getAssignment, assign, release, claim, addNote, listNotes, listApprovals,
// approve, requestEdits, reject) so the wiring stays testable and the HTTP
// layer can bind it later without touching this file. `ownerKey` gates every
// action exactly like the sibling panels; `actor` is the identity actions
// are attributed to. Client-side input validators are exported pure so
// node:test can cover them without a DOM.
export class CollabUiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CollabUiError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new CollabUiError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const collabKinds = Object.freeze(["agent", "human"]);
export const approvalDecisionLabels = Object.freeze({
  pending: "Awaiting review", changes_requested: "Changes requested", approved: "Approved", rejected: "Rejected",
});
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function validateAssignInput({ kind, id, label = null } = {}) {
  check(collabKinds.includes(kind), "collab_invalid_kind", `kind must be one of ${collabKinds.join(",")}`);
  check(typeof id === "string" && idPattern.test(id.trim()), "collab_invalid_id", "id must be a 1..128 character identity");
  if (label !== null && label !== undefined && label !== "")
    check(typeof label === "string" && label.length <= 256, "collab_invalid_label", "label must be at most 256 characters");
  return { kind, id: id.trim(), label: label ? label.trim() : null };
}
export function validateNoteInput(body, tag = null) {
  check(typeof body === "string" && body.trim().length >= 1 && body.length <= 4000,
    "collab_invalid_note", "note body must be 1..4000 characters");
  if (tag !== null && tag !== undefined && tag !== "")
    check(/^[a-z0-9-]{1,32}$/.test(tag), "collab_invalid_tag", "tag must be 1..32 lowercase letters, digits or dashes");
  return { body: body.trim(), tag: tag ? tag : null };
}
export const approvalDecisions = Object.freeze(["approve", "requestEdits", "reject"]);
export function buildApprovalRequest(proposalId, decision, fields = {}) {
  check(typeof proposalId === "string" && proposalId.length >= 1, "collab_invalid_proposal", "proposalId is required");
  check(approvalDecisions.includes(decision), "collab_invalid_decision", `decision must be one of ${approvalDecisions.join(",")}`);
  const actor = fields.by ?? null;
  check(actor !== null && typeof actor === "object" && actor.kind === "human"
    && typeof actor.id === "string" && idPattern.test(actor.id),
    "collab_invalid_actor", "approval actions need a human actor { kind: \"human\", id }");
  if (decision === "approve") {
    const note = fields.note ?? null;
    if (note !== null) check(typeof note === "string" && note.length <= 1000, "collab_invalid_note", "note must be at most 1000 characters");
    return Object.freeze({ proposalId, decision, args: Object.freeze({ by: actor, note: note ? note : null }) });
  }
  if (decision === "requestEdits") {
    check(typeof fields.edits === "string" && fields.edits.trim().length >= 1 && fields.edits.length <= 2000,
      "collab_invalid_edits", "requested edits must be 1..2000 characters");
    return Object.freeze({ proposalId, decision, args: Object.freeze({ by: actor, edits: fields.edits.trim() }) });
  }
  check(typeof fields.reason === "string" && fields.reason.trim().length >= 1 && fields.reason.length <= 1000,
    "collab_invalid_reason", "rejection reason must be 1..1000 characters");
  return Object.freeze({ proposalId, decision, args: Object.freeze({ by: actor, reason: fields.reason.trim() }) });
}

export function installInboxCollab({ ownerKey, service, actor, document: doc = globalThis.document }) {
  check(typeof ownerKey === "function", "collab_invalid_owner", "ownerKey must be a function");
  check(service !== null && typeof service === "object", "collab_invalid_service", "service must be an object");
  check(actor !== null && typeof actor === "object" && collabKinds.includes(actor.kind)
    && typeof actor.id === "string" && idPattern.test(actor.id),
    "collab_invalid_actor", "actor must be an agent or human identity");
  const owns = () => ownerKey() !== null;
  let threadId = null, busy = false;

  const el = (tag, { id = null, className = null, text = null, type = null, placeholder = null } = {}, children = []) => {
    const node = doc.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    if (type) node.type = type;
    if (placeholder) node.placeholder = placeholder;
    for (const child of children) node.append(child);
    return node;
  };
  const button = (label, onClick, { ghost = false } = {}) => {
    const b = el("button", { type: "button", className: ghost ? "button ghost" : "button", text: label });
    b.addEventListener("click", event => { event.preventDefault(); onClick(); });
    return b;
  };
  const status = id => el("p", { id, className: "form-hint" });
  const say = (node, message) => { node.textContent = message; };

  async function guarded(node, work) {
    if (!owns() || busy || !threadId) return;
    busy = true;
    try { await work(); } catch (error) { say(node, `Error: ${error.message ?? error}`); } finally { busy = false; }
  }

  // --- assignment card ---
  const assignStatus = status("inbox-collab-assign-status");
  const kindSelect = el("select", { id: "inbox-collab-kind" });
  for (const kind of collabKinds) {
    const option = doc.createElement("option");
    option.value = kind; option.textContent = kind === "agent" ? "Agent" : "Human";
    kindSelect.append(option);
  }
  const idInput = el("input", { id: "inbox-collab-id", type: "text", placeholder: "identity id, e.g. claude" });
  const labelInput = el("input", { id: "inbox-collab-label", type: "text", placeholder: "display label (optional)" });
  const assigneeLine = el("p", { id: "inbox-collab-assignee", className: "form-hint" });

  const showAssignee = assignment => {
    assigneeLine.textContent = assignment && assignment.status === "assigned"
      ? `Assigned to ${assignment.assignee.label ?? assignment.assignee.id} (${assignment.assignee.kind})`
      : "Unassigned";
  };
  const assignCard = el("div", { className: "inbox-collab-card" }, [
    el("h3", { className: "form-hint", text: "Assignment" }),
    assigneeLine,
    el("div", { className: "inbox-collab-row" }, [kindSelect, idInput, labelInput]),
    el("div", { className: "inbox-collab-row" }, [
      button("Assign", () => guarded(assignStatus, async () => {
        const assignee = validateAssignInput({ kind: kindSelect.value, id: idInput.value, label: labelInput.value });
        const { record } = await service.assign(threadId, assignee, { by: actor });
        showAssignee(record);
        say(assignStatus, record ? "Assignment saved." : "");
      })),
      button("Claim", () => guarded(assignStatus, async () => {
        const record = await service.claim(threadId, actor);
        showAssignee(record);
        say(assignStatus, "Claimed.");
      }), { ghost: true }),
      button("Release", () => guarded(assignStatus, async () => {
        const record = await service.release(threadId, { by: actor });
        showAssignee(record);
        say(assignStatus, "Released.");
      }), { ghost: true }),
    ]),
    assignStatus,
  ]);

  // --- internal notes card (private: never leaves this panel) ---
  const noteStatus = status("inbox-collab-note-status");
  const noteBody = el("textarea", { id: "inbox-collab-note-body", placeholder: "Private side-note — never sent to the channel" });
  const noteTag = el("input", { id: "inbox-collab-note-tag", type: "text", placeholder: "tag (optional)" });
  const notesList = el("div", { id: "inbox-collab-notes" });
  const renderNotes = async () => {
    if (!owns() || !threadId) return;
    const items = await service.listNotes(threadId);
    notesList.replaceChildren();
    for (const note of items) {
      notesList.append(el("article", { className: "inbox-collab-note" }, [
        el("p", { className: "form-hint", text: `${note.author.label ?? note.author.id} · ${note.createdAt}${note.tag ? ` · #${note.tag}` : ""}` }),
        el("p", { text: note.body }),
      ]));
    }
  };
  const noteCard = el("div", { className: "inbox-collab-card" }, [
    el("h3", { className: "form-hint", text: "Internal notes (private)" }),
    notesList,
    noteBody, noteTag,
    button("Add note", () => guarded(noteStatus, async () => {
      const { body, tag } = validateNoteInput(noteBody.value, noteTag.value);
      await service.addNote(threadId, { author: actor, body, tag });
      noteBody.value = ""; noteTag.value = "";
      say(noteStatus, "Note added.");
      await renderNotes();
    })),
    noteStatus,
  ]);

  // --- approval queue card ---
  const approvalStatus = status("inbox-collab-approval-status");
  const approvalsList = el("div", { id: "inbox-collab-approvals" });
  const renderApprovals = async () => {
    if (!owns()) return;
    const items = await service.listApprovals({ status: "pending" });
    approvalsList.replaceChildren();
    say(approvalStatus, items.length ? `${items.length} awaiting review` : "Queue clear.");
    for (const proposal of items) {
      const decisionInput = el("input", { type: "text", placeholder: "edits / reason" });
      const row = el("article", { className: "inbox-collab-approval" }, [
        el("p", { className: "form-hint",
          text: `${proposal.byAgent.label ?? proposal.byAgent.id} → ${proposal.channel} · v${proposal.version}` }),
        el("p", { text: proposal.draft.body }),
        decisionInput,
        el("div", { className: "inbox-collab-row" }, [
          button("Approve", () => guarded(approvalStatus, async () => {
            const request = buildApprovalRequest(proposal.proposalId, "approve", { by: actor });
            await service.approve(request.proposalId, request.args);
            say(approvalStatus, "Approved.");
            await renderApprovals();
          })),
          button("Request edits", () => guarded(approvalStatus, async () => {
            const request = buildApprovalRequest(proposal.proposalId, "requestEdits", { by: actor, edits: decisionInput.value });
            await service.requestEdits(request.proposalId, request.args);
            say(approvalStatus, "Edits requested.");
            await renderApprovals();
          }), { ghost: true }),
          button("Reject", () => guarded(approvalStatus, async () => {
            const request = buildApprovalRequest(proposal.proposalId, "reject", { by: actor, reason: decisionInput.value });
            await service.reject(request.proposalId, request.args);
            say(approvalStatus, "Rejected.");
            await renderApprovals();
          }), { ghost: true }),
        ]),
      ]);
      approvalsList.append(row);
    }
  };
  const approvalCard = el("div", { className: "inbox-collab-card" }, [
    el("h3", { className: "form-hint", text: "Approval queue" }),
    approvalsList,
    button("Refresh", () => guarded(approvalStatus, renderApprovals), { ghost: true }),
    approvalStatus,
  ]);

  function section() {
    let node = doc.getElementById("inbox-collab");
    if (node) return node;
    node = el("section", { id: "inbox-collab", className: "inbox-collab" });
    node.setAttribute("aria-label", "Collaboration");
    node.append(el("h2", { className: "form-hint", text: "Collaboration" }), assignCard, noteCard, approvalCard);
    const anchor = doc.querySelector("#inbox-connections");
    if (anchor && typeof anchor.before === "function") anchor.before(node);
    else doc.body?.append(node);
    return node;
  }

  async function refresh() {
    section();
    if (!owns() || !threadId) return;
    try {
      const assignment = await service.getAssignment(threadId);
      showAssignee(assignment);
      await renderNotes();
    } catch (error) { say(assignStatus, `Error: ${error.message ?? error}`); }
  }
  function setThread(id) { threadId = id; return refresh(); }

  return { section, setThread, refresh, renderApprovals };
}
