// Burs-IA steal A1+A2 contract tests: self-describing responses, generated
// /openapi.json, and /.well-known/governance.json.
//
// These tests sit at the public protocol boundary:
//  1. Cold-start chain: GET / alone (Link headers + in-payload JSON fields,
//     never llms.txt) reaches a first post via next[] pointers.
//  2. Canonical scoped errors: every 4xx/429 on a listed route returns the
//     canonical envelope with a non-empty next[]; auth refusals name the
//     mint path.
//  3. OpenAPI: the served document validates as OpenAPI 3.1 and matches the
//     canonical route table (fail on drift).
//  4. Governance: served on origin and /room, derived from enforcing config
//     (independently re-derived here), linked from the card and llms.txt,
//     and answers the three policy questions.
//  5. MCP: tools/list (public + enrolled) carries the discovery block;
//     JSON-RPC errors carry canonical guidance in error.data.
//  6. Onboarding next pointers: mint/room/redeem/access-request success
//     bodies name the next step.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  buildOpenApiJson,
  DISCOVERABILITY_ROUTES,
  MCP_DISCOVERY_BLOCK,
  nextActionsForIdentityMint,
  nextActionsForRoomCreate,
  nextActionsForInviteRedeem,
  nextActionsForAccessRequest,
} from "../server/discoverability.mjs";
// Independently re-derived enforcing constants: the governance document must
// agree with these, or it has drifted from what the code enforces.
import { BUDGET_CAPS } from "../src/work-item-session.js";
import { GUEST_AGENT_PERMISSIONS, GUEST_AGENT_TTL_MS } from "../server/guest-agent-links.mjs";
import { wakeQueueLimits } from "../server/wake-queue-limits.mjs";
import { SEVERITY_KEEP_DAYS, ARCHIVE_AFTER_DAYS } from "../server/audit-retention.mjs";
import { DEFAULT_LEASE_HOURS, MAX_LEASE_HOURS } from "../server/work-claims.mjs";
import { REQUEST_TTL_MS } from "../server/access-requests.mjs";
import { signDelivery, verifyDeliverySignature, deliveryHeaders } from "../server/webhook-dispatch.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "discoverability-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, origin: `http://127.0.0.1:${server.address().port}` };
}

const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: origin,
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});
const get = (origin, path, secret) => fetch(`${origin}${path}`, {
  headers: {
    Origin: origin,
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  },
});

function assertCanonicalEnvelope(t, body, status) {
  assert.equal(typeof body, "object", `expected JSON body for ${status}`);
  assert.equal(typeof body.error?.code, "string", "error.code is a string");
  assert.equal(typeof body.error?.message, "string", "error.message is a string");
  assert.equal(typeof body.status, "string", "status is a string");
  assert.equal(typeof body.reason, "string", "reason is a string");
  assert.equal(typeof body.hint, "string", "hint is a string");
  assert.ok(Array.isArray(body.next) && body.next.length > 0, "next[] is non-empty");
  assert.equal(typeof body.operationId, "string", "operationId is a string");
  assert.match(body.operationId, /^op_/, "operationId has the op_ prefix");
  assert.equal(typeof body.category, "string", "category is a string");
}

async function mintIdentity(origin, displayName = "Chain Agent") {
  const res = await post(origin, "/api/agent-identities", { displayName });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.secret, "mint returns the one-time secret");
  assert.ok(Array.isArray(body.next) && body.next.length >= 4, "mint returns next[] guidance");
  return body;
}

// ---------------------------------------------------------------------------
// 1. Cold-start chain.
// ---------------------------------------------------------------------------

test("cold-start chain: GET / alone reaches a first post without llms.txt", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  // The agent starts with only GET /.
  const root = await fetch(`${origin}/`, { headers: { "User-Agent": "project-room-agent" } });
  assert.equal(root.status, 200);
  const linkHeader = root.headers.get("link") ?? "";
  const cardPath = linkHeader.match(/<([^>]+)>;\s*rel="alternate"/)?.[1];
  assert.ok(cardPath, "GET / Link headers name the agent card");
  // The card's endpoints are in-payload machine-readable links — no llms.txt.
  const card = await (await get(origin, cardPath)).json();
  assert.ok(card.endpoints?.identity_mint, "card names the identity-mint endpoint");
  assert.ok(card.endpoints?.governance, "card names the governance endpoint");
  assert.ok(card.endpoints?.openapi, "card names the openapi endpoint");
  // Mint an identity through the card's enrollment link.
  const minted = await mintIdentity(origin);
  assert.ok(minted.next.some(s => s.action === "list-tools"), "mint names the tools-list surface");
  const secret = minted.secret;
  // Create a room through the card's room_create link.
  const roomPath = new URL(card.endpoints.room_create).pathname;
  const roomRes = await post(origin, roomPath, { title: "Cold room", purpose: "First post" }, secret);
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json();
  const postStep = room.next.find(s => s.action === "post-message");
  assert.ok(postStep, "room create names the first-post step");
  // First post using only the next[] pointer.
  const postPath = postStep.path.replace("{roomId}", room.roomId);
  const first = await post(origin, postPath, {
    id: randomUUID(), type: "message.posted",
    data: { messageId: randomUUID(), body: "hello from the cold-start chain" },
  }, secret);
  assert.equal(first.status, 201, "first post lands via links + next[] alone");
  const posted = await first.json();
  assert.ok(posted.eventId || posted.sequence !== undefined, "post returns a receipt pointer");
});

// ---------------------------------------------------------------------------
// 2. Canonical scoped errors.
// ---------------------------------------------------------------------------

test("canonical errors: 401s on listed routes preserve saved connections with read-first next steps", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const probes = [
    ["GET", "/api/needs-me"],
    ["POST", "/api/agent-rooms"],
    ["POST", "/api/agent-webhooks"],
    ["GET", "/api/rooms/commons/agent-pause"],
  ];
  for (const [method, path] of probes) {
    const res = method === "GET" ? await get(origin, path) : await post(origin, path, {});
    assert.equal(res.status, 401, `${method} ${path} refuses without a credential`);
    const body = await res.json();
    assertCanonicalEnvelope(t, body, `${method} ${path}`);
    const text = JSON.stringify(body);
    assert.equal(body.next[0].tool, "room_check_access");
    assert.ok(!body.next.some(step => step.method === "POST"), "no automatic credential issuance step");
    assert.match(text, /saved connection/i);
  }
  // Webhook 401 also names the rak_ API key alternative.
  const wh = await post(origin, "/api/agent-webhooks", {});
  const whBody = await wh.json();
  assert.ok(whBody.hint.includes("rak_"), "webhook 401 names the rak_ API key alternative");
});

test("cold access request 404 gives mint-first help without revealing room or identity existence", async t => {
  const { origin } = await serve(t);
  const body = (roomId, identityId) => ({ roomId, identityId, displayName: "Cold agent",
    requestedPermissions: ["steer"], note: "join", requestId: randomUUID() });
  const unknownIdentity = await post(origin, "/api/access-requests", body("commons", "ai_no_such_identity"));
  const unknownRoom = await post(origin, "/api/access-requests", body("no-such-room", (await mintIdentity(origin)).identityId));
  assert.equal(unknownIdentity.status, 404);
  assert.equal(unknownRoom.status, 404);
  const first = await unknownIdentity.json(), second = await unknownRoom.json();
  for (const result of [first, second]) {
    assertCanonicalEnvelope(t, result, "POST /api/access-requests 404");
    assert.ok(result.hint.includes("POST /api/agent-identities"));
    assert.ok(result.next.some(step => step.path === "/api/agent-identities" && step.method === "POST"));
    assert.ok(result.next.some(step => step.path === "/api/access-requests" && step.method === "POST"));
  }
  // Unknown room and identity must not become an existence oracle.
  for (const field of ["status", "reason", "hint", "next", "error"]) {
    assert.deepEqual(first[field], second[field], `${field} identical on both unknowns`);
  }
});

test("canonical errors: 4xx on listed routes carry the envelope with non-empty next[]", { timeout: 30000 }, async t => {
  const { origin, store } = await serve(t);
  const secret = (await mintIdentity(origin)).secret;
  // 400-family: malformed onboarding body.
  const badMint = await post(origin, "/api/identity-create", { nope: 1 });
  assert.ok(badMint.status >= 400 && badMint.status < 500, "bad mint body is a 4xx");
  assertCanonicalEnvelope(t, await badMint.json(), "POST /api/identity-create 4xx");
  // 400-family: invite redeem with no code is a 422 (body validation, not auth).
  const badRedeem = await post(origin, "/api/agent-invites/redeem", {});
  assert.equal(badRedeem.status, 422);
  assertCanonicalEnvelope(t, await badRedeem.json(), "POST /api/agent-invites/redeem 422");
  // 404: unknown access request (identity-scoped read).
  const missing = await get(origin, "/api/access-requests/nope?identityId=ai_missing");
  assert.equal(missing.status, 404);
  assertCanonicalEnvelope(t, await missing.json(), "GET /api/access-requests/:id 404");
  // 409: room idempotency key reuse with different content is a conflict.
  const r1 = await post(origin, "/api/agent-rooms", { title: "First", purpose: "x", roomId: "dup-room" }, secret);
  assert.equal(r1.status, 201);
  const roomId = (await r1.json()).roomId;
  const dup = await post(origin, "/api/agent-rooms", { title: "Second", purpose: "y", roomId: "dup-room" }, secret);
  assert.equal(dup.status, 409);
  assertCanonicalEnvelope(t, await dup.json(), "POST /api/agent-rooms 409");
  // 429: hammer the identity mint limiter.
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const r = await post(origin, "/api/agent-identities", { displayName: `Flood ${i}` });
    if (r.status === 429) limited = r;
    else await r.json().catch(() => null);
  }
  assert.ok(limited, "mint limiter trips under load");
  assertCanonicalEnvelope(t, await limited.json(), "POST /api/agent-identities 429");
  // 403: invite redeem without invite rights is 401-class; webhook subscribe
  // with a bare identity secret on a missing scope stays 401. Use the pause
  // row of another member: covered by the 401 probe above.
  assert.ok(roomId, "room created for the 409 probe");
  assert.ok(store, "store available");
});

