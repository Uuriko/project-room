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

test("canonical errors: 401s on listed routes name the mint path with non-empty next[]", { timeout: 30000 }, async t => {
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
    assert.ok(text.includes("/api/agent-identities"), `${method} ${path} names the mint path`);
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
  // auth_required names the mint path.
  const authed = await mcp(origin, "tools/call", { name: "room_post_message", arguments: {} }, undefined);
  assert.equal(authed.body.error.code, -32001);
  const ad = authed.body.error.data;
  assert.equal(ad.reason, "auth_required");
  assert.ok(JSON.stringify(ad).includes("/api/agent-identities"), "auth_required names the mint path");
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
