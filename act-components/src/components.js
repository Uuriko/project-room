import {
  COMPUTE_ORIGIN,
  EVENT_TYPES,
  INTENDED_RECORDS,
  LABELS,
  PROPOSED_CLASS_TYPES,
  RECORDING_KINDS
} from "./kinds.js";

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function eventData(event) {
  return event && typeof event === "object" ? (event.data ?? {}) : {};
}

function receiptData(receipt) {
  if (!receipt || typeof receipt !== "object") return {};
  return { ...receipt, ...(receipt.data ?? {}) };
}

function viewerCapabilities(viewer) {
  if (!viewer || typeof viewer !== "object") return [];
  return asList(viewer.capabilities).concat(asList(viewer.permissions));
}

/** Owner or `act` may Approve / Reject / Acknowledge. Link-out is wider. */
export function canRecordAct(viewer = {}) {
  if (viewer.role === "owner" || viewer.isOwner === true) return true;
  return viewerCapabilities(viewer).includes("act");
}

export function isProposedClass(event) {
  return PROPOSED_CLASS_TYPES.includes(event?.type);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return null;
}

/**
 * A Compute bridge pointer is a job id, nested compute object, or an explicit
 * bridge flag. Presence of a Receipt id alone is not enough.
 */
export function computePointer(event, receipt) {
  const data = eventData(event);
  const rec = receiptData(receipt);
  const nested = [data.compute, rec.compute, data.bridge, rec.bridge].filter(
    (value) => value && typeof value === "object"
  );
  const surfaces = [data, rec, ...nested];

  let computeJobId = null;
  let flagged = false;
  for (const surface of surfaces) {
    const jobId = firstDefined(surface.computeJobId, surface.jobId, surface.compute_job_id);
    if (jobId) computeJobId = computeJobId ?? jobId;
    if (surface.bridge === "compute" || surface.product === "compute") flagged = true;
    if (surface.computeUrl || surface.href) flagged = true;
  }
  if (!computeJobId && !flagged) return null;

  return {
    computeJobId,
    workItemId: firstDefined(data.workItemId, rec.workItemId, rec.work_item_id),
    receiptId: firstDefined(data.receiptId, rec.id, rec.receiptId, rec.receipt_id)
  };
}

/** Deep-link to the Compute door. Never /compute/api and never a run start. */
export function computeDeepLink({ workItemId, receiptId } = {}) {
  const url = new URL(COMPUTE_ORIGIN);
  if (workItemId) url.searchParams.set("work_item", workItemId);
  if (receiptId) url.searchParams.set("receipt", receiptId);
  return url.toString();
}

function targetFrom(event, extra = {}) {
  const data = eventData(event);
  const target = {
    eventId: event?.id ?? extra.eventId ?? null
  };
  const workItemId = firstDefined(extra.workItemId, data.workItemId);
  const receiptId = firstDefined(extra.receiptId, data.receiptId);
  const computeJobId = firstDefined(extra.computeJobId);
  if (workItemId) target.workItemId = workItemId;
  if (receiptId) target.receiptId = receiptId;
  if (computeJobId) target.computeJobId = computeJobId;
  return target;
}

function recordingComponent(kind, event) {
  return {
    kind,
    label: LABELS[kind],
    target: targetFrom(event),
    records: { ...INTENDED_RECORDS[kind] }
  };
}

function ackNeeded(event) {
  const data = eventData(event);
  if (data.ackNeeded === true) return true;
  return event?.type === EVENT_TYPES.MESSAGE_POSTED && data.requestKind === "reply";
}

/**
 * Project available Act-component buttons for one Event (+ optional Receipt).
 * Does not write Events, start Compute, or treat reactions as Acts.
 */
export function availableComponents(input = {}) {
  const event = input.event ?? null;
  const viewer = input.viewer ?? {};
  const receipt = input.receipt ?? null;
  const components = [];

  if (event?.type === EVENT_TYPES.MESSAGE_REACTION_SET) {
    return { components };
  }

  if (canRecordAct(viewer)) {
    if (isProposedClass(event)) {
      components.push(recordingComponent("approve", event), recordingComponent("reject", event));
    }
    if (ackNeeded(event)) {
      components.push(recordingComponent("ack", event));
    }
  }

  const pointer = computePointer(event, receipt);
  if (pointer) {
    const href = computeDeepLink(pointer);
    components.push({
      kind: "open_compute",
      label: LABELS.open_compute,
      href,
      target: targetFrom(event, pointer)
    });
  }

  return { components };
}

export function componentsForEvent(event, viewer, options = {}) {
  return availableComponents({ event, viewer, receipt: options.receipt });
}

export function componentKinds(result) {
  return (result?.components ?? []).map((component) => component.kind);
}

export { RECORDING_KINDS };