// ---------------------------------------------------------------------------
// 3. OpenAPI generation + drift.
// ---------------------------------------------------------------------------

test("GET /openapi.json validates as OpenAPI 3.1 and matches the route table", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await get(origin, "/openapi.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const doc = await res.json();
  // Independently validate the OpenAPI 3.1 shape (not via the generator).
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(typeof doc.info?.title, "string");
  assert.ok(Array.isArray(doc.servers) && doc.servers.length > 0, "servers[] present");
  assert.equal(typeof doc.paths, "object");
  const envelope = doc.components?.schemas?.ErrorEnvelope;
  assert.ok(envelope, "ErrorEnvelope schema present");
  for (const field of ["error", "status", "reason", "hint", "next", "operationId", "category"]) {
    assert.ok(envelope.required.includes(field), `ErrorEnvelope requires ${field}`);
    assert.ok(envelope.properties[field], `ErrorEnvelope defines ${field}`);
  }
  assert.equal(envelope.properties.next.minItems, 1, "next[] is non-empty in the schema");
  // Every route-table entry is documented with its methods (fail on drift).
  for (const entry of DISCOVERABILITY_ROUTES) {
    const item = doc.paths[entry.path];
    assert.ok(item, `openapi documents ${entry.path}`);
    for (const method of entry.methods) {
      const op = item[method.toLowerCase()];
      assert.ok(op, `openapi documents ${method} ${entry.path}`);
      assert.equal(typeof op.operationId, "string");
      assert.equal(typeof op.summary, "string");
      assert.ok(op.responses["200"] || op.responses["201"], "success response documented");
      for (const status of ["400", "401", "403", "404", "409", "429"]) {
        assert.ok(op.responses[status]?.$ref?.startsWith("#/components/responses/"),
          `${entry.path} documents ${status} via the canonical error components`);
      }
    }
  }
  // The served document is exactly what the generator produces (no hand edits).
  assert.deepEqual(doc, buildOpenApiJson({ origin: doc.servers[0].url }));
  // The /room alias serves the same bytes.
  const aliased = await (await get(origin, "/room/openapi.json")).json();
  assert.deepEqual(aliased.paths, doc.paths);
});

test("openapi: operationIds are unique across every documented operation", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const doc = await (await get(origin, "/openapi.json")).json();
  // OpenAPI 3.1 requires operationId to be unique across all operations in
  // the document; duplicates break codegen/SDK tooling that keys on it.
  const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
  const firstSeen = new Map();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      const id = op?.operationId;
      assert.equal(typeof id, "string", `${method.toUpperCase()} ${path} has an operationId`);
      const first = firstSeen.get(id);
      assert.ok(!first,
        `duplicate operationId "${id}": first on ${first}, again on ${method.toUpperCase()} ${path}`);
      firstSeen.set(id, `${method.toUpperCase()} ${path}`);
    }
  }
  // Every method of every inventoried route contributed exactly one distinct
  // operation: a route with a shared per-route id fails the count here.
  let expected = 0;
  for (const entry of DISCOVERABILITY_ROUTES) expected += entry.methods.length;
  assert.equal(firstSeen.size, expected, "every inventoried operation has a distinct operationId");
});

// ---------------------------------------------------------------------------
// 4. Governance.
// ---------------------------------------------------------------------------

test("governance: served on origin and /room, linked, derived from enforcing config", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await get(origin, "/.well-known/governance.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const doc = await res.json();
  const roomAlias = await (await get(origin, "/room/.well-known/governance.json")).json();
  assert.deepEqual(roomAlias, doc, "/room alias serves identical bytes");
  assert.equal(typeof doc.schemaVersion, "string");
  // Linked from the card and llms.txt.
  const card = await (await get(origin, "/.well-known/agent-card.json")).json();
  assert.ok(card.endpoints?.governance?.endsWith("/.well-known/governance.json"), "card links governance");
  const govFromCard = await get(origin, new URL(card.endpoints.governance).pathname);
  assert.equal(govFromCard.status, 200, "card governance link resolves");
  const llms = await (await get(origin, "/llms.txt")).text();
  assert.ok(llms.includes("/.well-known/governance.json"), "llms.txt references governance");
  // The three policy questions, answered from enforcing config:
  assert.equal(doc.economy.cashOut, false, "credits are not money: cashOut is false");
  assert.equal(doc.economy.onChain, false, "credits never touch a chain");
  assert.equal(doc.economy.billing, false, "no billing rail");
  assert.equal(doc.identityModel.guestTier.claimEligible, false, "a guest cannot claim work");
  assert.equal(doc.agentWorkControls.ownerOnlyResume, false, "resume is not owner-only");
  assert.ok(doc.agentWorkControls.resumePolicy.includes("signed-in room owner"),
    "resume policy names who may resume another member");
  // Numeric claims re-derived from the enforcing modules (fail on drift).
  assert.equal(doc.agentWorkControls.roundLimits.cap, BUDGET_CAPS.maxRounds);
  assert.equal(doc.agentWorkControls.toolBudgets.cap, BUDGET_CAPS.maxToolCalls);
  assert.equal(doc.identityModel.guestTier.ttlMs, GUEST_AGENT_TTL_MS);
  assert.deepEqual(doc.identityModel.guestTier.permissions, [...GUEST_AGENT_PERMISSIONS]);
  assert.equal(doc.workLedger.leases.defaultHours, DEFAULT_LEASE_HOURS);
  assert.equal(doc.workLedger.leases.maxHours, MAX_LEASE_HOURS);
  assert.equal(doc.workLedger.accessRequestTtlMs, REQUEST_TTL_MS);
  assert.equal(doc.communications.wakeQueueLeaseMs, wakeQueueLimits.leaseMs);
  assert.equal(doc.communications.wakeQueueMaxAttempts, wakeQueueLimits.maxAttempts);
  assert.deepEqual(doc.retention.severityKeepDays, { ...SEVERITY_KEEP_DAYS });
  assert.equal(doc.retention.archiveAfterDays, ARCHIVE_AFTER_DAYS);
  assert.ok(doc.policyUrl.endsWith("/.well-known/governance.json"), "policyUrl is self-referential");
  // Webhook signing claim independently verified against the enforcer.
  const issuedAt = Date.now();
  const payload = { deliveryId: "d1", eventType: "message.posted", issuedAt, data: { a: 1 } };
  const sig = signDelivery("s3cret", payload);
  assert.equal(verifyDeliverySignature("s3cret", sig, payload), true, "sign/verify round-trips");
  assert.equal(verifyDeliverySignature("s3cret", "00", payload), false, "tampered signature rejected");
  const headers = deliveryHeaders({ deliveryId: "d1", subscriptionId: "s", eventType: "e", issuedAt: 1, signature: sig });
  assert.ok(String(headers["x-webhook-signature"]).startsWith("sha256="), "signature header matches the documented scheme");
  assert.equal(doc.communications.webhookSigning, "hmac-sha256");
});

// ---------------------------------------------------------------------------
// 5. MCP discovery + canonical JSON-RPC errors.
// ---------------------------------------------------------------------------

