// Room reports (agent-room steal 1). A pure delivery-report generator: extract
// [DECISION]/[TODO]/[STATUS]/[RESULT] artifact tags from room messages and
// compose them into a shareable report — highlights, decisions, action items,
// artifacts — with verified-done work items listed first. Pure and
// dependency-free; frozen outputs; malformed inputs throw ReportError.
//
// Portions adapted from Agent Room (https://github.com/agent-room-alkl/agent-room)
// MIT License, Copyright (c) 2026 Agent Room contributors.
// Used under the MIT License; see LICENSE-MIT-AGENT-ROOM for the full text.
//
// HTTP/MCP wiring (e.g. GET /api/rooms/{id}/report) is a later slice: this
// module takes plain data (no store access) so the route layer can map
// store rows into { id, author, text, time } message shapes when those
// claims clear. No runtime-package.mjs registration needed — nothing imports
// this module yet.
class ReportError extends Error { constructor(code, message) { super(message); this.name = "ReportError"; this.code = code; } }
const fail = (code, message) => { throw new ReportError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_report", message); };

// Verbatim port of the agent-room tag vocabulary and extractor
// (upstream-mcp/packages/shared/src/artifacts.ts), adapted from TypeScript to
// plain JS. Tags are case-insensitive; multiple tags per message are allowed.
// One deliberate hardening vs upstream: [ \t]* instead of \s* so a tag with
// no text on its line cannot swallow the next line into the tag text.
const MARKER_PATTERN = /\[(DECISION|TODO|STATUS|RESULT)\][ \t]*([^\n]+)/gi;

const KIND_BY_MARKER = {
  DECISION: "decision",
  TODO: "todo",
  STATUS: "status",
  RESULT: "result",
};

export function artifactLabel(kind) {
  switch (kind) {
    case "decision": return "Decision";
    case "todo": return "Todo";
    case "status": return "Status";
    case "result": return "Result";
    default: fail("invalid_report", `unknown artifact kind: ${kind}`);
  }
}

// messages: [{ id, author, text, time }]. Skips non-message entries (upstream
// filters on type === 'msg'; here entries without usable text are skipped).
export function extractArtifacts(messages) {
  check(Array.isArray(messages), "messages must be an array");
  const artifacts = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const text = typeof message.text === "string" ? message.text : "";
    if (!text.trim()) continue;
    let match;
    MARKER_PATTERN.lastIndex = 0;
    while ((match = MARKER_PATTERN.exec(text))) {
      const marker = match[1] ? match[1].toUpperCase() : null;
      const tagText = match[2] ? match[2].trim() : "";
      if (!marker || !tagText) continue;
      artifacts.push(Object.freeze({
        id: `${message.id ?? "msg"}-${artifacts.length}`,
        kind: KIND_BY_MARKER[marker] ?? "status",
        text: tagText,
        sourceMessageId: message.id ?? null,
        author: typeof message.author === "string" && message.author ? message.author : "unknown",
        time: message.time ?? null,
      }));
    }
  }
  return Object.freeze(artifacts);
}

const DECISION_FALLBACK = /decided|agree|ship|deploy|final|priorit|approv|go with|landed|launched|greenlight/i;
const TODO_FALLBACK = /\btodo\b|action|follow-?up|next steps?|needs? to|should|will (do|take|handle)|assign/i;
const HIGHLIGHT_LINE_MIN = 10;
const MATCH_LINE_MIN = 8;
const CLIP_AT = 220;
const LIMIT = 8;

const clip = (text) => (text.length > CLIP_AT ? `${text.slice(0, CLIP_AT - 3)}...` : text);

function pickLines(messages, limit) {
  const lines = [];
  for (const m of messages) {
    const first = m.text.trim().split("\n").find((line) => line.trim().length > HIGHLIGHT_LINE_MIN)?.trim();
    if (!first) continue;
    lines.push(`${m.author}: ${clip(first)}`);
    if (lines.length >= limit) break;
  }
  return lines;
}

function pickMatching(messages, pattern, limit) {
  const lines = [];
  for (const m of messages) {
    const matched = m.text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > MATCH_LINE_MIN && pattern.test(line));
    if (!matched) continue;
    lines.push(`${m.author}: ${clip(matched)}`);
    if (lines.length >= limit) break;
  }
  return lines;
}

// room: { id, name, topic?, participants?: [{ name, role?, client? }] }
// messages: [{ id, author, text, time }] (already normalized)
// doneTasks: [{ id, title }] — verified-done work items, listed first in highlights
export function buildRoomReport({ room, messages, doneTasks = [], now } = {}) {
  check(room && typeof room === "object", "room is required");
  check(typeof room.id === "string" && room.id.trim(), "room.id is required");
  check(Array.isArray(messages), "messages must be an array");
  check(Array.isArray(doneTasks), "doneTasks must be an array");

  const userMessages = messages
    .filter((m) => m && typeof m === "object" && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      id: m.id ?? null,
      author: typeof m.author === "string" && m.author ? m.author : "unknown",
      text: m.text,
      time: m.time ?? null,
    }));

  const artifacts = extractArtifacts(userMessages);
  const done = doneTasks
    .filter((t) => t && typeof t === "object" && typeof t.title === "string" && t.title.trim())
    .map((t) => ({ id: t.id ?? null, title: t.title.trim() }));

  const highlights = [
    ...done.map((t) => `Verified done: ${t.title}`),
    ...pickLines(userMessages, LIMIT),
  ].slice(0, LIMIT);

  const markedDecisions = artifacts
    .filter((a) => a.kind === "decision")
    .map((a) => `${a.author}: ${clip(a.text)}`);
  const markedTodos = artifacts
    .filter((a) => a.kind === "todo")
    .map((a) => `${a.author}: ${clip(a.text)}`);

  const decisions = markedDecisions.length
    ? markedDecisions.slice(0, LIMIT)
    : pickMatching(userMessages, DECISION_FALLBACK, LIMIT);
  const actionItems = markedTodos.length
    ? markedTodos.slice(0, LIMIT)
    : pickMatching(userMessages, TODO_FALLBACK, LIMIT);

  const participants = Array.isArray(room.participants)
    ? room.participants
        .filter((p) => p && typeof p === "object" && typeof p.name === "string" && p.name.trim())
        .map((p) => Object.freeze({ name: p.name.trim(), role: p.role ?? null, client: p.client ?? null }))
    : [];

  const roomName = typeof room.name === "string" && room.name.trim() ? room.name.trim() : room.id;
  const doneNote = done.length
    ? ` ${done.length} task(s) verified done (${done.map((t) => t.id ?? t.title).join(", ")}).`
    : "";
  const generatedAt = Number.isFinite(now) ? now : Date.now();

  return Object.freeze({
    roomId: room.id,
    roomName,
    topic: typeof room.topic === "string" ? room.topic : "",
    generatedAt,
    participants: Object.freeze(participants),
    messageCount: userMessages.length,
    summary: `Delivery report for "${roomName}": ${userMessages.length} message(s) from ${participants.length} participant(s).${doneNote} Decisions, action items, and tagged artifacts are preserved below as a shareable asset.`,
    highlights: Object.freeze(highlights),
    decisions: Object.freeze(decisions.length ? decisions : highlights.slice(0, 3)),
    actionItems: Object.freeze(actionItems.length ? actionItems : ["Review the transcript and confirm the next implementation priority."]),
    artifacts,
    transcript: Object.freeze(userMessages.map((m) => Object.freeze({ ...m }))),
  });
}

export { ReportError };
