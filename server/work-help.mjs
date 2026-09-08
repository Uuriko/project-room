import { WORK_HELP_UPDATED, helpFromEvent, validateHelp } from "../src/work-help.js";

const own = (value, key) => value != null && Object.hasOwn(value, key);
const check = condition => { if (!condition) throw new Error("Help invitation history requires operator reconciliation"); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
const workFields = ["id", "title", "definitionOfDone", "mode", "accountableMemberId", "verifierMemberId",
  "independentVerificationRequired", "humanDecisionMakerId", "ownerDecisionRequired", "sourceMessageId", "state", "revision"];
const memberFields = ["id", "kind", "active", "revision", "permissions"];
const workFacts = item => ({ ...pick(item, workFields), receipt: item?.receipt ? pick(item.receipt, ["eventId", "evidenceVersion"]) : null });
const helpMap = state => Object.fromEntries(Object.entries(state.workItems ?? {}).filter(([, item]) => own(item, "helpWanted"))
  .map(([id, item]) => [id, validateHelp(item.helpWanted)]));
const mutations = new Set(["work.accepted", "work.started", "work.blocked", "work.blocker_resolved", "work.completed",
  "work.superseded", "claim.acquired", "claim.released", "verification.recorded", "owner.decision_recorded"]);
const transitions = { "work.accepted": "accepted", "work.started": "working", "work.blocked": "blocked",
  "work.blocker_resolved": "accepted", "work.completed": "completed", "work.superseded": "superseded" };

// Reconstruct only facts needed for help consent. Do not run legacy work through
// today's completion/verification authorization rules. Check both retained help
// events and their supporting facts, even when hidden by a projection checkpoint.
export function auditWorkHelp(state, history, checkpoint = null) {
  const events = history.map(row => ({ sequence: row.sequence, event: typeof row.body === "string" ? JSON.parse(row.body) : row.event }));
  const relevant = new Set(events.filter(row => row.event.type === WORK_HELP_UPDATED).map(row => row.event.data.workItemId));
  if (!relevant.size) {
    check(!Object.keys(helpMap(state)).length);
    if (checkpoint) check(!Object.keys(helpMap(JSON.parse(checkpoint.projection))).length);
    return;
  }
  const projected = { room: null, members: {}, workItems: {} };
  const compare = actual => {
    const expected = helpMap(projected);
    check(canonical(helpMap(actual)) === canonical(expected));
    if (!Object.keys(expected).length) return;
    check(actual.room?.id === projected.room.id && actual.room.ownerId === projected.room.ownerId);
    const participants = new Set([projected.room.ownerId]);
    for (const id of Object.keys(expected)) {
      check(canonical(workFacts(actual.workItems?.[id])) === canonical(workFacts(projected.workItems[id])));
      participants.add(projected.workItems[id].accountableMemberId);
    }
    for (const id of participants) check(canonical(pick(actual.members?.[id], memberFields)) === canonical(pick(projected.members[id], memberFields)));
  };
  let checkpointChecked = !checkpoint;
  if (checkpoint?.sequence === 0) { compare(JSON.parse(checkpoint.projection)); checkpointChecked = true; }
  for (const { sequence, event: e } of events) {
    const d = e.data;
    if (e.type === "room.created") { check(!projected.room); projected.room = { id: e.roomId, ownerId: d.ownerId }; }
    if (["member.added", "member.joined_via_invitation"].includes(e.type)) {
      check(!own(projected.members, d.memberId) && Array.isArray(d.permissions));
      projected.members[d.memberId] = { id: d.memberId, kind: e.type === "member.added" ? d.kind : "human",
        active: true, revision: 0, permissions: d.permissions };
    }
    if (e.type === "member.access_changed") {
      const person = projected.members[d.memberId];
      check(person && typeof d.active === "boolean" && Array.isArray(d.permissions) && d.expectedMemberRevision === person.revision);
      Object.assign(person, { active: d.active, permissions: d.permissions, revision: person.revision + 1 });
    }
    if (relevant.has(d.workItemId)) {
      if (e.type === "work.proposed") {
        check(!own(projected.workItems, d.workItemId));
        projected.workItems[d.workItemId] = { id: d.workItemId, title: d.title, definitionOfDone: d.definitionOfDone,
          accountableMemberId: d.accountableMemberId, mode: d.mode || "read", verifierMemberId: d.verifierMemberId || null,
          independentVerificationRequired: d.independentVerificationRequired === true, humanDecisionMakerId: d.humanDecisionMakerId || null,
          ownerDecisionRequired: d.ownerDecisionRequired === true, sourceMessageId: d.sourceMessageId || null,
          state: "proposed", revision: 0, receipt: null };
      }
      if (mutations.has(e.type)) {
        const item = projected.workItems[d.workItemId];
        check(item && d.expectedRevision === item.revision);
        if (transitions[e.type]) item.state = transitions[e.type];
        if (e.type === "work.completed") item.receipt = { eventId: e.id, evidenceVersion: d.evidenceVersion };
        if (e.type === "verification.recorded" && d.result === "fail" && d.completionEventId === item.receipt?.eventId
          && d.evidenceVersion === item.receipt?.evidenceVersion) item.state = "blocked";
        if (e.type === "owner.decision_recorded" && d.decision !== "approved") item.state = "blocked";
        item.revision++;
      }
      if (e.type === WORK_HELP_UPDATED) {
        const help = helpFromEvent(projected, e);
        projected.workItems[d.workItemId].helpWanted = help;
      }
    }
    if (checkpoint && sequence === checkpoint.sequence) { compare(JSON.parse(checkpoint.projection)); checkpointChecked = true; }
  }
  check(checkpointChecked); compare(state);
}
