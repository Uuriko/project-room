// W4-13 B6: invite-only operating checklist, executable part.
// Pins the unauthenticated HTTP surface. The inventory is derived, not
// hand-kept (security review 2026-09-14, L3 / B48): docs/openapi.yaml marks
// every open operation `security: []`; this test probes every /api route
// server/http.mjs can match without a credential and fails when the served
// set differs from the declared set. Every declared route also needs a
// shape-valid probe below stating what an anonymous caller gets, and
// scripts/open-routes.mjs --check requires both docs tables to name it.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { openRoutes, routeCandidates, routeKey } from "../scripts/open-routes.mjs";
import { pluginRouteTemplates } from "../scripts/route-docs-check.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const DECLARED_OPEN = openRoutes(read("../docs/openapi.yaml"));
const SERVED_CANDIDATES = [
  ...routeCandidates(read("../server/http.mjs")),
  // The agent plug-in surface is mounted through a single delegation in
  // server/http.mjs; its templates are extracted from
  // server/agent-plugin-routes.mjs (same extraction as route-docs-check.mjs).
  ...pluginRouteTemplates(read("../server/agent-plugin-routes.mjs")),
];
assert.ok(DECLARED_OPEN.length >= 10, "openapi open-route parse sanity");
assert.ok(SERVED_CANDIDATES.length >= 60 && SERVED_CANDIDATES.includes("/api/health") && SERVED_CANDIDATES.includes("/api/rooms/{id}/commands"),
  "server route extraction sanity");

