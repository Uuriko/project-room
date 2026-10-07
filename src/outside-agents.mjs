// Agents who are not room members can still be named, related, and later
// linked. A record is a room message. It grants no access, mints no identity,
// and issues no invite. The same messages are the network every member reads.
import { validId } from "./events.js";
import { createHash } from "node:crypto";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const PREFIX = "outside-agent.v1\n";
const KINDS = new Set(["introduce", "sighting", "knows", "link"]);
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

export function assembleOutsideAgents(messages, members = {}) {
  const agents = new Map();
  const edges = [];
  const pendingLinks = []; // link records seen before their introduction (L-42)
  const applyLink = (agent, record, authorId) => {
    if (agent && authorId === record.memberId && Object.hasOwn(members, record.memberId)
        && members[record.memberId].active !== false && agent.linkedMemberId === null) {
      agent.linkedMemberId = record.memberId;
      agent.linkedBy = authorId;
      return true;
    }
    return false;
  };
  for (const message of messages ?? []) {
    // This is a shared public network, never a projection of targeted messages.
    if (message?.toMemberId || (message?.toMemberIds?.length ?? 0) > 0 || message?.deletedAt) continue;
    const record = parseOutsideAgentBody(message?.body);
    if (!record) continue;
    if (record.kind === "introduce" || record.kind === "sighting") {
      const existing = agents.get(record.externalRef);
      if (!existing) {
        agents.set(record.externalRef, {
          externalRef: record.externalRef, displayName: record.displayName, origin: record.origin,
          reach: record.reach ?? null, note: record.note ?? null, introducedBy: message.authorId,
          sightings: [], knows: [], knownBy: [], linkedMemberId: null, linkedBy: null, verified: false
        });
      } else if (message.authorId !== existing.introducedBy && !existing.sightings.some(row => row.memberId === message.authorId)) {
        existing.sightings.push({ memberId: message.authorId, messageId: message.id });
      }
    } else if (record.kind === "knows") edges.push({ ...record, reportedBy: message.authorId });
    else if (record.kind === "link") {
      if (!applyLink(agents.get(record.externalRef), record, message.authorId)) {
        // The introduction may not have been seen yet; buffer the link so
        // it isn't silently dropped when it arrives first (L-42).
        if (!agents.has(record.externalRef)) {
          pendingLinks.push({ record, authorId: message.authorId });
        }
      }
    }
  }
  // Backfill links buffered before their introductions (L-42).
  for (const { record, authorId } of pendingLinks) {
    applyLink(agents.get(record.externalRef), record, authorId);
  }
  for (const edge of edges) {
    const from = agents.get(edge.fromRef), to = agents.get(edge.toRef);
    if (!from || !to || ![from.introducedBy, from.linkedMemberId].includes(edge.reportedBy)) continue;
    if (!from.knows.includes(edge.toRef)) from.knows.push(edge.toRef);
    if (!to.knownBy.includes(edge.fromRef)) to.knownBy.push(edge.fromRef);
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

