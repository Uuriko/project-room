// Agents who are not room members can still be named, related, and later
// linked. A record is a room message. It grants no access, mints no identity,
// and issues no invite. The same messages are the network every member reads.
import { validId } from "./events.js";
import { createHash } from "node:crypto";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const PREFIX = "outside-agent.v1\n";
const KINDS = new Set(["introduce", "sighting", "knows", "link", "verify"]);
const VERIFY_DECISIONS = new Set(["approved", "denied"]);
const ORIGINS = new Set(["bus", "host", "product", "mcp", "room", "other"]);
const REF = /^[a-z][a-z0-9._:-]{1,64}$/;
const SECRET = /(?:^|[\s"'/])(?:pri_|rak_|ga1\.|ref1\.|Bearer\s)/i;
const commandId = (kind, ...parts) => `oa-${kind}-` + createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

export function outsideAgentBody(record) {
  return PREFIX + JSON.stringify(record);
}

export function parseOutsideAgentBody(body) {
  if (typeof body !== "string" || !body.startsWith(PREFIX)) return null;
  let value;
  try { value = JSON.parse(body.slice(PREFIX.length)); }
  catch { return null; }
  if (!value || value.v !== 1 || !KINDS.has(value.kind) || typeof value.externalRef !== "string" && value.kind !== "knows") return null;
  try {
    if (value.kind === "introduce" || value.kind === "sighting") {
      publicRef(value.externalRef); publicText(value.displayName, "Display name", 80);
      if (!ORIGINS.has(value.origin)) return null;
      reachOf(value.reach ?? null);
      if (value.note != null) publicText(value.note, "Note", 280);
    } else if (value.kind === "knows") { publicRef(value.fromRef); publicRef(value.toRef); }
    else if (value.kind === "verify") {
      // A connect-approval decision. Only honored at assembly when the
      // record's author is in the caller's verifier set (see
      // assembleOutsideAgents): the parse only checks the shape.
      publicRef(value.externalRef);
      if (!VERIFY_DECISIONS.has(value.decision)) return null;
      if (!validId(value.decidedBy)) return null;
      if (typeof value.decidedAt !== "number" || !(value.decidedAt > 0)) return null;
    }
    else { publicRef(value.externalRef); if (!validId(value.memberId)) return null; }
  } catch { return null; }
  return value;
}

export function planOutsideAgentRecord(messages, members, roomId, actorId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["externalRef", "displayName", "origin", "reach", "note"].includes(key)))
    fail(422, "invalid_outside_agent", "Choose public agent facts only");
  const externalRef = publicRef(input?.externalRef);
  if (members?.[externalRef]) fail(422, "invalid_outside_agent", "That handle is already a room member");
  const displayName = publicText(input?.displayName, "Display name", 80);
  if (!ORIGINS.has(input?.origin)) fail(422, "invalid_outside_agent", "Name where this agent lives: bus, host, product, mcp, room, or other");
  const reach = reachOf(input?.reach ?? null);
  const note = input?.note == null ? null : publicText(input.note, "Note", 280);
  const existing = assembleOutsideAgents(messages, members).find(agent => agent.externalRef === externalRef);
  if (existing && existing.introducedBy === actorId) {
    const same = existing.displayName === displayName && existing.origin === input.origin && existing.reach === reach && existing.note === note;
    if (!same) fail(409, "outside_agent_changed", "This agent was already introduced with different public facts");
    return { recorded: "replay", externalRef };
  }
  const kind = existing ? "sighting" : "introduce";
  const record = { v: 1, kind, externalRef, displayName, origin: input.origin, reach, note };
  return { recorded: kind, externalRef, commandId: commandId(kind, roomId, actorId, externalRef), record, body: outsideAgentBody(record) };
}

// Plan a connect-approval decision for an outside agent's link (1e
// hs2-outside-agent-approval). The approver is authenticated by the caller
// (server/outside-agents.mjs restricts verify to the room owner and
// membership administrators); the planner checks the decision is well-formed
// and that there is a link to decide on. Idempotent per link: repeating the
// latest decision ON THE SAME link replays instead of writing a second
// record, while the same decision on a re-linked agent is a new decision -
// the command id carries the pending link's message id, so a
// approve -> deny -> re-link -> approve sequence can never collide with the
// first approval's id and drop silently (A34). Pass the verifier set so the
// replay check sees already-honored decisions.
export function planOutsideAgentVerify(messages, members, roomId, approverId, input, { verifiers = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["externalRef", "decision"].includes(key)))
    fail(422, "invalid_outside_agent", "Decide with an externalRef and a decision");
  const externalRef = publicRef(input?.externalRef);
  if (!VERIFY_DECISIONS.has(input?.decision))
    fail(422, "invalid_outside_agent", 'decision must be "approved" or "denied"');
  const decision = input.decision;
  const existing = assembleOutsideAgents(messages, members, { verifiers }).find(agent => agent.externalRef === externalRef);
  if (!existing) fail(404, "outside_agent_not_found", "Introduce the agent before deciding on its link");
  if (!existing.linkedMemberId && !existing.verifiedBy)
    fail(422, "outside_agent_unlinked", "There is no link to decide on for this agent");
  // A decision belongs to the link it was made on. Replay only when the
  // same decision already covers the CURRENT pending link; after a re-link
  // the same verdict is a new decision and must record (A34).
  const pendingLinkId = existing.linkMessageId ?? null;
  if (existing.latestDecision === decision && existing.decidedLinkMessageId === pendingLinkId)
    return { recorded: "replay", externalRef, decision };
  const record = { v: 1, kind: "verify", externalRef, decision, decidedBy: approverId, decidedAt: Date.now() };
  return { recorded: "verify", externalRef, decision,
    commandId: commandId("verify", roomId, approverId, externalRef, decision, pendingLinkId ?? "none"),
    record, body: outsideAgentBody(record) };
}