// What an anonymous caller with a shape-valid body gets from each open route.
// Keyed like routeKey(): parameters reduced to {}.
const token = () => randomBytes(32).toString("base64url");
const PROBES = {
  "GET /api/auth/gmail/callback": [undefined, 200],
  "GET /api/health": [undefined, 200],
  // Hosted MCP is outside the /api template scan. Unauthenticated GET/POST
  // stay the public join surface (200). The bearer profile is covered by
  // tests/room-mcp-auth.test.js.
  "GET /mcp": [undefined, 200],
  "POST /mcp": [{}, 200],
  "GET /api/version": [undefined, 200],
  "GET /api/ready": [undefined, 200],
  // Agent directory reads: public documents without a credential; an
  // unknown card id reads as 404 unknown_card (never an oracle).
  "GET /api/agent-directory": [undefined, 200],
  "GET /api/agents/directory": [undefined, 200],
  "GET /api/agents/directory/{}": [undefined, 404],
  // Skill card (RC-2026-09-24-202): public document without a credential;
  // an identity that never published a card reads as 404 (never an oracle).
  "GET /api/agents/{}/card": [undefined, 404],
  // Plug-in manifest: public discovery document, no room data.
  "GET /api/agent-manifest": [undefined, 200],
  "GET /api/guest-agent-links": [undefined, 200],
  "GET /api/guest-invites": [undefined, 200],
  // GX guest-invite preview: public-safe; unknown code is 410 (not an oracle).
  "POST /api/guest-invites/preview": [{ inviteCode: "GX-00000000000000000000000000000000" }, 410],
  // Self-serve guest entry (RC-2026-09-25-912): open by design; the signed
  // agent card in the body is the entire credential. A body without a card
  // is 422 card_invalid (never an oracle about rooms or keys).
  "POST /api/guest-invites/request": [{}, 422],
  // Agent public-key registry (integration map slice 9): public key rows are
  // public; an unknown identity id is a bare 404 without revealing anything.
  "GET /api/agent-identities/{}/keys": [undefined, 404],
  // Anonymous browser slot: authenticated:false and a CSRF token, nothing else.
  "GET /api/account-session": [undefined, 200],
  "POST /api/agent-identities": [{ displayName: "Boundary probe" }, 201],
  "POST /api/identity-create": [{ displayName: "Boundary probe" }, 201],
  // One-URL machine door: shape-valid body mints an identity + personal
  // first room (also served at POST /join and POST /room/join, outside the
  // /api/ inventory by design like the discovery packets).
  "POST /api/join": [{ displayName: "Boundary probe" }, 201],
  // Public read-only face: unknown codes 404 as face_not_found (never plain
  // not_found), so the sweep above counts these as served-open.
  "GET /api/public/rooms/{}": [undefined, 404],
  "GET /api/public/rooms/{}/feed": [undefined, 404],
  // Opt-in room directory (#605): public by design so a freshly minted
  // identity can discover rooms; an empty directory answers 200 with no rooms.
  "GET /api/public/rooms/directory": [undefined, 200],
  // Public run-receipts aggregate: measured work from the receipt board,
  // public by design; answers 200 with the checked-in snapshot.
  "GET /api/public/receipts": [undefined, 200],
  // Public opportunity feed (v2): read-only open-work discovery across
  // owner opt-in directory-listed rooms, decoupled from admission; an
  // empty directory answers 200 with no opportunities.
  "GET /api/opportunities.json": [undefined, 200],
  // Self-serve access request: shape-valid body, unknown identity -> 404 without revealing anything.
  // "read" is not a room permission and never was; a later vocabulary check
  // started refusing it with 422, so this probe stopped reaching the thing it
  // is here to prove - that an unknown identity gets a bare 404 that says
  // nothing about whether the identity or the room exists.
  "POST /api/access-requests": [{ roomId: "commons", identityId: "no-such-identity", displayName: "Boundary probe", requestedPermissions: ["steer"], note: "probe", requestId: "probe-request-1" }, 404],
  // Verification tier: a public read by design, so an agent can gate on another
  // agent's tier before working with it. An unknown id is not a 404 - it answers
  // 200 with level "unverified", which is the same answer a real-but-unattested
  // identity gets, so the route tells a prober nothing about who exists.
  "GET /api/agent-identities/{}/verification": [undefined, 200],
  // Access-request status: identityId query param is required, so a bare probe gets 422.
  "GET /api/access-requests/{}": [undefined, 422],
  "POST /api/agent-invites/redeem": [{ code: "RM-AAAAAAAA", displayName: "Boundary probe" }, 404],
  // Invite preview: shape-valid code probe gets 404 invite_unavailable; a bare
  // probe (no code query param) gets 422 invalid_invite.
  "GET /api/agent-invites/preview": [undefined, 422],
  // Referral invite preview/redeem: a forged token is indistinguishable from
  // an unknown one — 404 invite_unavailable, never an oracle.
  "POST /api/referral-invites/preview": [{ token: "ref1.probe.probe" }, 404],
  "POST /api/referral-invites/redeem": [{ token: "ref1.probe.probe" }, 404],
  "POST /api/share-links/preview": [{ linkToken: token() }, 410],
  "POST /api/invitations/preview": [{ invitationToken: token() }, 404],
  "POST /api/guest-agent-links/preview": [{ linkToken: `gt_${token()}` }, 410],
  "POST /api/guest-agent-links/join": [{ linkToken: `gt_${token()}` }, 410],
  "POST /api/session": [{ accessKey: token() }, 401],
  // Provider webhook: per-connection secret header is the credential; 409 until a webhook inbox is wired.
  "POST /api/inbox/webhooks/{}": [{ update_id: 1 }, 409],
  // Recovery-code redeem: unknown email and wrong code share the 401 shape (slice 6).
  "POST /api/auth/recovery-codes/redeem": [{ email: "probe@example.com", code: "nope", sessionToken: token(), sessionRevision: 0 }, 401],
  // Passkey authentication (slice 5): the anonymous ceremony step issues a challenge...
  "POST /api/auth/passkey/authenticate/options": [{}, 200],
  // ...and the finish step rejects an unknown challenge id with the same 401 shape as a failed assertion.
  "POST /api/auth/passkey/authenticate/finish": [{ challengeId: "nope", response: {}, sessionToken: token(), sessionRevision: 0 }, 401],
  // Password signup (slice 2): a policy-failing password answers 422 before anything is created.
  "POST /api/auth/password/signup": [{ email: "probe@example.com", password: "short", sessionToken: token(), sessionRevision: 0 }, 422],
  // Password login (slice 2): unknown email and wrong password share the 401 shape.
  "POST /api/auth/password/login": [{ email: "probe@example.com", password: "long-enough-password", sessionToken: token(), sessionRevision: 0 }, 401],
  // Agent browser sign-in (PR #829): the identity secret rides the
  // Authorization header; without one the routes answer 401.
  "POST /api/auth/agent/rooms": [{ identityId: "ag1_probe" }, 401],
  "POST /api/auth/agent/session": [{ identityId: "ag1_probe", roomId: "commons" }, 401],
  // Claim-block pre-validation (RC-2026-09-24-204): open by design; a valid
  // block answers 200 with valid:true, and the probe body below is valid.
  "POST /api/claims/validate": [{ text: "```room-claim\ntask-id: RC-2026-09-24-204\nlane: probe\nfiles: a.mjs\nlease: lease=6h\nstate: working\nreason: probe\n```" }, 200],
};

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-boundary-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function raw(origin, path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method, headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null), text: null };
}

