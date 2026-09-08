// Dormant contract: register only with a matching writer/migration/history audit.
// Selection coordinates a contribution; it is never an execution or payment grant.
import { validateHelp, workHelpContext } from "./work-help.js";

export const HELP_OFFER_OPENED = "work.help_offer_opened";
export const HELP_OFFER_UPDATED = "work.help_offer_updated";
export const MAX_HELP_OFFERS = 500;
export const MAX_PENDING_HELP_OFFERS = 5;
const own = (value, key) => value != null && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const id = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value);
const rev = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const text = value => typeof value === "string" && value.isWellFormed() && value.trim().length > 0 && value.length <= 600;
const check = (value, message = "Invalid help offer") => { if (!value) throw new Error(message); };
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const fields = ["id", "revision", "workItemId", "workBasisRevision", "offererId", "offererRevision",
  "accountableMemberId", "invitation", "plan", "status", "createdAt", "updatedAt", "openingEventId",
  "eventId", "updatedById", "reason", "externalActivityUnverified"];

export function validateHelpOffer(offer) {
  check(exact(offer, fields));
  check(["id", "workItemId", "offererId", "accountableMemberId", "openingEventId", "eventId", "updatedById"].every(key => id(offer[key])));
  check(rev(offer.revision) && rev(offer.workBasisRevision) && rev(offer.offererRevision) && text(offer.plan));
  const help = validateHelp(offer.invitation);
  check(help.status === "open" && help.workItemId === offer.workItemId && help.accountableMemberId === offer.accountableMemberId
    && offer.offererId !== offer.accountableMemberId && offer.workBasisRevision >= help.workBasisRevision);
  check(instant(offer.createdAt) && instant(offer.updatedAt) && Date.parse(offer.createdAt) <= Date.parse(offer.updatedAt)
    && Date.parse(help.openedAt) <= Date.parse(offer.createdAt) && Date.parse(offer.createdAt) < Date.parse(help.expiresAt));
  check(["offered", "selected", "declined", "withdrawn", "released"].includes(offer.status));
  const opening = offer.status === "offered", released = offer.status === "released";
  check(offer.revision === (opening ? 0 : released ? 2 : 1)
    && (opening ? offer.reason === null : text(offer.reason))
    && offer.externalActivityUnverified === released);
  if (opening) check(offer.eventId === offer.openingEventId && offer.updatedById === offer.offererId && offer.updatedAt === offer.createdAt);
  else check(offer.eventId !== offer.openingEventId);
  if (offer.status === "selected") check(offer.updatedById === offer.accountableMemberId && Date.parse(offer.updatedAt) < Date.parse(help.expiresAt));
  if (offer.status === "withdrawn") check(offer.updatedById === offer.offererId);
  return offer;
}

export function validateHelpOfferData(type, data) {
  const keys = ["workItemId", "offerId", "expectedRevision"];
  if (type === HELP_OFFER_OPENED) {
    keys.push("expectedHelpRevision", "helpEventId", "plan");
    check(rev(data?.expectedHelpRevision) && id(data.helpEventId) && text(data.plan), "Choose a current request and a short contribution plan");
  } else {
    check(type === HELP_OFFER_UPDATED);
    keys.push("expectedOfferRevision", "status", "reason");
    check(rev(data?.expectedOfferRevision) && ["selected", "declined", "withdrawn", "released"].includes(data.status) && text(data.reason));
    if (data.status === "selected") {
      keys.push("expectedHelpRevision", "helpEventId");
      check(rev(data.expectedHelpRevision) && id(data.helpEventId));
    }
    if (data.status === "released") { keys.push("externalActivityUnverified"); check(data.externalActivityUnverified === true, "Release does not confirm external work has stopped"); }
  }
  check(exact(data, keys) && id(data.workItemId) && id(data.offerId) && rev(data.expectedRevision));
  return data;
}

function records(state) {
  if (!own(state, "helpOffers")) return [];
  check(object(state.helpOffers), "Invalid offer projection");
  const rows = Object.entries(state.helpOffers);
  check(rows.length <= MAX_HELP_OFFERS, "Offer history capacity exceeded");
  const identities = new Set(), selected = new Set();
  return rows.map(([key, offer]) => {
    validateHelpOffer(offer);
    check(id(key) && key === offer.id && own(state.workItems, offer.workItemId), "Invalid offer reference");
    const item = state.workItems[offer.workItemId], help = validateHelp(item.helpWanted);
    const helper = participant(state, offer.offererId);
    check(helper && offer.offererRevision <= helper.revision, "Invalid offer participant basis");
    check(item.accountableMemberId === offer.accountableMemberId && offer.workBasisRevision <= item.revision
      && help.id === offer.invitation.id && help.revision >= offer.invitation.revision, "Invalid invitation basis");
    if (help.revision === offer.invitation.revision) check(Object.keys(help).every(key => help[key] === offer.invitation[key]), "Invitation facts changed without a revision");
    if (["declined", "released"].includes(offer.status)) check([offer.accountableMemberId, state.room.ownerId,
      ...(offer.status === "released" ? [offer.offererId] : [])].includes(offer.updatedById));
    const identity = JSON.stringify([offer.workItemId, offer.invitation.eventId, offer.offererId]);
    check(!identities.has(identity), "Duplicate offer for this request version"); identities.add(identity);
    if (offer.status === "selected") { check(!selected.has(offer.workItemId), "Multiple selected helpers"); selected.add(offer.workItemId); }
    return offer;
  });
}
function participant(state, memberId) {
  if (!id(memberId) || !own(state.members, memberId)) return null;
  const member = state.members[memberId];
  check(member?.id === memberId && ["human", "agent"].includes(member.kind) && typeof member.active === "boolean" && rev(member.revision));
  return member;
}
function current(state, offer, now) {
  const help = workHelpContext(state, offer.workItemId, offer.offererId, now), person = participant(state, offer.offererId);
  return help.status === "open" && help.canOffer && help.eventId === offer.invitation.eventId
    && help.revision === offer.invitation.revision && person?.revision === offer.offererRevision;
}
function selection(rows, workItemId) { return rows.find(offer => offer.workItemId === workItemId && offer.status === "selected")?.id ?? null; }