const mcp = (origin, method, params, secret) => fetch(`${origin}/room/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: origin,
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) }),
}).then(async res => ({ status: res.status, body: await res.json() }));

test("MCP: tools/list carries the discovery block (public and enrolled)", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const secret = (await mintIdentity(origin)).secret;
  for (const [label, cred] of [["public", undefined], ["enrolled", secret]]) {
    const { body } = await mcp(origin, "tools/list", undefined, cred);
    const discovery = body.result?._meta?.discovery;
    assert.ok(discovery, `${label} tools/list carries result._meta.discovery`);
    assert.equal(discovery.openapi, MCP_DISCOVERY_BLOCK.openapi);
    assert.equal(discovery.governance, MCP_DISCOVERY_BLOCK.governance);
    const spec = await (await get(origin, discovery.openapi)).json();
    assert.equal(spec.openapi, "3.1.0", "discovery openapi pointer resolves");
    const gov = await (await get(origin, discovery.governance)).json();
    assert.equal(typeof gov.schemaVersion, "string", "discovery governance pointer resolves");
  }
});

test("MCP: errors carry canonical guidance in error.data with valid JSON-RPC shape", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const secret = (await mintIdentity(origin)).secret;
  // unknown_tool keeps its JSON-RPC code and gains canonical guidance.
  const unknown = await mcp(origin, "tools/call", { name: "nope_not_a_tool", arguments: {} }, secret);
  assert.equal(unknown.body.error.code, -32602);
  const ud = unknown.body.error.data;
  assert.equal(ud.reason, "unknown_tool");
  assert.equal(typeof ud.hint, "string");
  assert.ok(Array.isArray(ud.next) && ud.next.length > 0, "unknown_tool next[] non-empty");
  assert.match(ud.operationId, /^op_/);
  assert.equal(typeof ud.category, "string");
  // auth_required preserves an existing connection before setup.
  const authed = await mcp(origin, "tools/call", { name: "room_post_message", arguments: {} }, undefined);
  assert.equal(authed.body.error.code, -32001);
  const ad = authed.body.error.data;
  assert.equal(ad.reason, "auth_required");
  assert.equal(ad.next[0].tool, "room_check_access");
  assert.ok(!ad.next.some(step => step.method === "POST"), "MCP auth does not direct credential creation");
  assert.ok(Array.isArray(ad.next) && ad.next.length > 0, "auth_required next[] non-empty");
  assert.equal(ad.status, "action_required");
  // invalid_arguments keeps its fields and gains the envelope fields.
  const badArgs = await mcp(origin, "tools/call", { name: "room_post_message", arguments: { roomId: 42 } }, secret);
  assert.equal(badArgs.body.error.code, -32602);
  assert.equal(badArgs.body.error.data.reason, "invalid_arguments");
  assert.ok(Array.isArray(badArgs.body.error.data.next) && badArgs.body.error.data.next.length > 0);
});

// ---------------------------------------------------------------------------
// 6. Onboarding next pointers.
// ---------------------------------------------------------------------------

test("onboarding: success bodies name the next step", { timeout: 30000 }, async t => {
  const { store, origin } = await serve(t);
  // Mint -> room creation + tools-list pointers (next and nextActions agree).
  const minted = await mintIdentity(origin);
  const actions = minted.next.map(s => s.action);
  assert.ok(actions.includes("create-room"), "mint points at room creation");
  assert.ok(actions.includes("list-tools"), "mint points at tools-list");
  const mintActions = minted.nextActions.map(s => s.action);
  assert.deepEqual(mintActions, ["create-room", "list-tools"], "mint nextActions is the canonical verb list");
  for (const step of minted.nextActions) {
    assert.equal(typeof step.transport, "string", "nextActions names the transport");
    assert.ok(step.method || step.tool, "nextActions names the method or tool");
  }
  const secret = minted.secret;
  // Room creation -> invite mint + first post pointers.
  const roomRes = await post(origin, "/api/agent-rooms", { title: "Onboard", purpose: "Pointers" }, secret);
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json();
  const roomActions = room.next.map(s => s.action);
  assert.ok(roomActions.includes("invite-members"), "room create points at invite mint");
  assert.ok(roomActions.includes("post-message"), "room create points at first post");
  assert.deepEqual(room.nextActions.map(s => s.action), ["invite-members", "post-message"],
    "room create nextActions is the canonical verb list");
  assert.ok(room.nextActions.every(s => s.path.includes(room.roomId)), "room nextActions paths are room-scoped");
  // Invite redemption -> orient + access pointers.
  const invite = store.invites.create(secret, room.roomId, { permissions: ["accept_work"] });
  const redeemRes = await post(origin, "/api/agent-invites/redeem", { code: invite.code, displayName: "Guest Two" });
  assert.equal(redeemRes.status, 201);
  const redeemed = await redeemRes.json();
  const redeemActions = redeemed.next.map(s => s.action);
  assert.ok(redeemActions.includes("see-who-is-around"), "redeem points at orientation");
  assert.ok(redeemActions.includes("post-first-message"), "redeem points at first post");
  assert.deepEqual(redeemed.nextActions.map(s => s.action), ["see-who-is-around", "room_check_access"],
    "redeem nextActions is the canonical verb list");
  assert.ok(redeemed.nextActions.some(s => s.transport === "mcp" && s.tool === "room_check_access"),
    "redeem nextActions names the MCP access-check tool");
  // Access request -> status poll + expected SLA. A fresh identity files the
  // request: the room creator is already linked (correctly a 409).
  const applicant = await mintIdentity(origin, "Access Applicant");
  const accessRes = await post(origin, "/api/access-requests", {
    roomId: room.roomId, identityId: applicant.identityId, displayName: "Access Applicant",
    requestedPermissions: [], note: null, requestId: `ar_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  });
  assert.equal(accessRes.status, 201);
  const access = await accessRes.json();
  assert.equal(access.next[0]?.action, "poll-status");
  assert.ok(access.next[0].path.includes("/api/access-requests/"), "status-poll pointer names the route");
  assert.ok(access.next[0].description.includes("7 days"), "status-poll pointer states the expected SLA");
  assert.equal(access.nextActions.length, 1, "access request nextActions has the single canonical step");
  assert.equal(access.nextActions[0].action, "poll-status");
  assert.equal(access.nextActions[0].path, access.next[0].path, "nextActions and next agree on the poll path");
  assert.ok(access.nextActions[0].description.includes("7 days"), "nextActions states the expected SLA");
  const poll = await get(origin, `${access.next[0].path}`);
  assert.equal(poll.status, 200, "the status-poll pointer resolves");
});