// A refusal for lack of a credential (401, or the account routes' 422
// session_binding_required for a header-only probe) means guarded; 404
// not_found / 405 means the method is not served there. Anything else was
// served to an anonymous caller, input validation included.
const code = res => res.json?.error?.code;
const guarded = res => res.status === 401 || (res.status === 422 && code(res) === "session_binding_required");
const unserved = res => (res.status === 404 && code(res) === "not_found") || res.status === 405;
const concrete = template => template.replace(/^\/api\/rooms\/\{[^}]*\}/, "/api/rooms/commons").replace(/\{[^}]*\}/g, "telegram-fixture");

test("unauthenticated endpoint inventory equals the openapi security: [] set", async t => {
  const { origin } = await serve(t);
  const declared = new Map(DECLARED_OPEN.map(route => [routeKey(route.method, route.path), route]));
  const served = new Map();
  for (const template of SERVED_CANDIDATES) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await raw(origin, concrete(template), { method, body: method === "GET" ? undefined : {} });
      if (guarded(res) || unserved(res)) continue;
      served.set(routeKey(method, template), `${method} ${template} -> ${res.status} ${code(res) ?? ""}`.trim());
    }
  }
  assert.deepEqual([...served.keys()].filter(key => !declared.has(key)).map(key => served.get(key)), [],
    "served without a credential but not declared security: [] in docs/openapi.yaml; declare it there and in docs/ROUTE-AUTH-TABLE.md + docs/INVITE-ONLY-CHECKLIST.md section 1, or guard it");
  assert.deepEqual([...declared.keys()].filter(key => / \/api\//.test(key) && !served.has(key)), [],
    "declared security: [] in docs/openapi.yaml but refused or not served anonymously");
  // Every declared route states what an anonymous caller gets; no stale probes.
  assert.deepEqual(Object.keys(PROBES).filter(key => !declared.has(key)), [], "probe for a route that is not open in docs/openapi.yaml");
  for (const [key, route] of declared) {
    assert.ok(PROBES[key], `no anonymous probe for open route ${key}; add one to PROBES`);
    const [body, expected] = PROBES[key];
    const res = await raw(origin, concrete(route.path), { method: route.method, body });
    assert.equal(res.status, expected, `${key} -> ${res.status}, expected ${expected}: ${JSON.stringify(res.json)}`);
  }
  const slot = await raw(origin, "/api/account-session");
  assert.equal(slot.json.authenticated, false); assert.equal(slot.json.account, null);
  // Everything room-scoped requires a credential (shape-valid bodies reach the
  // auth check; malformed ones may fail input validation first, which leaks nothing).
  const guardedRoutes = [
    ["GET", "/api/rooms/commons/commands"],
    ["GET", "/api/rooms/commons/events"],
    ["GET", "/api/rooms/commons/export"],
    ["GET", "/api/rooms/commons/agent-invites"],
    ["GET", "/api/rooms/commons/referral-invites"],
    ["POST", "/api/rooms/commons/agent-invites", { permissions: ["steer"] }],
    ["DELETE", "/api/rooms/commons/agent-invites", { inviteId: "0".repeat(8) }],
  ];
  for (const [method, path, body] of guardedRoutes) {
    const res = await raw(origin, path, { method, body });
    assert.equal(res.status, 401, `${method} ${path} must require authentication, got ${res.status}`);
  }
  // /api/inbox and /api/account-rooms are account-session scoped: without a
  // session cookie they refuse (401 in a real browser session, 422
  // session_binding_required for this header-only probe which carries no
  // session binding). Either way, no data.
  for (const path of ["/api/inbox", "/api/account-rooms"]) {
    const res = await raw(origin, path);
    assert.ok([401, 422].includes(res.status), `GET ${path} must refuse without a session, got ${res.status}`);
    assert.ok(!JSON.stringify(res.json).includes("@"), `${path} refusal must not leak account data`);
  }
  // The owner-authenticated Telegram import trigger is account-session + CSRF scoped, never open.
  const trigger = await raw(origin, "/api/inbox/connections/telegram-fixture/reconnect", { method: "POST", body: { requestId: "boundary-probe" } });
  assert.ok([401, 422].includes(trigger.status), `POST import trigger must refuse without a session, got ${trigger.status}`);
  // Connection commands and channel sends are the owner's session-scoped writes too.
  const commands = await raw(origin, "/api/inbox/connections/commands", { method: "POST", body: { action: "connection.disconnect", requestId: "boundary-probe", connectionId: "telegram-fixture", expectedRevision: 0 } });
  assert.ok([401, 422].includes(commands.status), `POST connection commands must refuse without a session, got ${commands.status}`);
  const sends = await raw(origin, "/api/inbox/channel-sends", { method: "POST", body: { action: "dispatch", sourceId: "x", sendId: "y" } });
  assert.ok([401, 422].includes(sends.status), `POST channel sends must refuse without a session, got ${sends.status}`);
});

