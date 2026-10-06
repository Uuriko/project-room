// O005 backlog: docs/ARCHITECTURE.md must not drift from the code.
// Every module, route path, claim state, and event type named in the overview
// is asserted here against the code. Failing-first (2026-10-06): the
// DELIBERATE OVERREACH entries below were names the doc author reached for
// (server/relay.mjs, server/machine-link.mjs, server/event-bus.mjs, event
// "claim.settled", route /api/rooms/:roomId/relay) that do NOT exist in the
// repo — they stay pinned as negative assertions so the doc can never
// reintroduce them.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_TYPES } from "../src/events.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const httpSrc = read("server/http.mjs");

const eventValues = new Set(Object.values(EVENT_TYPES));

test("architecture doc names only server modules that exist", () => {
  const modules = [
    "server/http.mjs",
    "server/messages-store.mjs",
    "server/channel-journal.mjs",
    "server/graph-reply-journal.mjs",
    "server/public-read-model.mjs",
    "server/inbox-outbox.mjs",
    "server/work-claims.mjs",
    "server/work-claim-routes.mjs",
    "server/work-claim-events.mjs",
    "server/claim-pr-sync.mjs",
    "server/claim-reputation.mjs",
    "server/agent-webhook-subscriptions.mjs",
    "server/outbound-webhooks.mjs",
    "server/a2a-jsonrpc.mjs",
    "server/mcp-discovery.mjs",
    "server/mcp-hosted-tools.mjs",
    "server/guest-invites.mjs",
    "server/guest-agent-links.mjs",
    "server/share-links.mjs",
    "server/agent-invites.mjs",
    "server/typing.mjs",
    "server/routes/typing.mjs",
    "server/channel-adapters/index.mjs",
    "server/room-export-html.mjs",
    "server/room-activation-pack.mjs",
    "deploy/agent-discovery.mjs",
    "src/events.js",
    "src/mcp-server-card.mjs",
    // DELIBERATE OVERREACH (failing-first): these do not exist.
    "server/relay.mjs",
    "server/machine-link.mjs",
    "server/event-bus.mjs",
  ];
  for (const m of modules) {
    if (m.includes("relay") || m.includes("machine-link") || m.includes("event-bus")) {
      assert.ok(!existsSync(join(root, m)), `${m} must NOT exist (doc must not name it)`);
    } else {
      assert.ok(existsSync(join(root, m)), `${m} must exist (doc names it)`);
    }
  }
});

test("architecture doc names only route paths that are served", () => {
  const markers = [
    // [doc path, file to search, source marker]
    ["/api/rooms/{roomId}/commands", "server/http.mjs", 'route === "commands" && req.method === "POST"'],
    ["/api/rooms/{roomId}/stream", "server/http.mjs", 'route === "stream" && req.method === "GET"'],
    ["/api/rooms/{roomId}/events", "server/http.mjs", 'route === "events" && req.method === "GET"'],
    ["/api/rooms/{roomId}/work-claims", "server/work-claim-routes.mjs", "/api/rooms/{roomId}/work-claims"],
    ["/api/guest-invites/redeem", "server/http.mjs", '"/api/guest-invites/redeem"'],
    ["/api/guest-agent-links/join", "server/http.mjs", '"/api/guest-agent-links/join"'],
    ["/api/share-links/join-agent", "server/http.mjs", '"/api/share-links/join-agent"'],
    ["/api/rooms/{roomId}/typing", "server/routes/typing.mjs", "POST /api/rooms/{roomId}/typing"],
    ["/a2a", "server/a2a-jsonrpc.mjs", '"/a2a"'],
    ["/mcp", "deploy/agent-discovery.mjs", '"/mcp"'],
    ["/.well-known/agent-card.json", "deploy/agent-discovery.mjs", '"/.well-known/agent-card.json"'],
    ["/skills", "deploy/agent-discovery.mjs", '"/skills"'],
    ["/api/public/receipts", "server/http.mjs", '"/api/public/receipts"'],
    ["#agent-join/<token>", "server/guest-agent-links.mjs", '#agent-join/'],
  ];
  for (const [docPath, file, marker] of markers) {
    assert.ok(read(file).includes(marker), `${docPath} (via ${file}) must be served`);
  }
});

test("architecture doc names only claim states the code uses", () => {
  const src = read("server/work-claims.mjs");
  for (const state of ["unclaimed", "claimed", "in_progress", "blocked", "done"]) {
    assert.ok(src.includes(`"${state}"`), `claim state ${state} must appear in server/work-claims.mjs`);
  }
});

test("architecture doc names only event types from src/events.js", () => {
  const named = [
    "room.created",
    "member.added",
    "member.joined_via_invitation",
    "message.posted",
    "message.edited",
    "message.deleted",
    "room.exported",
    "work.proposed",
    "work.accepted",
    "work.started",
    "work.blocked",
    "work.completed",
    "claim.acquired",
    "claim.released",
    "claim.renewed",
    "work_claim.updated",
    "verification.recorded",
    "dm.posted",
    "land.updated",
  ];
  for (const t of named) assert.ok(eventValues.has(t), `event ${t} must be in EVENT_TYPES`);
  // DELIBERATE OVERREACH (failing-first): must stay absent.
  assert.ok(!eventValues.has("claim.settled"), "claim.settled must NOT exist");
  assert.ok(!eventValues.has("message.relayed"), "message.relayed must NOT exist");
});

test("architecture doc does not name the overreach identifiers anywhere", () => {
  const doc = read("docs/ARCHITECTURE.md");
  for (const bad of [
    "server/relay.mjs",
    "server/machine-link.mjs",
    "server/event-bus.mjs",
    "claim.settled",
    "message.relayed",
    "/api/rooms/:roomId/relay",
  ]) {
    assert.ok(!doc.includes(bad), `ARCHITECTURE.md must not name ${bad}`);
  }
});