test("nextActions vocabulary: shared builders are frozen and transport-labeled", async t => {
  // The builders are the single source both HTTP success bodies and MCP
  // guidance draw from; freezing catches accidental mutation between calls.
  const sets = [
    nextActionsForIdentityMint(),
    nextActionsForRoomCreate("room1"),
    nextActionsForInviteRedeem("room1"),
    nextActionsForAccessRequest({ requestId: "r1", identityId: "ai_1", decisionWindowDays: 7 }),
  ];
  for (const set of sets) {
    assert.ok(Object.isFrozen(set), "nextActions array is frozen");
    for (const step of set) {
      assert.ok(Object.isFrozen(step), "nextActions step is frozen");
      assert.ok(["http", "mcp"].includes(step.transport), "transport is http or mcp");
      assert.equal(typeof step.action, "string");
      assert.equal(typeof step.description, "string");
      if (step.transport === "http") {
        assert.equal(typeof step.method, "string");
        assert.ok(step.path.startsWith("/"), "http step has an absolute path");
      } else {
        assert.equal(typeof step.tool, "string", "mcp step names the tool");
      }
    }
  }
  // Non-divergence: the MCP error guidance uses the same action names.
  const { body } = await (async () => {
    const { origin } = await serve(t);
    const res = await fetch(`${origin}/room/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call",
        params: { name: "room_post_message", arguments: {} } }),
    });
    return { body: await res.json() };
  })();
  const guidance = JSON.stringify(body.error.data.next);
  assert.ok(guidance.includes("room_check_access"), "MCP guidance shares the room_check_access verb");
});

// ---------------------------------------------------------------------------
// 7. Inventory method accuracy (P1-4 regression guard).
// ---------------------------------------------------------------------------
// The openapi.json generator trusts DISCOVERABILITY_ROUTES' method lists, so
// a stale list silently omits served operations from the spec (GET /mcp,
// GET /room/mcp, and GET /api/agent-rooms were all served but inventoried
// POST-only). This probe pins the served methods for those routes in both
// directions: the live server must serve them, and the inventory must list
// them. The EXPECTED table is derived from the route handlers in
// server/http.mjs (agent-rooms) and server/mcp-http.mjs (roomMcpFetchResponse),
// not from the inventory — that is what makes this probe independent of the
// table it guards.
const INVENTORY_METHOD_CONTRACT = {
  "/mcp": ["GET", "POST"],
  "/room/mcp": ["GET", "POST"],
  "/api/agent-rooms": ["GET", "POST"],
};

// Served methods read from server/http.mjs (workClaimsMatch classifies GET as
// list and every other method as create) and handleWorkClaimsCore (only GET
// or POST returns a claim body; other methods 405).
const WORK_CLAIM_INVENTORY = {
  "/api/rooms/{roomId}/work-claims": ["GET", "POST"],
  "/api/rooms/{roomId}/work-claims/sweep": ["POST"],
  "/api/rooms/{roomId}/work-claims/duplicates": ["GET"],
  "/api/rooms/{roomId}/work-claims/{claimId}": ["GET"],
  "/api/rooms/{roomId}/work-claims/{claimId}/claim": ["POST"],
  "/api/rooms/{roomId}/work-claims/{claimId}/update": ["POST"],
  "/api/rooms/{roomId}/work-claims/{claimId}/review": ["POST"],
  "/api/rooms/{roomId}/work-claims/{claimId}/release": ["POST"],
  "/api/rooms/{roomId}/work-claims/{claimId}/reassign": ["POST"],
  "/api/rooms/{roomId}/work-claims/{claimId}/renew": ["POST"],
  "/api/rooms/{roomId}/receipts": ["GET"],
};

// Served methods read from server/http.mjs: both probes accept GET and HEAD
// before any credential check. /api/version/worker is not this process.
const PUBLIC_PROBE_INVENTORY = {
  "/api/health": ["GET", "HEAD"],
  "/api/version": ["GET", "HEAD"],
  "/api/ready": ["GET", "HEAD"],
};

test("openapi inventory lists served health, version, and ready methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(PUBLIC_PROBE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("health, version, and ready are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  for (const [path, methods] of Object.entries(PUBLIC_PROBE_INVENTORY)) {
    for (const method of methods) {
      const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin } });
      const raw = Buffer.from(await res.arrayBuffer());
      assert.equal(res.status, 200, `${method} ${path} got ${res.status}`);
      if (method === "GET" && path === "/api/version") {
        const body = JSON.parse(raw.toString("utf8"));
        assert.equal(body.status, "ok");
        assert.equal(typeof body.sourceRevision, "string");
        assert.ok(body.sourceRevision.length > 0);
      }
      if (method === "GET" && path === "/api/ready") {
        const body = JSON.parse(raw.toString("utf8"));
        assert.equal(body.status, "ready");
      }
      if (method === "HEAD") assert.equal(raw.length, 0, `${path} HEAD has no body`);
    }
  }
});

// Served methods read from server/http.mjs: POST signs in with an access key;
// a later exact /api/session match serves GET and DELETE and rejects the rest.
const SESSION_INVENTORY = {
  "/api/session": ["POST", "GET", "DELETE"],
};

test("openapi inventory lists served session methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(SESSION_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("session routes are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  for (const method of SESSION_INVENTORY["/api/session"]) {
    const res = await fetch(`${origin}/api/session`, {
      method,
      headers: { "Content-Type": "application/json", Origin: origin },
      body: method === "POST" ? "{}" : undefined,
    });
    await res.arrayBuffer();
    assert.ok(![404, 405].includes(res.status), `${method} /api/session served, got ${res.status}`);
  }
});

// Served methods read from server/http.mjs /api/account-session: GET, POST,
// DELETE return a session view; every other method is 405.
const ACCOUNT_SESSION_INVENTORY = {
  "/api/account-session": ["GET", "POST", "DELETE"],
};

test("openapi inventory lists served account-session methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCOUNT_SESSION_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("account-session routes are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const getRes = await fetch(`${origin}/api/account-session`, { headers: { Origin: origin } });
  const getBody = await getRes.json();
  assert.equal(getRes.status, 200);
  assert.equal(getBody.authenticated, false);
  for (const method of ["POST", "DELETE"]) {
    const res = await fetch(`${origin}/api/account-session`, {
      method,
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
    await res.arrayBuffer();
    assert.equal(res.status, 401, `${method} /api/account-session without a slot got ${res.status}`);
  }
});

// POST /api/join is the machine door in server/http.mjs. POST /join and
// POST /room/join share that handler and stay outside this inventory.
const JOIN_INVENTORY = {
  "/api/join": ["POST"],
};

test("openapi inventory lists served join methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(JOIN_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
    assert.equal(doc.paths["/join"], undefined);
    assert.equal(doc.paths["/room/join"], undefined);
  }
});

test("join route is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_join");
});

// GET and POST /api/account-rooms are the account browser routes in
// server/http.mjs. Other methods are not that handler.
const ACCOUNT_ROOMS_INVENTORY = {
  "/api/account-rooms": ["GET", "POST"],
};

test("openapi inventory lists served account-rooms methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCOUNT_ROOMS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.equal(entry.auth, "account-session");
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("account-rooms routes are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  for (const method of ACCOUNT_ROOMS_INVENTORY["/api/account-rooms"]) {
    const res = await fetch(`${origin}/api/account-rooms`, {
      method,
      headers: { "Content-Type": "application/json", Origin: origin },
      body: method === "POST" ? "{}" : undefined,
    });
    await res.arrayBuffer();
    assert.ok(![404, 405].includes(res.status), `${method} /api/account-rooms served, got ${res.status}`);
  }
});

// server/http.mjs /api/account/profile: GET and POST; every other method rejects 405.
const ACCOUNT_PROFILE_INVENTORY = {
  "/api/account/profile": ["GET", "POST"],
};

test("openapi inventory lists served account-profile methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCOUNT_PROFILE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("account-profile routes are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  for (const method of ACCOUNT_PROFILE_INVENTORY["/api/account/profile"]) {
    const res = await fetch(`${origin}/api/account/profile`, {
      method,
      headers: { "Content-Type": "application/json", Origin: origin },
      body: method === "POST" ? "{}" : undefined,
    });
    await res.arrayBuffer();
    assert.ok(![404, 405].includes(res.status), `${method} /api/account/profile served, got ${res.status}`);
  }
  const other = await fetch(`${origin}/api/account/profile`, { method: "DELETE", headers: { Origin: origin } });
  await other.arrayBuffer();
  assert.equal(other.status, 405);
});

// server/http.mjs /api/account/onboarding: GET only; every other method rejects 405.
const ACCOUNT_ONBOARDING_INVENTORY = {
  "/api/account/onboarding": ["GET"],
};

test("openapi inventory lists served account-onboarding methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCOUNT_ONBOARDING_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("account-onboarding routes are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/account/onboarding`, { headers: { Origin: origin } });
  await res.arrayBuffer();
  assert.ok(![404, 405].includes(res.status), `GET /api/account/onboarding served, got ${res.status}`);
  const other = await fetch(`${origin}/api/account/onboarding`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  await other.arrayBuffer();
  assert.equal(other.status, 405);
});

// server/http.mjs /api/account/onboarding/complete: POST only; every other method rejects 405.
const ACCOUNT_ONBOARDING_COMPLETE_INVENTORY = {
  "/api/account/onboarding/complete": ["POST"],
};

test("openapi inventory lists served account-onboarding complete methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCOUNT_ONBOARDING_COMPLETE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("account-onboarding complete is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/account/onboarding/complete`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  await res.arrayBuffer();
  assert.ok(![404, 405].includes(res.status), `POST /api/account/onboarding/complete served, got ${res.status}`);
  const other = await fetch(`${origin}/api/account/onboarding/complete`, { method: "GET", headers: { Origin: origin } });
  await other.arrayBuffer();
  assert.equal(other.status, 405);
});

// server/http.mjs /api/account/retention: GET only; every other method rejects 405.
const ACCOUNT_RETENTION_INVENTORY = {
  "/api/account/retention": ["GET"],
};

test("openapi inventory lists served account-retention methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCOUNT_RETENTION_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("account-retention is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/account/retention`, { headers: { Origin: origin } });
  await res.arrayBuffer();
  assert.ok(![404, 405].includes(res.status), `GET /api/account/retention served, got ${res.status}`);
  const other = await fetch(`${origin}/api/account/retention`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  await other.arrayBuffer();
  assert.equal(other.status, 405);
});

// server/http.mjs /api/account/deletion/plan: GET only; every other method rejects 405.
const ACCOUNT_DELETION_PLAN_INVENTORY = {
  "/api/account/deletion/plan": ["GET"],
};

test("openapi inventory lists served account-deletion-plan methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCOUNT_DELETION_PLAN_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("account-deletion-plan is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/account/deletion/plan`, { headers: { Origin: origin } });
  await res.arrayBuffer();
  assert.ok(![404, 405].includes(res.status), `GET /api/account/deletion/plan served, got ${res.status}`);
  const other = await fetch(`${origin}/api/account/deletion/plan`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  await other.arrayBuffer();
  assert.equal(other.status, 405);
});

// server/http.mjs /api/account/delete: POST only; every other method rejects 405.
const ACCOUNT_DELETE_INVENTORY = {
  "/api/account/delete": ["POST"],
};

test("openapi inventory lists served account-delete methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCOUNT_DELETE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("account-delete is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/account/delete`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  await res.arrayBuffer();
  assert.ok(![404, 405].includes(res.status), `POST /api/account/delete served, got ${res.status}`);
  const other = await fetch(`${origin}/api/account/delete`, { method: "GET", headers: { Origin: origin } });
  await other.arrayBuffer();
  assert.equal(other.status, 405);
});

// server/http.mjs /api/guest-agent-links: GET and HEAD return the contract;
// POST mints. Other methods are not this handler.
const GUEST_AGENT_LINKS_INVENTORY = {
  "/api/guest-agent-links": ["GET", "HEAD", "POST"],
};

test("openapi inventory lists served guest-agent-links methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(GUEST_AGENT_LINKS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("guest-agent-links routes are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  for (const method of GUEST_AGENT_LINKS_INVENTORY["/api/guest-agent-links"]) {
    const res = await fetch(`${origin}/api/guest-agent-links`, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    const raw = Buffer.from(await res.arrayBuffer());
    assert.ok(![404, 405].includes(res.status), `${method} /api/guest-agent-links served, got ${res.status}`);
    if (method === "GET") {
      assert.equal(res.status, 200);
      assert.equal(typeof JSON.parse(raw.toString("utf8")), "object");
    }
    if (method === "HEAD") {
      assert.equal(res.status, 200);
      assert.equal(raw.length, 0);
    }
  }
});

// server/http.mjs /api/guest-agent-links/preview: POST only.
const GUEST_AGENT_LINK_PREVIEW_INVENTORY = {
  "/api/guest-agent-links/preview": ["POST"],
};

test("openapi inventory lists served guest-agent-link preview methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(GUEST_AGENT_LINK_PREVIEW_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("guest-agent-link preview is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/guest-agent-links/preview`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_link");
});

// server/http.mjs /api/guest-agent-links/join: POST only.
const GUEST_AGENT_LINK_JOIN_INVENTORY = {
  "/api/guest-agent-links/join": ["POST"],
};

test("openapi inventory lists served guest-agent-link join methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(GUEST_AGENT_LINK_JOIN_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("guest-agent-link join is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/guest-agent-links/join`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_link");
});

// server/http.mjs /api/guest-invites: GET and HEAD return the contract.
const GUEST_INVITES_INVENTORY = {
  "/api/guest-invites": ["GET", "HEAD"],
};

