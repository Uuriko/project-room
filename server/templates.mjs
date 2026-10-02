// Room templates for the public gallery. One module replaces the unwired
// room-templates and work-templates catalogs. Applying a template creates a
// room through the existing account-room path, then records starter channels,
// tasks, and empty-file board claims with stable command ids so an exact
// retry is a duplicate.
import { EVENT_TYPES as T } from "../src/events.js";
import { createWork } from "./work-claims.mjs";
import { ServiceError } from "./service-error.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const task = (id, title, definitionOfDone, labels) => Object.freeze({ id, title, definitionOfDone, ...(labels ? { labels: Object.freeze(labels) } : {}) });
const claim = (id, title) => Object.freeze({ id, title });

const TEMPLATES = Object.freeze([
  Object.freeze({
    slug: "agent-pair",
    title: "Agent pair-programming",
    purpose: "A human and an agent share one room and ship one change at a time.",
    instructions: "Pair on one change at a time. The human steers. The agent takes the next action and leaves a receipt.",
    outputs: "A merged change and a short receipt of what shipped.",
    boundaries: "One change in flight. No spend and no access changes without the human.",
    escalation: "Ask the human before widening the change or touching a secret.",
    channels: Object.freeze(["pair", "review"]),
    tasks: Object.freeze([
      task("agree", "Agree the change", "The human and the agent name the change and the done check."),
      task("next", "Take the next action", "The next action is done and the room can see the result."),
      task("receipt", "Record what shipped", "A receipt names the change and the check that passed."),
    ]),
    claims: Object.freeze([claim("next-change", "Next change")]),
  }),
  Object.freeze({
    slug: "research-swarm",
    title: "Research swarm",
    purpose: "Several agents gather sources and a human decides what is true.",
    instructions: "Collect sources in the open. Mark claims as fact or inference. A human decides what the room treats as true.",
    outputs: "A short synthesis with sources and a recorded decision.",
    boundaries: "Sources stay linked. Unchecked claims stay marked as inference.",
    escalation: "Ask the human when sources disagree or the question changes.",
    channels: Object.freeze(["sources", "synthesis"]),
    tasks: Object.freeze([
      task("questions", "Write the questions", "The room has a short list of questions to answer."),
      task("sources", "Gather sources", "Each question has at least one linked source."),
      task("synthesis", "Write the synthesis", "The synthesis separates facts from inference."),
      task("decide", "Record the decision", "A human records what the room will treat as true."),
    ]),
    claims: Object.freeze([claim("source-pass", "Source pass")]),
  }),
  Object.freeze({
    slug: "launch-checklist",
    title: "Launch checklist",
    purpose: "A checklist for shipping a release.",
    instructions: "Walk the checklist in order. Leave a receipt on each step. Stop and ask when a step fails.",
    outputs: "Each checklist step has a receipt, or a named blocker.",
    boundaries: "Do not announce the launch before the checklist is done.",
    escalation: "Ask the owner when a step fails or the scope grows.",
    channels: Object.freeze(["launch", "blockers"]),
    tasks: Object.freeze([
      task("scope", "Freeze the scope", "The release notes name what is in and what is out."),
      task("checks", "Run the checks", "The checks the room relies on have a result."),
      task("docs", "Update the docs", "The docs match what shipped."),
      task("announce", "Write the announcement", "The announcement is ready for the owner to send."),
      task("watch", "Watch the first hour", "Someone is watching, and the rollback step is written down."),
    ]),
    claims: Object.freeze([claim("release", "Release")]),
  }),
  Object.freeze({
    slug: "bug-bash",
    title: "Bug bash",
    purpose: "Find bugs, label friction, and close the loop with the reporter.",
    instructions: "File each bug as a task. Use the friction label for papercuts. Close the loop with the reporter when it is fixed.",
    outputs: "Each bug is fixed or explicitly deferred, and the reporter has been told.",
    boundaries: "A bug without a repro stays a note, not a promise.",
    escalation: "Ask the owner before changing access or spending.",
    channels: Object.freeze(["bugs", "triage"]),
    tasks: Object.freeze([
      task("repro", "Reproduce the bug", "The room has steps that show the bug."),
      task("friction", "File the friction", "The papercut is a task labeled friction.", ["friction"]),
      task("fix", "Fix and verify", "The fix has a check that fails before and passes after."),
      task("loop", "Close the loop", "The reporter has been told what changed."),
    ]),
    claims: Object.freeze([claim("bash", "Bug bash")]),
  }),
  Object.freeze({
    slug: "weekly-sync",
    title: "Weekly team sync",
    purpose: "A weekly check-in with decisions written down.",
    instructions: "Each person posts what shipped, what is next, and what is blocked. Decisions go in the room, not only in the meeting.",
    outputs: "A written update from each person and any decision the room made.",
    boundaries: "The sync does not assign work someone has not accepted.",
    escalation: "Ask the owner when a blocker needs a decision this week.",
    channels: Object.freeze(["updates", "decisions"]),
    tasks: Object.freeze([
      task("shipped", "Post what shipped", "Each person has a short note on what shipped."),
      task("next-week", "Name next week", "Each person has a next action."),
      task("blockers", "Name blockers", "Each blocker has an owner and a next step."),
    ]),
    claims: Object.freeze([claim("sync", "This week")]),
  }),
  Object.freeze({
    slug: "open-source-triage",
    title: "Open-source triage",
    purpose: "Triage issues and pull requests in the open.",
    instructions: "Sort new issues and pull requests. Say what the room will do, who will do it, and what is waiting on a person.",
    outputs: "Each new item is accepted, deferred, or declined, with the reason in the room.",
    boundaries: "Do not merge code the room has not reviewed.",
    escalation: "Ask a maintainer before declining a contribution or changing the license.",
    channels: Object.freeze(["inbox", "review"]),
    tasks: Object.freeze([
      task("inbox", "Empty the inbox", "Every new issue and pull request has a next step."),
      task("repro-issue", "Confirm the report", "The report has a repro or a question back to the reporter."),
      task("review-pr", "Review the pull request", "The review names what must change, or says it is ready."),
      task("reply", "Reply in the open", "The reporter can see the decision and the reason."),
    ]),
    claims: Object.freeze([claim("triage", "Triage queue")]),
  }),
]);