export function assembleOutsideAgents(messages, members = {}, { verifiers = null } = {}) {
  // verifiers: a Set of memberIds allowed to decide on links (the room owner
  // and membership administrators, computed by the server). Verify records
  // are honored only when their author is in this set AND the author matches
  // the record's decidedBy — a forged raw message from anyone else cannot
  // mint a verified link. When no set is given, verify records are ignored
  // (safe default for unprivileged readers).
  const agents = new Map();
  const edges = [];
  const pendingLinks = []; // link records seen before their introduction (L-42)
  const applyLink = (agent, record, authorId, messageId = null) => {
    if (agent && authorId === record.memberId && Object.hasOwn(members, record.memberId)
        && members[record.memberId].active !== false && agent.linkedMemberId === null) {
      agent.linkedMemberId = record.memberId;
      agent.linkedBy = authorId;
      agent.linkMessageId = messageId;
      return true;
    }
    return false;
  };
  // A verify decision is authoritative only from a verifier, and only when
  // the message author is the recorded decider (the server posts verify
  // records under the approver's own credential).
  const applyVerify = (agent, record, authorId) => {
    if (!agent) return false;
    if (!(verifiers instanceof Set) || !verifiers.has(authorId) || authorId !== record.decidedBy) return false;
    agent.latestDecision = record.decision;
    agent.verifiedBy = record.decidedBy;
    agent.verifiedAt = record.decidedAt;
    // The decision covers the link in effect when it was honored (A34):
    // replay compares against this, not the latest-ever verdict.
    agent.decidedLinkMessageId = agent.linkMessageId ?? null;
    if (record.decision === "approved") {
      agent.verified = true;
    } else {
      // Denied: the link assertion was rejected — clear it. The member may
      // link again, which returns the agent to pending.
      agent.linkedMemberId = null;
      agent.linkedBy = null;
      agent.linkMessageId = null;
      agent.verified = false;
    }
    return true;
  };
  for (const message of messages ?? []) {
    // This is a shared public network, never a projection of targeted messages.
    if (message?.toMemberId || message?.deletedAt) continue;
    const record = parseOutsideAgentBody(message?.body);
    if (!record) continue;
    if (record.kind === "introduce" || record.kind === "sighting") {
      const existing = agents.get(record.externalRef);
      if (!existing) {
        agents.set(record.externalRef, {
          externalRef: record.externalRef, displayName: record.displayName, origin: record.origin,
          reach: record.reach ?? null, note: record.note ?? null, introducedBy: message.authorId,
          sightings: [], knows: [], knownBy: [], linkedMemberId: null, linkedBy: null, verified: false,
          verifiedBy: null, verifiedAt: null, latestDecision: null,
          linkMessageId: null, decidedLinkMessageId: null
        });
      } else if (message.authorId !== existing.introducedBy && !existing.sightings.some(row => row.memberId === message.authorId)) {
        existing.sightings.push({ memberId: message.authorId, messageId: message.id });
      }
    } else if (record.kind === "knows") edges.push({ ...record, reportedBy: message.authorId });
    else if (record.kind === "verify") applyVerify(agents.get(record.externalRef), record, message.authorId);
    else if (record.kind === "link") {
      if (!applyLink(agents.get(record.externalRef), record, message.authorId, message.id)) {
        // The introduction may not have been seen yet; buffer the link so
        // it isn't silently dropped when it arrives first (L-42).
        if (!agents.has(record.externalRef)) {
          pendingLinks.push({ record, authorId: message.authorId, messageId: message.id });
        }
      }
    }
  }
  // Backfill links buffered before their introductions (L-42).
  for (const { record, authorId, messageId } of pendingLinks) {
    applyLink(agents.get(record.externalRef), record, authorId, messageId);
  }
  for (const edge of edges) {
    const from = agents.get(edge.fromRef), to = agents.get(edge.toRef);
    if (!from || !to || ![from.introducedBy, from.linkedMemberId].includes(edge.reportedBy)) continue;
    if (!from.knows.includes(edge.toRef)) from.knows.push(edge.toRef);
    if (!to.knownBy.includes(edge.fromRef)) to.knownBy.push(edge.fromRef);
  }
  // A link waiting on a human decision: linked but never verified.
  for (const agent of agents.values()) {
    agent.verificationPending = agent.linkedMemberId !== null && agent.verified !== true;
  }
  return [...agents.values()];
}

function publicText(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || SECRET.test(value))
    fail(422, "invalid_outside_agent", `${label} must be public text, not a credential`);
  return value.trim();
}

export function publicRef(value) {
  if (typeof value !== "string" || !REF.test(value) || value.startsWith("ai_") || SECRET.test(value))
    fail(422, "invalid_outside_agent", "Name the agent with a public handle. This does not mint an identity.");
  return value;
}

function reachOf(reach) {
  if (reach == null) return null;
  if (typeof reach !== "string" || reach.length > 200 || SECRET.test(reach))
    fail(422, "invalid_outside_agent", "Reach must be a public handle, not a credential");
  if (/^https:\/\/\S+$/.test(reach) || /^bus:[a-z][a-z0-9_-]{0,32}$/.test(reach) || /^mcp:[a-z][a-z0-9_-]{0,32}$/.test(reach)) return reach;
  fail(422, "invalid_outside_agent", "Reach must be an https URL, a bus role, or an mcp host");
}

