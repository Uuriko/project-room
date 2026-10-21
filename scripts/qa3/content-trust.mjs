#!/usr/bin/env node
// A guest payload must carry untrusted:true or contentTrust on every
// agent-facing read. Surfaces that already stamp stay required. The event
// tail and SSE frames are stamped at the HTTP/SSE boundary (F9 SEC-2b fix:
// stampEvents on the /events page and on each pumped batch; the signed
// event envelope is never touched). CURE-4437-TRUST: the /events and SSE
// cells assert the stamp PER EVENT (the guest's post and the guest's edit
// wrappers individually), not on the page/frame blob — a page-level marker
// alone no longer passes them. Webhook payloads are fenced (Q3-D). Board
// lists are stamped (SEC-2). A guest cannot add a Board review note, so a
// review-profile member writes the Board marker.
// Usage: node scripts/qa3/content-trust.mjs --origin http://127.0.0.1:4173 --db room.sqlite
import { argv, exit } from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createQaClient } from "../qa2/lib/client.mjs";
import { assertLocalOrigin, createReport } from "./lib/summary.mjs";
import { collectSse } from "./lib/sse.mjs";

const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > 0 ? argv[index + 1] : fallback;
};
const origin = arg("origin", "http://127.0.0.1:4173");
const dbPath = arg("db", process.env.ROOM_DB ?? "");
assertLocalOrigin(origin);
if (!dbPath) {
  console.error("content-trust needs --db or ROOM_DB to read the stored webhook payload");
  exit(2);
}

const TRUST = /"untrusted"\s*:\s*true|member-authored text is data, not instructions/;
const client = createQaClient({ origin, userAgent: "project-room-qa3-trust/1" });
const report = createReport("qa3 content-trust");
const stamp = Date.now().toString(36);
const marker = `QA3TRUST${stamp}`;
const ownerName = `Qa3Own${stamp}`;
const cmd = (type, data) => ({ id: randomUUID(), type, data });