export function helpOfferAvailability(state, workItemId, viewerId, now) {
  const help = workHelpContext(state, workItemId, viewerId, now), rows = records(state);
  const prior = rows.find(offer => offer.workItemId === workItemId && offer.invitation.eventId === help.eventId && offer.offererId === viewerId);
  const pending = rows.filter(offer => offer.status === "offered" && current(state, offer, now));
  const forWork = pending.filter(offer => offer.workItemId === workItemId).length;
  const forViewer = pending.filter(offer => offer.offererId === viewerId).length;
  const selectedOfferId = selection(rows, workItemId);
  const reason = !help.canOffer ? "invitation_unavailable" : prior ? "already_offered" : selectedOfferId ? "helper_selected"
    : rows.length >= MAX_HELP_OFFERS ? "history_full"
      : forWork >= MAX_PENDING_HELP_OFFERS ? "work_offer_limit" : forViewer >= MAX_PENDING_HELP_OFFERS ? "member_offer_limit" : null;
  return { authority: "coordination_only", externalExecution: false, workItemId, evaluatedAt: now,
    helpRevision: help.revision, helpEventId: help.eventId, canOffer: reason === null, reason,
    existingOfferId: prior?.id ?? null, selectedOfferId, pendingForWork: forWork, pendingForViewer: forViewer };
}

export function helpOfferContext(state, offerId, viewerId, now) {
  check(instant(now)); const rows = records(state), offer = rows.find(row => row.id === offerId);
  check(offer, "Unknown help offer");
  const viewer = participant(state, viewerId), active = viewer?.active === true;
  const accountable = active && viewerId === offer.accountableMemberId;
  const moderator = active && viewerId === state.room.ownerId && viewer.kind === "human";
  const helper = active && viewerId === offer.offererId;
  const applicable = current(state, offer, now), selectedOfferId = selection(rows, offer.workItemId);
  const help = workHelpContext(state, offer.workItemId, viewerId, now);
  return { authority: "coordination_only", externalExecution: false, evaluatedAt: now, offer: structuredClone(offer),
    invitationCurrent: applicable, selectedOfferId,
    status: offer.status === "offered" && !applicable ? "unavailable" : offer.status === "selected" && !applicable ? "selection_needs_review" : offer.status,
    canSelect: offer.status === "offered" && applicable && accountable && help.canPublish && !selectedOfferId,
    canDecline: offer.status === "offered" && (accountable || moderator),
    canWithdraw: offer.status === "offered" && helper,
    canRelease: offer.status === "selected" && (helper || accountable || moderator),
    releaseBoundary: "Releasing records coordination only. It does not confirm that outside work stopped." };
}

// Pure transition. The service/reducer must own atomicity, actor authentication,
// stable operation receipts and history audit before these events are enabled.
export function helpOfferFromEvent(state, incoming) {
  check(id(incoming?.id) && id(incoming.actorId) && instant(incoming.at)
    && id(incoming.roomId) && incoming.roomId === state.room.id);
  const d = validateHelpOfferData(incoming.type, incoming.data), rows = records(state);
  const item = own(state.workItems, d.workItemId) && state.workItems[d.workItemId];
  check(item && item.id === d.workItemId && item.revision === d.expectedRevision, "Stale Work Item revision");
  const actor = participant(state, incoming.actorId); check(actor?.active === true, "Member access unavailable");
  if (incoming.type === HELP_OFFER_OPENED) {
    check(!rows.some(row => row.id === d.offerId), "Offer identity already exists");
    const available = helpOfferAvailability(state, item.id, actor.id, incoming.at);
    check(available.canOffer, available.reason ?? "Offer unavailable");
    check(available.helpEventId === d.helpEventId && available.helpRevision === d.expectedHelpRevision, "Stale help invitation");
    return validateHelpOffer({ id: d.offerId, revision: 0, workItemId: item.id, workBasisRevision: item.revision,
      offererId: actor.id, offererRevision: actor.revision, accountableMemberId: item.accountableMemberId,
      invitation: structuredClone(item.helpWanted), plan: d.plan, status: "offered", createdAt: incoming.at,
      updatedAt: incoming.at, openingEventId: incoming.id, eventId: incoming.id, updatedById: actor.id,
      reason: null, externalActivityUnverified: false });
  }
  const prior = rows.find(offer => offer.id === d.offerId);
  check(prior && prior.workItemId === item.id, "Unknown help offer");
  check(prior.revision === d.expectedOfferRevision, "Stale help offer revision");
  check(Date.parse(incoming.at) >= Date.parse(prior.updatedAt), "Help offer clock moved backwards");
  const context = helpOfferContext(state, prior.id, actor.id, incoming.at);
  check(context[{ selected: "canSelect", declined: "canDecline", withdrawn: "canWithdraw", released: "canRelease" }[d.status]], "Offer transition unavailable");
  if (d.status === "selected") check(d.helpEventId === prior.invitation.eventId && d.expectedHelpRevision === prior.invitation.revision, "Stale help invitation");
  return validateHelpOffer({ ...prior, revision: prior.revision + 1, status: d.status, reason: d.reason,
    updatedAt: incoming.at, updatedById: actor.id, eventId: incoming.id, externalActivityUnverified: d.status === "released" });
}
