// Explicit in-room contribution invitations. Not assignment, execution or payment.
// Storage registration requires the matching writer13 migration and recovery audit.
export const WORK_HELP_UPDATED = "work.help_updated";
export const HELP_SCOPE_LIMIT = 600;
export const HELP_MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const own = (value, key) => value != null && Object.hasOwn(value, key);
const id = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value);
const revision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const text = value => typeof value === "string" && value.length <= HELP_SCOPE_LIMIT && value.trim().length > 0 && value.isWellFormed();
const check = (valid, message = "Invalid help invitation") => { if (!valid) throw new Error(message); };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const accepting = item => ["accepted", "working", "blocked"].includes(item.state);
const member = (state, memberId) => {
  if (!id(memberId) || !own(state.members, memberId)) return null;
  const person = state.members[memberId];
  check(person?.id === memberId && ["human", "agent"].includes(person.kind), "Invalid help participant");
  return person;
};
const active = person => person?.active === true && id(person.id) && revision(person.revision);
const mayPublish = (item, person) => accepting(item) && active(person) && person.id === item.accountableMemberId
  && Array.isArray(person.permissions) && person.permissions.includes("accept_work");
const mayWithdraw = (state, item, person) => active(person)
  && (person.id === item.accountableMemberId || person.id === state.room.ownerId && person.kind === "human");
const fields = ["id", "revision", "eventId", "status", "workItemId", "workBasisRevision", "accountableMemberId",
  "accountableRevision", "completionEventId", "scope", "expiresAt", "createdAt", "openedAt", "openedById", "updatedAt", "updatedById"];

export function validateHelpData(data) {
  const keys = ["workItemId", "expectedRevision", "expectedHelpRevision", "status"];
  check(data?.status === "open" || data?.status === "withdrawn");
  if (data.status === "open") keys.push("scope", "expiresAt");
  check(exactKeys(data, keys) && id(data.workItemId) && revision(data.expectedRevision) && revision(data.expectedHelpRevision));
  if (data.status === "open") check(text(data.scope) && instant(data.expiresAt), "Add a short scope and an explicit expiry");
  return data;
}

export function validateHelp(help) {
  check(exactKeys(help, fields) && ["open", "withdrawn"].includes(help.status));
  check(["id", "eventId", "workItemId", "accountableMemberId", "openedById", "updatedById"].every(key => id(help[key])));
  check(revision(help.revision) && help.revision > 0 && revision(help.workBasisRevision) && revision(help.accountableRevision));
  check(help.completionEventId === null || id(help.completionEventId));
  check(text(help.scope) && ["createdAt", "openedAt", "updatedAt", "expiresAt"].every(key => instant(help[key])));
  check(Date.parse(help.createdAt) <= Date.parse(help.openedAt) && Date.parse(help.openedAt) <= Date.parse(help.updatedAt));
  const duration = Date.parse(help.expiresAt) - Date.parse(help.openedAt);
  check(duration > 0 && duration <= HELP_MAX_DURATION_MS);
  check(help.openedById === help.accountableMemberId);
  if (help.status === "open") check(help.updatedById === help.openedById && help.updatedAt === help.openedAt);
  if (help.revision === 1) check(help.status === "open" && help.id === help.eventId && help.createdAt === help.openedAt);
  return help;
}

function work(state, workItemId) {
  check(id(workItemId) && own(state.workItems, workItemId), "Unknown Work Item");
  const item = state.workItems[workItemId];
  check(item.id === workItemId && revision(item.revision) && id(item.accountableMemberId));
  if (item.receipt != null) check(id(item.receipt.eventId));
  return item;
}

function priorHelp(item) {
  if (!own(item, "helpWanted")) return null; // Absence is not consent, including legacy data.
  const help = validateHelp(item.helpWanted);
  check(help.workItemId === item.id && help.workBasisRevision <= item.revision);
  return help;
}

// Returns a new projection without mutating the input. The event reducer/service
// owns envelope idempotency, authentication, transaction and capacity checks.
export function helpFromEvent(state, incoming) {
  check(incoming?.type === WORK_HELP_UPDATED && id(incoming.id) && id(incoming.actorId)
    && id(incoming.roomId) && incoming.roomId === state.room?.id && instant(incoming.at));
  const data = validateHelpData(incoming.data), item = work(state, data.workItemId), prior = priorHelp(item);
  const actor = member(state, incoming.actorId);
  check(active(actor), "Member access unavailable");
  check(data.expectedRevision === item.revision, "Stale Work Item revision");
  check(data.expectedHelpRevision === (prior?.revision ?? 0), "Stale help invitation revision");
  check(data.expectedHelpRevision < Number.MAX_SAFE_INTEGER - 1, "Help invitation revision limit reached");
  if (prior) check(Date.parse(incoming.at) >= Date.parse(prior.updatedAt), "Help invitation clock moved backwards");
  if (data.status === "withdrawn") {
    check(prior?.status === "open", "Invalid transition: no open help invitation to withdraw");
    check(mayWithdraw(state, item, actor), "Only the accountable member or human Room owner may withdraw help");
    return validateHelp({ ...prior, revision: prior.revision + 1, eventId: incoming.id, status: "withdrawn",
      updatedAt: incoming.at, updatedById: actor.id });
  }
  check(mayPublish(item, actor), "Only the active accountable member may invite help on accepted work");
  return validateHelp({
    id: prior?.id ?? incoming.id, revision: data.expectedHelpRevision + 1, eventId: incoming.id, status: "open",
    workItemId: item.id, workBasisRevision: item.revision, accountableMemberId: actor.id, accountableRevision: actor.revision,
    completionEventId: item.receipt?.eventId ?? null, scope: data.scope, expiresAt: data.expiresAt,
    createdAt: prior?.createdAt ?? incoming.at, openedAt: incoming.at, openedById: actor.id, updatedAt: incoming.at, updatedById: actor.id
  });
}

// Evaluate against one committed room snapshot and an explicit service clock.
// These are room-level capabilities, never credential/sponsor or tool grants.
export function workHelpContext(state, workItemId, viewerId, now) {
  check(instant(now), "Help invitations need an explicit evaluation time");
  const item = work(state, workItemId), help = priorHelp(item);
  const viewer = member(state, viewerId), accountable = member(state, item.accountableMemberId);
  let status = "off";
  if (help) {
    if (help.status === "withdrawn") status = "withdrawn";
    else if (!accepting(item)) status = "work_closed";
    else if (!mayPublish(item, accountable)) status = "accountable_unavailable";
    else if (help.accountableMemberId !== item.accountableMemberId || help.accountableRevision !== accountable.revision
      || help.completionEventId !== (item.receipt?.eventId ?? null)) status = "consent_changed";
    else if (Date.parse(now) < Date.parse(help.openedAt)) status = "not_started";
    else if (Date.parse(now) >= Date.parse(help.expiresAt)) status = "expired";
    else status = "open";
  }
  return {
    authority: "invitation_only", workItemId, workRevision: item.revision, revision: help?.revision ?? 0,
    eventId: help?.eventId ?? null, evaluatedAt: now, status, help: help ? { ...help } : null,
    canPublish: mayPublish(item, viewer), canWithdraw: help?.status === "open" && mayWithdraw(state, item, viewer),
    canOffer: status === "open" && active(viewer) && viewer.id !== item.accountableMemberId
      && !(item.independentVerificationRequired && viewer.id === item.verifierMemberId)
  };
}