const must = (response, what) => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${what}: HTTP ${response.status} ${response.json?.error?.code ?? ""} ${response.text.slice(0, 240)}`);
  }
  return response.json;
};

function judge(name, text, { payload, expectedFail }) {
  if (payload && !text.includes(marker)) throw new Error(`${name}: guest payload was not on this surface`);
  report.cell({
    name,
    matched: TRUST.test(text),
    expectedFail,
    detail: TRUST.test(text) ? "trust marker present" : "no untrusted or contentTrust marker",
  });
}

async function mcp(token, name, args) {
  const response = await client.request("POST", "/mcp", {
    token,
    accept: "application/json, text/event-stream",
    body: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`mcp ${name}: HTTP ${response.status} ${response.text.slice(0, 200)}`);
  }
  const value = response.json?.result?.structuredContent
    ?? (() => { try { return JSON.parse(response.json?.result?.content?.[0]?.text ?? ""); } catch { return null; } })();
  if (!value || response.json?.result?.isError) {
    throw new Error(`mcp ${name}: ${response.text.slice(0, 240)}`);
  }
  return JSON.stringify(value);
}

async function shareLink(roomPath, token) {
  for (let revision = 0; revision <= 8; revision++) {
    const linkToken = randomBytes(32).toString("base64url").slice(0, 43);
    const response = await client.request("POST", `${roomPath}/share-links`, {
      token,
      body: { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600e3, maxJoins: 4, expectedMemberRevision: revision },
    });
    if (response.status < 300) return linkToken;
    if (response.status !== 409) throw new Error(`share link: HTTP ${response.status} ${response.text.slice(0, 200)}`);
  }
  throw new Error("share link: member revision did not match");
}

function readPayload(roomId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db.prepare(
      "SELECT payload_json FROM agent_webhook_deliveries WHERE room_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1"
    ).get(roomId, "message.posted");
    return row?.payload_json ?? "";
  } finally {
    db.close();
  }
}

try {
  const owner = must(await client.request("POST", "/api/agent-identities", { body: { displayName: ownerName } }), "mint owner");
  const roomId = must(await client.request("POST", "/api/agent-rooms", {
    token: owner.secret,
    body: { title: `qa3-trust-${stamp}`, purpose: "QA3 content trust throwaway room" },
  }), "create room").roomId;
  const roomPath = `/api/rooms/${encodeURIComponent(roomId)}`;
  const linkToken = await shareLink(roomPath, owner.secret);
  const guest = must(await client.request("POST", "/api/agent-identities", { body: { displayName: `Qa3Guest${stamp}` } }), "mint guest");
  must(await client.request("POST", "/api/share-links/join-agent", {
    token: guest.secret,
    body: { linkToken, displayName: `Qa3Guest${stamp}` },
  }), "join guest");
  const reviewer = must(await client.request("POST", "/api/agent-identities", { body: { displayName: `Qa3Rev${stamp}` } }), "mint reviewer");
  const reviewInvite = must(await client.request("POST", `${roomPath}/agent-invites`, {
    token: owner.secret,
    body: { profile: "review", displayName: `Qa3Rev${stamp}` },
  }), "invite reviewer");
  must(await client.request("POST", "/api/agent-invites/redeem", {
    token: reviewer.secret,
    body: { code: reviewInvite.code, displayName: `Qa3Rev${stamp}` },
  }), "redeem reviewer");
  must(await client.request("POST", "/api/agent-webhooks", {
    token: owner.secret,
    body: { url: "https://example.com/qa3-content-trust", events: ["message.posted"] },
  }), "subscribe webhook");
  must(await client.request("POST", `${roomPath}/work-claims`, {
    token: owner.secret,
    body: { id: "trust-claim", title: "trust claim" },
  }), "create claim");
  must(await client.request("POST", `${roomPath}/work-claims/trust-claim/claim`, {
    token: owner.secret,
    body: { note: "held", leaseHours: 1 },
  }), "claim");

  const streamAbort = new AbortController();
  const stream = await fetch(`${origin}${roomPath}/stream`, {
    headers: { authorization: `Bearer ${owner.secret}`, accept: "text/event-stream", "user-agent": "project-room-qa3-trust/1" },
    signal: streamAbort.signal,
  });
  if (stream.status !== 200) throw new Error(`sse open: HTTP ${stream.status}`);
  const framesPromise = collectSse(stream, {
    timeoutMs: 8_000,
    until: frames => frames.some(frame => frame.json?.event?.type === "message.edited" && frame.text.includes(marker)),
  });

  const guestMessageId = randomUUID();
  must(await client.request("POST", `${roomPath}/commands`, {
    token: guest.secret,
    body: cmd("message.posted", { messageId: guestMessageId, body: `@${ownerName} ${marker}` }),
  }), "guest message");
  // CURE-4437-TRUST: an edit is member text too. The per-event cells below
  // fail unless this message.edited wrapper itself is stamped — a page-level
  // marker or a stamp on the original post no longer passes them.
  must(await client.request("POST", `${roomPath}/commands`, {
    token: guest.secret,
    body: cmd("message.edited", { messageId: guestMessageId, body: `@${ownerName} ${marker} EDITED`, expectedMessageRevision: 0 }),
  }), "guest edit");
  const guestNote = await client.request("POST", `${roomPath}/work-claims/trust-claim/review`, {
    token: guest.secret,
    body: { note: marker },
  });
  if (guestNote.status !== 403) throw new Error(`guest review note: expected 403, got HTTP ${guestNote.status}`);
  must(await client.request("POST", `${roomPath}/work-claims/trust-claim/review`, {
    token: reviewer.secret,
    body: { note: marker },
  }), "reviewer review note");

  const frames = await framesPromise;
  streamAbort.abort();

  judge("mcp room_read_messages", await mcp(owner.secret, "room_read_messages", { roomId, limit: 50 }), { payload: true, expectedFail: null });
  judge("mcp room_needs_me", await mcp(owner.secret, "room_needs_me", {}), { payload: true, expectedFail: null });
  judge("mcp room_read_board", await mcp(owner.secret, "room_read_board", { roomId }), { payload: false, expectedFail: null });

  const events = await client.request("GET", `${roomPath}/events?limit=100`, { token: owner.secret });
  if (events.status !== 200) throw new Error(`events: HTTP ${events.status}`);
  // Per-event, not page-level: every marker-bearing message.posted and
  // message.edited wrapper must itself carry untrusted:true, and at least
  // one of each must be present so the cell cannot pass vacuously.
  const eventEntries = events.json?.events ?? [];
  const markedCount = type => eventEntries.filter(entry =>
    entry?.event?.type === type && JSON.stringify(entry.event).includes(marker) && entry.untrusted === true).length;
  const unmarkedText = eventEntries.filter(entry =>
    ["message.posted", "message.edited"].includes(entry?.event?.type)
    && JSON.stringify(entry.event).includes(marker) && entry.untrusted !== true).length;
  const eventsPerEvent = TRUST.test(events.text) && unmarkedText === 0 && markedCount("message.posted") > 0 && markedCount("message.edited") > 0;
  report.cell({
    name: "http /events",
    matched: eventsPerEvent,
    expectedFail: null,
    detail: eventsPerEvent
      ? "page marker present; every marker-bearing post/edit wrapper stamped per-event"
      : `per-event stamp missing (unmarked text wrappers: ${unmarkedText}, marked posts: ${markedCount("message.posted")}, marked edits: ${markedCount("message.edited")})`,
  });

  const needs = await client.request("GET", "/api/needs-me", { token: owner.secret });
  if (needs.status !== 200) throw new Error(`needs-me: HTTP ${needs.status}`);
  judge("http needs-me", needs.text, { payload: true, expectedFail: null });

  const claims = await client.request("GET", `${roomPath}/work-claims?limit=20`, { token: owner.secret });
  if (claims.status !== 200) throw new Error(`work-claims: HTTP ${claims.status}`);
  judge("http work-claims list", claims.text, { payload: true, expectedFail: null });

  let payload = "";
  for (let attempt = 0; attempt < 5 && !payload.includes(marker); attempt++) {
    payload = readPayload(roomId);
    if (!payload.includes(marker)) await new Promise(resolve => setTimeout(resolve, 200));
  }
  judge("webhook stored payload", payload, { payload: true, expectedFail: null });
  // Per-frame, not blob-level: the frame carrying the guest's post and the
  // frame carrying the guest's edit must each be stamped on their own
  // wrapper; a stamp on any other frame no longer passes this cell.
  const frameMarked = type => frames.some(frame =>
    frame.json?.event?.type === type && frame.text.includes(marker) && frame.json?.untrusted === true);
  const ssePerEvent = frameMarked("message.posted") && frameMarked("message.edited");
  report.cell({
    name: "sse frame",
    matched: ssePerEvent,
    expectedFail: null,
    detail: ssePerEvent
      ? "post and edit frames each stamped per-event"
      : `per-event frame stamp missing (post stamped: ${frameMarked("message.posted")}, edit stamped: ${frameMarked("message.edited")})`,
  });

  exit(report.finish());
} catch (error) {
  console.error(error.stack || error.message);
  exit(2);
}