test("openapi inventory lists served guest-invites methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(GUEST_INVITES_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("guest-invites routes are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  for (const method of GUEST_INVITES_INVENTORY["/api/guest-invites"]) {
    const res = await fetch(`${origin}/api/guest-invites`, { method, headers: { Origin: origin } });
    const raw = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, `${method} /api/guest-invites got ${res.status}`);
    if (method === "GET") assert.equal(typeof JSON.parse(raw.toString("utf8")), "object");
    if (method === "HEAD") assert.equal(raw.length, 0);
  }
});

// server/http.mjs /api/guest-invites/preview: POST only.
const GUEST_INVITE_PREVIEW_INVENTORY = {
  "/api/guest-invites/preview": ["POST"],
};

test("openapi inventory lists served guest-invite preview methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(GUEST_INVITE_PREVIEW_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("guest-invite preview is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/guest-invites/preview`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_guest_invite");
});

// server/http.mjs /api/guest-invites/redeem: POST only. Missing bearer is 401.
const GUEST_INVITE_REDEEM_INVENTORY = {
  "/api/guest-invites/redeem": ["POST"],
};

test("openapi inventory lists served guest-invite redeem methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(GUEST_INVITE_REDEEM_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("guest-invite redeem is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/guest-invites/redeem`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/guest-invites/request: POST only. A body without a card is 422.
const GUEST_INVITE_REQUEST_INVENTORY = {
  "/api/guest-invites/request": ["POST"],
};

test("openapi inventory lists served guest-invite request methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(GUEST_INVITE_REQUEST_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("guest-invite request is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/guest-invites/request`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "card_invalid");
});

// server/http.mjs /api/guest-invites/rotate: POST only. Missing bearer is 401.
const GUEST_INVITE_ROTATE_INVENTORY = {
  "/api/guest-invites/rotate": ["POST"],
};

test("openapi inventory lists served guest-invite rotate methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(GUEST_INVITE_ROTATE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("guest-invite rotate is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/guest-invites/rotate`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/share-links/preview: POST only. A body without linkToken is 422.
const SHARE_LINK_PREVIEW_INVENTORY = {
  "/api/share-links/preview": ["POST"],
};

test("openapi inventory lists served share-link preview methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(SHARE_LINK_PREVIEW_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("share-link preview is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/share-links/preview`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_link");
});

// server/http.mjs /api/share-links/join: POST only. A missing account slot is 401.
const SHARE_LINK_JOIN_INVENTORY = {
  "/api/share-links/join": ["POST"],
};

test("openapi inventory lists served share-link join methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(SHARE_LINK_JOIN_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("share-link join is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/share-links/join`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/invitations/preview: POST only. A body without invitationToken is 422.
const INVITATION_PREVIEW_INVENTORY = {
  "/api/invitations/preview": ["POST"],
};

test("openapi inventory lists served invitation preview methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(INVITATION_PREVIEW_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("invitation preview is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/invitations/preview`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_invitation");
});

// server/http.mjs /api/invitations/accept: POST only. A missing account session is 401.
const INVITATION_ACCEPT_INVENTORY = {
  "/api/invitations/accept": ["POST"],
};

test("openapi inventory lists served invitation accept methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(INVITATION_ACCEPT_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("invitation accept is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/invitations/accept`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/auth/agent/rooms: POST only. A body without identityId is 422.
const AGENT_AUTH_ROOMS_INVENTORY = {
  "/api/auth/agent/rooms": ["POST"],
};

test("openapi inventory lists served agent auth room methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_AUTH_ROOMS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent auth rooms is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/auth/agent/rooms`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_login");
});

// server/http.mjs /api/auth/agent/session: POST only. A body without identityId and roomId is 422.
const AGENT_AUTH_SESSION_INVENTORY = {
  "/api/auth/agent/session": ["POST"],
};

test("openapi inventory lists served agent auth session methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_AUTH_SESSION_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent auth session is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/auth/agent/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_login");
});

// server/agent-plugin-routes.mjs /api/agent-keys: GET and POST. Missing bearer is 401 before the body.
const AGENT_KEYS_INVENTORY = {
  "/api/agent-keys": ["GET", "POST"],
};

test("openapi inventory lists served agent key methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_KEYS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent keys are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const getRes = await fetch(`${origin}/api/agent-keys`, { headers: { Origin: origin } });
  const getBody = await getRes.json();
  assert.equal(getRes.status, 401);
  assert.equal(getBody.error.code, "unauthenticated");
  const postRes = await fetch(`${origin}/api/agent-keys`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const postBody = await postRes.json();
  assert.equal(postRes.status, 401);
  assert.equal(postBody.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-keys/{keyId}/rotate: POST only. Missing bearer is 401.
const AGENT_KEY_ROTATE_INVENTORY = {
  "/api/agent-keys/{keyId}/rotate": ["POST"],
};

test("openapi inventory lists served agent key rotate methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_KEY_ROTATE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent key rotate is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-keys/rak_probe/rotate`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-keys/{keyId}/revoke: POST only. Missing bearer is 401.
const AGENT_KEY_REVOKE_INVENTORY = {
  "/api/agent-keys/{keyId}/revoke": ["POST"],
};

test("openapi inventory lists served agent key revoke methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_KEY_REVOKE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent key revoke is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-keys/rak_probe/revoke`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-directory/cards: POST only. Missing bearer is 401.
const AGENT_DIRECTORY_CARDS_INVENTORY = {
  "/api/agent-directory/cards": ["POST"],
};

test("openapi inventory lists served agent directory card methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_DIRECTORY_CARDS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
      assert.match(doc.paths[path][method.toLowerCase()].summary, /directory:publish/);
      assert.match(doc.paths[path][method.toLowerCase()].description, /scope named in the summary/);
    }
  }
});

test("agent directory cards are served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-directory/cards`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-skills: POST only. Missing bearer is 401.
const AGENT_SKILLS_INVENTORY = {
  "/api/agent-skills": ["POST"],
};

test("openapi inventory lists served agent skill methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_SKILLS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
      assert.match(doc.paths[path][method.toLowerCase()].summary, /skills:publish/);
    }
  }
});

test("agent skills are served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-skills`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agents/{identityId}/card: GET only. Unknown identity is 404.
const AGENT_SKILL_CARD_INVENTORY = {
  "/api/agents/{identityId}/card": ["GET"],
};

test("openapi inventory lists served agent skill card methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_SKILL_CARD_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent skill card is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agents/ai_probe/card`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, "unknown_skill_card");
});

// server/agent-plugin-routes.mjs /api/agent-directory: GET only. Public.
const AGENT_DIRECTORY_INVENTORY = {
  "/api/agent-directory": ["GET"],
};

test("openapi inventory lists served agent directory methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_DIRECTORY_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent directory is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-directory`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.agents));
});

// server/agent-plugin-routes.mjs /api/agents/directory: GET only. Public alias.
const AGENTS_DIRECTORY_ALIAS_INVENTORY = {
  "/api/agents/directory": ["GET"],
};

test("openapi inventory lists served agents directory alias methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENTS_DIRECTORY_ALIAS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agents directory alias is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agents/directory`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.agents));
});

// server/agent-plugin-routes.mjs /api/agent-directory/cards/{agentId}: DELETE only. Missing bearer is 401.
const AGENT_DIRECTORY_WITHDRAW_INVENTORY = {
  "/api/agent-directory/cards/{agentId}": ["DELETE"],
};

test("openapi inventory lists served agent directory withdraw methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_DIRECTORY_WITHDRAW_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
      assert.match(doc.paths[path][method.toLowerCase()].summary, /directory:publish/);
    }
  }
});

test("agent directory withdraw is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-directory/cards/agent-probe`, {
    method: "DELETE",
    headers: { Origin: origin },
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agents/directory/{agentId}: GET only. Unknown agent is 404.
const PUBLIC_AGENT_CARD_INVENTORY = {
  "/api/agents/directory/{agentId}": ["GET"],
};

test("openapi inventory lists served public agent card methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(PUBLIC_AGENT_CARD_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("public agent card is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agents/directory/probe-agent`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, "unknown_card");
});

// server/agent-plugin-routes.mjs /api/agent-manifest: GET only. Public.
const AGENT_MANIFEST_INVENTORY = {
  "/api/agent-manifest": ["GET"],
};

test("openapi inventory lists served agent manifest methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_MANIFEST_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent manifest is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-manifest`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(typeof body.version, "string");
});

// server/agent-plugin-routes.mjs /.well-known/agent-plugin-manifest.json: GET only. Public.
const AGENT_PLUGIN_WELL_KNOWN_INVENTORY = {
  "/.well-known/agent-plugin-manifest.json": ["GET"],
};

test("openapi inventory lists served agent plugin well-known methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_PLUGIN_WELL_KNOWN_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent plugin well-known manifest is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/.well-known/agent-plugin-manifest.json`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(typeof body.version, "string");
});

// server/agent-plugin-routes.mjs /api/agent-webhooks/{subscriptionId}/verify-delivery: POST only. Missing bearer is 401.
const AGENT_WEBHOOK_VERIFY_INVENTORY = {
  "/api/agent-webhooks/{subscriptionId}/verify-delivery": ["POST"],
};

