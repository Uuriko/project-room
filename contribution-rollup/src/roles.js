import { EVENT_TYPES } from "./kinds.js";

export function isServerSetActor(event) {
  if (!event || typeof event !== "object") return false;
  if (event.actorProvenance === "client") return false;
  if (event.clientSuppliedActor === true) return false;
  if (event.actorProvenance && event.actorProvenance !== "server") return false;
  return typeof event.actorId === "string" && event.actorId.trim().length > 0;
}

export function trustedActorId(event) {
  return isServerSetActor(event) ? event.actorId : null;
}

/**
 * Thin role map from work.proposed / work.superseded, or Phase 0 workItems.
 * proposedById is identity only — never a v0 weight.
 */
export function deriveWorkItemRoles(events, provided = null) {
  const items = {};
  if (provided && typeof provided === "object") {
    for (const [id, item] of Object.entries(provided)) {
      if (!item || typeof item !== "object") continue;
      items[id] = {
        id: item.id || id,
        proposedById: item.proposedById ?? null,
        verifierMemberId: item.verifierMemberId ?? null,
        humanDecisionMakerId: item.humanDecisionMakerId ?? null,
        accountableMemberId: item.accountableMemberId ?? null,
        supersededBy: item.supersededBy ?? null
      };
    }
  }

  for (const event of events) {
    const workItemId = event?.data?.workItemId;
    if (!workItemId) continue;
    items[workItemId] ||= { id: workItemId };
    if (event.type === EVENT_TYPES.WORK_PROPOSED) {
      const actor = trustedActorId(event);
      items[workItemId].proposedById = actor ?? items[workItemId].proposedById ?? null;
      items[workItemId].verifierMemberId = event.data.verifierMemberId ?? items[workItemId].verifierMemberId ?? null;
      items[workItemId].humanDecisionMakerId =
        event.data.humanDecisionMakerId ?? items[workItemId].humanDecisionMakerId ?? null;
      items[workItemId].accountableMemberId =
        event.data.accountableMemberId ?? items[workItemId].accountableMemberId ?? null;
    }
    if (event.type === EVENT_TYPES.WORK_SUPERSEDED && event.data.supersededByWorkItemId) {
      items[workItemId].supersededBy = event.data.supersededByWorkItemId;
    }
  }
  return items;
}

export function isUnknownProducer(data) {
  if (!data || typeof data !== "object") return true;
  if (data.producerAttribution === "unknown") return true;
  const producerId = data.producerId;
  if (producerId == null) return true;
  if (typeof producerId !== "string") return true;
  const trimmed = producerId.trim();
  return trimmed.length === 0 || trimmed === "unknown";
}

export function versionedArtifact(data) {
  const version = typeof data?.evidenceVersion === "string" ? data.evidenceVersion.trim() : "";
  return version || null;
}