const bySlug = new Map(TEMPLATES.map(template => [template.slug, template]));

export function listRoomTemplates() {
  return TEMPLATES.map(template => Object.freeze({
    slug: template.slug,
    title: template.title,
    purpose: template.purpose,
  }));
}

export function getRoomTemplate(slug) {
  return bySlug.get(slug) ?? null;
}

const FIELDS = Object.freeze(["roomId", "template", "title", "purpose", "kind", "displayName", "ref"]);

function cleanRef(value) {
  if (value == null) return null;
  if (typeof value !== "string") return false;
  const ref = value.trim();
  if (!ref || ref.length > 80 || /[\u0000-\u001f\u007f]/.test(ref)) return false;
  return ref;
}

// Creates the room, then applies starter records. Command ids are stable, so
// the same request twice returns the same room and does not double the tasks.
export function applyRoomTemplate(store, token, binding, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).some(key => !FIELDS.includes(key))
    || !["roomId", "template", "title", "purpose", "kind", "displayName"].every(key => Object.hasOwn(request, key))) {
    fail(422, "invalid_template", "Supply roomId, template, title, purpose, kind, and displayName");
  }
  const template = getRoomTemplate(request.template);
  if (!template) fail(422, "invalid_template", "Unknown template");
  const ref = cleanRef(request.ref);
  if (ref === false) fail(422, "invalid_template", "ref must be 1 to 80 characters");
  const created = store.createAccountRoom(token, binding, {
    roomId: request.roomId,
    title: request.title,
    purpose: request.purpose,
    kind: request.kind,
    displayName: request.displayName,
  });
  const roomId = created.room.id;
  const send = (id, type, data) => store.command(token, roomId, { id, type, data }, binding);
  send(`tpl-${template.slug}-charter`, T.ROOM_CHARTER_UPDATED, {
    expectedRevision: 0,
    purpose: template.instructions,
    outputs: template.outputs,
    boundaries: template.boundaries,
    escalation: template.escalation,
  });
  for (const name of template.channels) {
    send(`tpl-${template.slug}-ch-${name}`, T.CHANNEL_CREATED, { channelId: `${template.slug}-${name}`, name });
  }
  for (const item of template.tasks) {
    const workItemId = `${template.slug}-${item.id}`;
    send(`tpl-${template.slug}-w-${item.id}`, T.WORK_PROPOSED, {
      workItemId,
      title: item.title,
      definitionOfDone: item.definitionOfDone,
      accountableMemberId: "owner",
      mode: "read",
      ...(item.labels ? { labels: [...item.labels] } : {}),
    });
    // The owner applied this catalog text, so the starter tasks are the ones
    // a later public room page is allowed to show. Other tasks stay private.
    send(`tpl-${template.slug}-pub-${item.id}`, T.WORK_PUBLIC_SET, { workItemId, enabled: true });
  }
  if (store.workClaims) {
    for (const item of template.claims) {
      const id = `${template.slug}-${item.id}`;
      if (store.workClaims.has(roomId, id)) continue;
      store.workClaims.set(roomId, createWork({ id, title: item.title, files: [] }, { agentId: "owner" }));
    }
  }
  return { ...created, template: template.slug, ref };
}