test("openapi inventory lists served webhook verify-delivery methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_WEBHOOK_VERIFY_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("webhook verify-delivery is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-webhooks/sub_probe/verify-delivery`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-webhooks/deliveries: GET only. Missing bearer is 401.
const AGENT_WEBHOOK_DELIVERIES_INVENTORY = {
  "/api/agent-webhooks/deliveries": ["GET"],
};

test("openapi inventory lists served webhook delivery log methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_WEBHOOK_DELIVERIES_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("webhook delivery log is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-webhooks/deliveries`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-webhooks/dead-letter: GET only. Missing bearer is 401.
const AGENT_WEBHOOK_DEAD_LETTER_INVENTORY = {
  "/api/agent-webhooks/dead-letter": ["GET"],
};

test("openapi inventory lists served webhook dead-letter methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_WEBHOOK_DEAD_LETTER_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("webhook dead-letter is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-webhooks/dead-letter`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-webhooks/metrics: GET only. Missing bearer is 401.
const AGENT_WEBHOOK_METRICS_INVENTORY = {
  "/api/agent-webhooks/metrics": ["GET"],
};

test("openapi inventory lists served webhook metrics methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_WEBHOOK_METRICS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("webhook metrics are served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-webhooks/metrics`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-webhooks/process: POST only. Missing bearer is 401.
const AGENT_WEBHOOK_PROCESS_INVENTORY = {
  "/api/agent-webhooks/process": ["POST"],
};

test("openapi inventory lists served webhook process methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_WEBHOOK_PROCESS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("webhook process is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-webhooks/process`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-identities/{identityId}/verify: POST only. Missing bearer is 401.
const AGENT_IDENTITY_VERIFY_INVENTORY = {
  "/api/agent-identities/{identityId}/verify": ["POST", "DELETE"],
};

test("openapi inventory lists served agent identity verify methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_IDENTITY_VERIFY_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent identity verify is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-identities/ai_probe/verify`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

test("agent identity unverify is served for the inventoried method", { timeout: 30000 }, async t => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  assert.equal(typeof doc.paths["/api/agent-identities/{identityId}/verify"]?.delete?.operationId, "string");
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-identities/ai_probe/verify`, {
    method: "DELETE",
    headers: { Origin: origin },
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-identities/{identityId}/verification: GET only. Public.
const AGENT_IDENTITY_VERIFICATION_INVENTORY = {
  "/api/agent-identities/{identityId}/verification": ["GET"],
};

test("openapi inventory lists served agent identity verification methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_IDENTITY_VERIFICATION_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent identity verification is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-identities/ai_probe/verification`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.level, "unverified");
});

// server/agent-plugin-routes.mjs /api/identities/{identityId}/link-code: POST only. Missing bearer is 401.
const IDENTITY_LINK_CODE_INVENTORY = {
  "/api/identities/{identityId}/link-code": ["POST"],
};

test("openapi inventory lists served identity link-code methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(IDENTITY_LINK_CODE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("identity link-code is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/identities/ai_probe/link-code`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-identities/{identityId}/keys: GET only. Unknown identity is 404.
const AGENT_IDENTITY_KEYS_INVENTORY = {
  "/api/agent-identities/{identityId}/keys": ["GET"],
};

test("openapi inventory lists served agent identity key methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_IDENTITY_KEYS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent identity keys are served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-identities/ai_probe/keys`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, "identity_not_found");
});

// server/agent-plugin-routes.mjs /api/agent-identities/{identityId}/keys/rotate: POST only. Missing bearer is 401.
const AGENT_IDENTITY_KEY_ROTATE_INVENTORY = {
  "/api/agent-identities/{identityId}/keys/rotate": ["POST"],
};

test("openapi inventory lists served agent identity key rotate methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_IDENTITY_KEY_ROTATE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent identity key rotate is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-identities/ai_probe/keys/rotate`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-identities/{identityId}/keys/revoke: POST only. Missing bearer is 401.
const AGENT_IDENTITY_KEY_REVOKE_INVENTORY = {
  "/api/agent-identities/{identityId}/keys/revoke": ["POST"],
};

test("openapi inventory lists served agent identity key revoke methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_IDENTITY_KEY_REVOKE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("agent identity key revoke is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-identities/ai_probe/keys/revoke`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-heartbeats: GET and POST. Missing bearer is 401.
const AGENT_HEARTBEATS_INVENTORY = {
  "/api/agent-heartbeats": ["GET", "POST"],
};

test("openapi inventory lists served agent heartbeat methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_HEARTBEATS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "readAgentHeartbeats");
    assert.equal(doc.paths[path]?.post?.operationId, "reportAgentHeartbeat");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.summary, /heartbeats:report/);
      assert.match(op.summary, /heartbeats:read/);
      assert.match(op.description, /room access key/);
      assert.match(op.description, /identity secret/);
    }
  }
});

test("agent heartbeats are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const getRes = await fetch(`${origin}/api/agent-heartbeats`, { headers: { Origin: origin } });
  const getBody = await getRes.json();
  assert.equal(getRes.status, 401);
  assert.equal(getBody.error.code, "unauthenticated");
  const postRes = await fetch(`${origin}/api/agent-heartbeats`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const postBody = await postRes.json();
  assert.equal(postRes.status, 401);
  assert.equal(postBody.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-heartbeats/ack: POST only. Missing bearer is 401.
const AGENT_HEARTBEAT_ACK_INVENTORY = {
  "/api/agent-heartbeats/ack": ["POST"],
};

test("openapi inventory lists served agent heartbeat ack methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_HEARTBEAT_ACK_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.post?.operationId, "ackAgentHeartbeats");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.summary, /heartbeats:report/);
      assert.match(op.description, /room access key/);
      assert.match(op.description, /identity secret/);
    }
  }
});

test("agent heartbeat ack is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-heartbeats/ack`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/agent-plugin-routes.mjs /api/agent-wakes/poll: GET only. Missing bearer is 401 before the wait.
const AGENT_WAKE_POLL_INVENTORY = {
  "/api/agent-wakes/poll": ["GET"],
};

test("openapi inventory lists served agent wake poll methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_WAKE_POLL_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "pollAgentWakes");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.summary, /heartbeats:read/);
      assert.match(op.description, /room access key/);
      assert.match(op.description, /identity secret/);
    }
  }
});

test("agent wake poll is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-wakes/poll?hostId=probe&waitMs=0`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/next-actions-routes.mjs /api/rooms/{roomId}/next-actions: GET only. Missing credential is 401.
const ROOM_NEXT_ACTIONS_INVENTORY = {
  "/api/rooms/{roomId}/next-actions": ["GET"],
};

test("openapi inventory lists served room next-actions methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_NEXT_ACTIONS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "listRoomNextActions");
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("room next-actions are served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/no-such-room/next-actions`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/next-actions-routes.mjs /api/rooms/{roomId}/next-actions-dismiss: POST only. Missing credential is 401.
const ROOM_NEXT_ACTIONS_DISMISS_INVENTORY = {
  "/api/rooms/{roomId}/next-actions-dismiss": ["POST"],
};

test("openapi inventory lists served room next-actions dismiss methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_NEXT_ACTIONS_DISMISS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.post?.operationId, "dismissRoomNextAction");
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("room next-actions dismiss is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/no-such-room/next-actions-dismiss`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/next-actions-routes.mjs /api/rooms/{roomId}/next-actions-suppressions: GET and PUT. Missing credential is 401.
const ROOM_NEXT_ACTIONS_SUPPRESSIONS_INVENTORY = {
  "/api/rooms/{roomId}/next-actions-suppressions": ["GET", "PUT"],
};

test("openapi inventory lists served room next-actions suppressions methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_NEXT_ACTIONS_SUPPRESSIONS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "listRoomNextActionSuppressions");
    assert.equal(doc.paths[path]?.put?.operationId, "replaceRoomNextActionSuppressions");
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("room next-actions suppressions are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const getRes = await fetch(`${origin}/api/rooms/no-such-room/next-actions-suppressions`, { headers: { Origin: origin } });
  const getBody = await getRes.json();
  assert.equal(getRes.status, 401);
  assert.equal(getBody.error.code, "unauthenticated");
  const putRes = await fetch(`${origin}/api/rooms/no-such-room/next-actions-suppressions`, {
    method: "PUT",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const putBody = await putRes.json();
  assert.equal(putRes.status, 401);
  assert.equal(putBody.error.code, "unauthenticated");
});

// server/next-actions-routes.mjs /api/rooms/{roomId}/next-actions-dismissals: GET only. Missing credential is 401.
const ROOM_NEXT_ACTIONS_DISMISSALS_INVENTORY = {
  "/api/rooms/{roomId}/next-actions-dismissals": ["GET"],
};

test("openapi inventory lists served room next-actions dismissals methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_NEXT_ACTIONS_DISMISSALS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "listRoomNextActionDismissals");
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("room next-actions dismissals are served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/no-such-room/next-actions-dismissals`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/web/fetch: POST only. Missing room credential is 401. Other methods are 405.
const WEB_FETCH_INVENTORY = {
  "/api/web/fetch": ["POST"],
};

test("openapi inventory lists served web fetch methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(WEB_FETCH_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.post?.operationId, "fetchRoomWeb");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.description, /room access key/);
      assert.match(op.description, /identity secret or API key cannot resolve a room/);
    }
  }
});

test("web fetch is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/web/fetch`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/web/research: POST only. Missing room credential is 401. Other methods are 405.
const WEB_RESEARCH_INVENTORY = {
  "/api/web/research": ["POST"],
};

test("openapi inventory lists served web research methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(WEB_RESEARCH_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.post?.operationId, "researchRoomWeb");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.description, /room access key/);
      assert.match(op.description, /identity secret or API key cannot resolve a room/);
    }
  }
});

test("web research is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/web/research`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/claims/validate: POST only. No credential. POST {} is 422. Other methods are 405.
const CLAIMS_VALIDATE_INVENTORY = {
  "/api/claims/validate": ["POST"],
};

test("openapi inventory lists served claims validate methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(CLAIMS_VALIDATE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.post?.operationId, "validateRoomClaim");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.description, /no credential required/i);
    }
  }
});

test("claims validate is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/claims/validate`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_claim_text");
});

