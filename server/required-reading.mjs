// Per-lane required reading on enrollment (backlog W012).
//
// When an agent enrolls in a work lane — takes a claim — the claim response
// carries the reading list for that claim's kind. The list is advisory:
// enrollment never gates on it, so there is nothing to bypass and no
// existing flow can break. A read-acknowledgment (who confirmed what, when)
// is recorded on the claim item itself (see stampReadingAck), carried by the
// claim canonicalizer and the durable registry, and also stamped into the
// claim history for the audit trail.
//
// Pure: no imports of its own beyond the claim history stamper, frozen
// outputs, domain errors with no HTTP status.

import { stampClaimHistory, ClaimError } from "./work-claims.mjs";

const entry = (path, title, why) => Object.freeze({ path, title, why });

// Lane/claim kind -> required reading. Every path must exist in docs/; the
// suite's grounding test fails the build when a rename orphans an entry.
export const REQUIRED_READING = Object.freeze({
  work: Object.freeze([
    entry("docs/AGENT-START-HERE.md", "Agent start here",
      "Your first claimed task in under 10 minutes: mint an identity, find work, claim it."),
    entry("docs/ROOM-PROTOCOL.md", "Room protocol",
      "The lane protocol every lane must use: claim work, report state, hand off, receipt."),
    entry("docs/AGENT-QUICKSTART.md", "Agent quickstart",
      "The compact runbook for agents operating in a room."),
    entry("docs/SWARM-PLUG-IN.md", "Swarm plug-in",
      "The one enrollment flow, MCP tools, the client contract, and limits."),
    entry("docs/ROOM-COORDINATION.md", "Room coordination",
      "The CLI loop: look, claim, renew with a public progress message, hand off, land, close."),
    entry("docs/REVIEW-PARALLELISM.md", "Review parallelism",
      "The lander rule: a hard-claim PR merges only after the rev-reviewer's APPROVE on the exact head."),
  ]),
  land: Object.freeze([
    entry("docs/ROOM-COORDINATION.md", "Room coordination",
      "The land step: put the PR in the land queue, then verify required CI to completion for the exact head before merging."),
    entry("docs/REVIEW-PARALLELISM.md", "Review parallelism",
      "The lander rule: merge a hard-claim PR only after the rev-reviewer's APPROVE on the exact head; branch protection is untouched."),
    entry("docs/ROOM-PROTOCOL.md", "Room protocol",
      "Hand-off and receipt shapes so the lane that did the work gets credited when the land closes."),
    entry("docs/AGENT-START-HERE.md", "Agent start here",
      "Identity, finding work, and claiming — the baseline before landing anything."),
  ]),
  deploy: Object.freeze([
    entry("docs/DEPLOY-LANE.md", "Shared production deploy lane",
      "Who can deploy, the green-sha rule (deploy only a main commit with test + schema-gate green), and the ROLE-DEPLOYER claim so two lanes never deploy at once."),
    entry("docs/ROOM-DEPLOYMENT.md", "Room deployment",
      "The manual deploy procedure and the smoke checks that follow every production deploy."),
    entry("docs/ROOM-PROTOCOL.md", "Room protocol",
      "Reporting state and receipts so the room sees the deploy start and finish."),
  ]),
});
const DEFAULT_READING = REQUIRED_READING.work;

// The reading list for a claim kind. Unknown kinds fall back to the work
// list — enrollment must never fail because of a reading lookup.
export function requiredReadingFor(kind) {
  return Object.hasOwn(REQUIRED_READING, kind) ? REQUIRED_READING[kind] : DEFAULT_READING;
}

// Reading-ack docs validation: a non-empty list of short repo-relative doc
// paths. Returns a frozen canonical list.
const MAX_ACK_DOCS = 20;
const MAX_DOC_PATH = 256;
export function validateReadingDocs(docs) {
  if (!Array.isArray(docs) || docs.length === 0 || docs.length > MAX_ACK_DOCS)
    throw new ClaimError("invalid_claim_input", `docs must be a list of 1..${MAX_ACK_DOCS} doc paths`);
  const clean = docs.map(doc => {
    if (typeof doc !== "string" || doc.length === 0 || doc.length > MAX_DOC_PATH)
      throw new ClaimError("invalid_claim_input", "each doc must be a 1..256 character path");
    return doc;
  });
  return Object.freeze(clean);
}

// Record a read-acknowledgment on a claim: the agent confirmed it read these
// docs at this time. Latest ack per agent wins. Also stamps a "reading_ack"
// entry into the claim history so the ack is visible in the audit trail.
export function stampReadingAck(work, agentId, { docs, now } = {}) {
  const list = validateReadingDocs(docs);
  const atMs = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const ack = Object.freeze({ docs: list, at: new Date(atMs).toISOString() });
  const readingAcks = Object.freeze({ ...readingAcksOf(work), [agentId]: ack });
  const next = { ...work, readingAcks };
  return stampClaimHistory(next, agentId, { action: "reading_ack", note: list.join(", "), now: atMs });
}

// The ack map on a claim item: { agentId: { docs, at } }. Empty when nothing
// was acked.
export function readingAcksOf(item) {
  const value = item?.readingAcks;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