test("capability previews never leak room content", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const secretBody = `boundary-secret-${randomUUID()}`;
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: secretBody } });
  const linkToken = randomBytes(32).toString("base64url");
  const created = store.shareLinks.create(ownerKey, "commons", {
    requestId: randomUUID(), linkToken, expiresAt: store.now() + 3600000, maxJoins: 5, expectedMemberRevision: 0,
  }, undefined);
  assert.equal(created.duplicate, false);
  const preview = await raw(origin, "/api/share-links/preview", { method: "POST", body: { linkToken } });
  assert.equal(preview.status, 200);
  const serialized = JSON.stringify(preview.json);
  assert.ok(!serialized.includes(secretBody), "preview must not contain message bodies");
  assert.ok(!serialized.includes(ownerKey), "preview must not contain credentials");
  assert.deepEqual(Object.keys(preview.json).sort(), ["access", "identity", "link", "room"]);
  assert.deepEqual(Object.keys(preview.json.room).sort(), ["id", "title"]);
});

test("indexing is denied by default; operation ids tag every api response", async t => {
  const { origin } = await serve(t);
  const health = await raw(origin, "/api/health");
  assert.equal(health.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(health.headers.get("x-operation-id") ?? "", /^op_/);
  assert.equal(health.headers.get("cache-control"), "no-store");
  // Deliberately public discovery packets are the only indexable surface.
  const packet = await raw(origin, "/llms.txt");
  assert.equal(packet.status, 200);
  assert.equal(packet.headers.get("x-robots-tag"), "all");
});