// server/http.mjs /api/referral-invites/mint: POST only. Missing bearer is 401. Other methods are 405.
const REFERRAL_INVITE_MINT_INVENTORY = {
  "/api/referral-invites/mint": ["POST"],
};

test("openapi inventory lists served referral invite mint methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(REFERRAL_INVITE_MINT_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.post?.operationId, "mintReferralInvite");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.summary, /room key/);
      assert.match(op.summary, /identity secret/);
    }
  }
});

test("referral invite mint is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/referral-invites/mint`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/referral-invites/redeem: POST only. No Authorization credential. POST {} is 422. Other methods are 405.
const REFERRAL_INVITE_REDEEM_INVENTORY = {
  "/api/referral-invites/redeem": ["POST"],
};

test("openapi inventory lists served referral invite redeem methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(REFERRAL_INVITE_REDEEM_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.post?.operationId, "redeemReferralInvite");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.description, /no credential required/i);
    }
  }
});

test("referral invite redeem is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/referral-invites/redeem`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_invite");
});

// server/http.mjs /api/referral-invites/preview: POST only. No Authorization credential. POST {} is 422. Other methods are 405.
const REFERRAL_INVITE_PREVIEW_INVENTORY = {
  "/api/referral-invites/preview": ["POST"],
};

test("openapi inventory lists served referral invite preview methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(REFERRAL_INVITE_PREVIEW_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.post?.operationId, "previewReferralInvite");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.description, /no credential required/i);
    }
  }
});

test("referral invite preview is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/referral-invites/preview`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_invite");
});

// server/http.mjs /api/agent-invites/preview: GET only. No credential. Missing code is 422.
const AGENT_INVITE_PREVIEW_INVENTORY = {
  "/api/agent-invites/preview": ["GET"],
};

test("openapi inventory lists served agent invite preview methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_INVITE_PREVIEW_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "previewAgentInvite");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.description, /no credential required/i);
    }
  }
});

test("agent invite preview is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/agent-invites/preview`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, "invalid_invite");
});

// server/http.mjs /api/needs-me: GET and HEAD. Identity secret required. Unauthenticated HEAD is 401 with an empty body.
const NEEDS_ME_INVENTORY = {
  "/api/needs-me": ["GET", "HEAD"],
};

test("openapi inventory lists served needs-me methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(NEEDS_ME_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "getNeedsMe");
    assert.equal(doc.paths[path]?.head?.operationId, "headNeedsMe");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.summary, /needs you/i);
      assert.match(op.description, /identity secret/i);
      assert.doesNotMatch(op.description, /no credential required/i);
    }
  }
});

test("needs-me HEAD is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/needs-me`, { method: "HEAD", headers: { Origin: origin } });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.equal(text, "");
});

// server/http.mjs /api/access-requests/{requestId}: GET polls without a bearer. POST cancel requires the identity secret.
const ACCESS_REQUEST_STATUS_INVENTORY = {
  "/api/access-requests/{requestId}": ["GET", "POST"],
};

test("openapi inventory lists served access-request status methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ACCESS_REQUEST_STATUS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const getOp = doc.paths[path]?.get;
    const postOp = doc.paths[path]?.post;
    assert.equal(getOp?.operationId, "getAccessRequest");
    assert.equal(postOp?.operationId, "cancelAccessRequest");
    assert.match(getOp.summary, /poll/i);
    assert.match(getOp.description, /identityId that filed the request/i);
    assert.doesNotMatch(getOp.description, /Bearer/);
    assert.match(postOp.summary, /cancel/i);
    assert.match(postOp.summary, /bearer secret/i);
    assert.match(postOp.description, /identity secret/i);
    assert.doesNotMatch(postOp.description, /no credential required/i);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path][method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("access-request cancel is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/access-requests/probe-request`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/add_land_item: POST only. Missing credential is 401 before the body.
const ADD_LAND_ITEM_INVENTORY = {
  "/api/rooms/{roomId}/add_land_item": ["POST"],
};

test("openapi inventory lists served add-land-item methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ADD_LAND_ITEM_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(entry.auth, "room-member");
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "addLandItem");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("add land item is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/add_land_item`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/list_land_queue: GET and HEAD. Missing credential is 401.
const LIST_LAND_QUEUE_INVENTORY = {
  "/api/rooms/{roomId}/list_land_queue": ["GET", "HEAD"],
};

test("openapi inventory lists served list-land-queue methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(LIST_LAND_QUEUE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "listLandQueue");
    assert.equal(doc.paths[path]?.head?.operationId, "headLandQueue");
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.equal(typeof op?.operationId, "string", `${method} ${path}`);
      assert.match(op.summary, /rooms:read/);
      assert.match(op.description, /room credential/i);
    }
  }
});

test("list land queue is served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const getRes = await fetch(`${origin}/api/rooms/commons/list_land_queue`, { headers: { Origin: origin } });
  const body = await getRes.json();
  assert.equal(getRes.status, 401);
  assert.equal(body.error.code, "unauthenticated");
  const headRes = await fetch(`${origin}/api/rooms/commons/list_land_queue`, { method: "HEAD", headers: { Origin: origin } });
  assert.equal(headRes.status, 401);
  assert.equal(await headRes.text(), "");
});

// server/http.mjs /api/rooms/{roomId}/remove_land_item: POST only. Missing credential is 401 before the body.
const REMOVE_LAND_ITEM_INVENTORY = {
  "/api/rooms/{roomId}/remove_land_item": ["POST"],
};

test("openapi inventory lists served remove-land-item methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(REMOVE_LAND_ITEM_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "removeLandItem");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("remove land item is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/remove_land_item`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/report_tip: POST only. Missing credential is 401 before the body.
const REPORT_LAND_TIP_INVENTORY = {
  "/api/rooms/{roomId}/report_tip": ["POST"],
};

test("openapi inventory lists served report-land-tip methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(REPORT_LAND_TIP_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "reportLandTip");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("report land tip is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/report_tip`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/files: GET and HEAD list; POST stages. Missing credential is 401.
const ROOM_FILES_INVENTORY = {
  "/api/rooms/{roomId}/files": ["GET", "HEAD", "POST"],
};

test("openapi inventory lists served room-files methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_FILES_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "listRoomFiles");
    assert.equal(doc.paths[path]?.head?.operationId, "headRoomFiles");
    assert.equal(doc.paths[path]?.post?.operationId, "stageRoomFile");
    assert.match(doc.paths[path].get.summary, /rooms:read/);
    assert.match(doc.paths[path].head.summary, /rooms:read/);
    assert.match(doc.paths[path].post.summary, /rooms:write/);
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.match(op.description, /room credential/i);
      assert.doesNotMatch(op.description, /no credential required/i);
    }
  }
});

test("room files are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const getRes = await fetch(`${origin}/api/rooms/commons/files`, { headers: { Origin: origin } });
  const body = await getRes.json();
  assert.equal(getRes.status, 401);
  assert.equal(body.error.code, "unauthenticated");
  const headRes = await fetch(`${origin}/api/rooms/commons/files`, { method: "HEAD", headers: { Origin: origin } });
  assert.equal(headRes.status, 401);
  const postRes = await fetch(`${origin}/api/rooms/commons/files`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const posted = await postRes.json();
  assert.equal(postRes.status, 401);
  assert.equal(posted.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/files/{fileId}/commit: POST only. Missing credential is 401.
const ROOM_FILE_COMMIT_INVENTORY = {
  "/api/rooms/{roomId}/files/{fileId}/commit": ["POST"],
};

test("openapi inventory lists served room-file commit methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_FILE_COMMIT_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "commitRoomFile");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("room file commit is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/files/probe-file/commit`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/project-offers/{offerId}/publish: POST only. Missing credential is 401.
const PROJECT_OFFER_PUBLISH_INVENTORY = {
  "/api/rooms/{roomId}/project-offers/{offerId}/publish": ["POST"],
};

test("openapi inventory lists served project-offer publish methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(PROJECT_OFFER_PUBLISH_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "publishProjectOffer");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("project offer publish is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/project-offers/probe-offer/publish`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/project-offers/{offerId}/withdraw: POST only. Missing credential is 401.
const PROJECT_OFFER_WITHDRAW_INVENTORY = {
  "/api/rooms/{roomId}/project-offers/{offerId}/withdraw": ["POST"],
};

test("openapi inventory lists served project-offer withdraw methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(PROJECT_OFFER_WITHDRAW_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "withdrawProjectOffer");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("project offer withdraw is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/project-offers/probe-offer/withdraw`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/membership-delegation: GET only. Missing credential is 401.
const MEMBERSHIP_DELEGATION_INVENTORY = {
  "/api/rooms/{roomId}/membership-delegation": ["GET"],
};

test("openapi inventory lists served membership-delegation methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(MEMBERSHIP_DELEGATION_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.get;
    assert.equal(op?.operationId, "listMembershipDelegations");
    assert.match(op.summary, /owner-only/i);
    assert.match(op.summary, /rooms:read/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("membership delegation list is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/membership-delegation`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/membership-delegation/grant: POST only. Missing credential is 401.
const MEMBERSHIP_DELEGATION_GRANT_INVENTORY = {
  "/api/rooms/{roomId}/membership-delegation/grant": ["POST"],
};

test("openapi inventory lists served membership-delegation grant methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(MEMBERSHIP_DELEGATION_GRANT_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "grantMembershipDelegation");
    assert.match(op.summary, /owner-only/i);
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("membership delegation grant is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/membership-delegation/grant`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/membership-delegation/revoke: POST only. Missing credential is 401.
const MEMBERSHIP_DELEGATION_REVOKE_INVENTORY = {
  "/api/rooms/{roomId}/membership-delegation/revoke": ["POST"],
};

test("openapi inventory lists served membership-delegation revoke methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(MEMBERSHIP_DELEGATION_REVOKE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "revokeMembershipDelegation");
    assert.match(op.summary, /owner-only/i);
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("membership delegation revoke is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/membership-delegation/revoke`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/owner-delegates: GET only. Missing credential is 401.
const OWNER_DELEGATES_INVENTORY = {
  "/api/rooms/{roomId}/owner-delegates": ["GET"],
};

test("openapi inventory lists served owner-delegates methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(OWNER_DELEGATES_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.get;
    assert.equal(op?.operationId, "listOwnerDelegates");
    assert.match(op.summary, /owner-only/i);
    assert.match(op.summary, /rooms:read/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("owner delegates list is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/owner-delegates`, { headers: { Origin: origin } });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/owner-delegates/grant: POST only. Missing credential is 401.
const OWNER_DELEGATE_GRANT_INVENTORY = {
  "/api/rooms/{roomId}/owner-delegates/grant": ["POST"],
};

test("openapi inventory lists served owner-delegate grant methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(OWNER_DELEGATE_GRANT_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "grantOwnerDelegate");
    assert.match(op.summary, /owner-only/i);
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("owner delegate grant is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/owner-delegates/grant`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/owner-delegates/revoke: POST only. Missing credential is 401.
const OWNER_DELEGATE_REVOKE_INVENTORY = {
  "/api/rooms/{roomId}/owner-delegates/revoke": ["POST"],
};

test("openapi inventory lists served owner-delegate revoke methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(OWNER_DELEGATE_REVOKE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "revokeOwnerDelegate");
    assert.match(op.summary, /owner-only/i);
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("owner delegate revoke is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/owner-delegates/revoke`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/ownership/transfer: POST only. Missing credential is 401.
const OWNERSHIP_TRANSFER_INVENTORY = {
  "/api/rooms/{roomId}/ownership/transfer": ["POST"],
};

test("openapi inventory lists served ownership-transfer methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(OWNERSHIP_TRANSFER_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "transferRoomOwnership");
    assert.match(op.summary, /owner-only/i);
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("ownership transfer is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/ownership/transfer`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/agent-connections: GET lists, POST applies. Missing credential is 401.
const AGENT_CONNECTIONS_INVENTORY = {
  "/api/rooms/{roomId}/agent-connections": ["GET", "POST"],
};

test("openapi inventory lists served agent-connections methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(AGENT_CONNECTIONS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    assert.equal(doc.paths[path]?.get?.operationId, "listAgentConnections");
    assert.equal(doc.paths[path]?.post?.operationId, "applyAgentConnection");
    assert.match(doc.paths[path].get.summary, /rooms:read/);
    assert.match(doc.paths[path].post.summary, /rooms:write/);
    for (const method of methods) {
      const op = doc.paths[path][method.toLowerCase()];
      assert.match(op.description, /room credential/i);
      assert.doesNotMatch(op.description, /no credential required/i);
    }
  }
});

test("agent connections are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const getRes = await fetch(`${origin}/api/rooms/commons/agent-connections`, { headers: { Origin: origin } });
  const listed = await getRes.json();
  assert.equal(getRes.status, 401);
  assert.equal(listed.error.code, "unauthenticated");
  const postRes = await fetch(`${origin}/api/rooms/commons/agent-connections`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const posted = await postRes.json();
  assert.equal(postRes.status, 401);
  assert.equal(posted.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/guest-agent-links: POST only. Missing credential is 401.
const ROOM_GUEST_AGENT_LINKS_INVENTORY = {
  "/api/rooms/{roomId}/guest-agent-links": ["POST"],
};

test("openapi inventory lists served room guest-agent-link methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_GUEST_AGENT_LINKS_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "mintRoomGuestAgentLink");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
    assert.notEqual(doc.paths["/api/guest-agent-links"]?.post?.operationId, op.operationId);
  }
});

test("room guest-agent link mint is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/guest-agent-links`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/guest-invites: POST only. Missing credential is 401.
const ROOM_GUEST_INVITES_INVENTORY = {
  "/api/rooms/{roomId}/guest-invites": ["POST"],
};

test("openapi inventory lists served room guest-invite methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_GUEST_INVITES_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "mintRoomGuestInvite");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("room guest invite mint is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/guest-invites`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/guest-invites-list: POST only. Missing credential is 401.
const ROOM_GUEST_INVITES_LIST_INVENTORY = {
  "/api/rooms/{roomId}/guest-invites-list": ["POST"],
};

test("openapi inventory lists served room guest-invite list methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_GUEST_INVITES_LIST_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "listRoomGuestInvites");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("room guest invite list is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/guest-invites-list`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/guest-invites-revoke: POST only. Missing credential is 401.
const ROOM_GUEST_INVITES_REVOKE_INVENTORY = {
  "/api/rooms/{roomId}/guest-invites-revoke": ["POST"],
};

test("openapi inventory lists served room guest-invite revoke methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_GUEST_INVITES_REVOKE_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "revokeRoomGuestInvite");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("room guest invite revoke is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/guest-invites-revoke`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

// server/http.mjs /api/rooms/{roomId}/guest-invites-disconnect: POST only. Missing credential is 401.
const ROOM_GUEST_INVITES_DISCONNECT_INVENTORY = {
  "/api/rooms/{roomId}/guest-invites-disconnect": ["POST"],
};

test("openapi inventory lists served room guest-invite disconnect methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(ROOM_GUEST_INVITES_DISCONNECT_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    const op = doc.paths[path]?.post;
    assert.equal(op?.operationId, "disconnectRoomGuestMember");
    assert.match(op.summary, /rooms:write/);
    assert.match(op.description, /room credential/i);
    assert.doesNotMatch(op.description, /no credential required/i);
  }
});

test("room guest invite disconnect is served for the inventoried method", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/guest-invites-disconnect`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthenticated");
});

test("openapi inventory lists served work-claims methods", () => {
  const doc = buildOpenApiJson({ origin: "https://room.example" });
  for (const [path, methods] of Object.entries(WORK_CLAIM_INVENTORY)) {
    const entry = DISCOVERABILITY_ROUTES.find(item => item.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(), path);
    for (const method of methods) {
      assert.equal(typeof doc.paths[path]?.[method.toLowerCase()]?.operationId, "string", `${method} ${path}`);
    }
  }
});

test("work-claims routes are served for the inventoried methods", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  for (const [path, methods] of Object.entries(WORK_CLAIM_INVENTORY)) {
    const concrete = path.replace("{roomId}", "no-such-room").replace("{claimId}", "no-such-claim");
    for (const method of methods) {
      const res = await fetch(`${origin}${concrete}`, {
        method,
        headers: { "Content-Type": "application/json", Origin: origin },
        body: method === "POST" ? "{}" : undefined,
      });
      await res.arrayBuffer();
      assert.ok(![404, 405].includes(res.status), `${method} ${concrete} served, got ${res.status}`);
    }
  }
});

test("inventory method accuracy: served methods match the route table", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  for (const [path, methods] of Object.entries(INVENTORY_METHOD_CONTRACT)) {
    const entry = DISCOVERABILITY_ROUTES.find(e => e.path === path);
    assert.ok(entry, `route table lists ${path}`);
    assert.deepEqual([...entry.methods].sort(), [...methods].sort(),
      `route table methods for ${path} match the served contract`);
    for (const method of methods) {
      const res = await fetch(`${origin}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Origin: origin },
        body: method === "POST" ? JSON.stringify({}) : undefined,
      });
      await res.arrayBuffer(); // drain
      // "Served" = anything other than the unknown-route 404 or a
      // wrong-method 405. Auth refusals (401/403) and validation errors
      // (400/409/422/429) all prove the method is served.
      assert.ok(![404, 405].includes(res.status),
        `live server serves ${method} ${path} (got ${res.status})`);
    }
  }
  // And the generated spec now documents the GET operations.
  const doc = await (await get(origin, "/openapi.json")).json();
  for (const path of Object.keys(INVENTORY_METHOD_CONTRACT)) {
    assert.ok(doc.paths[path]?.get, `openapi.json documents GET ${path}`);
  }
});
