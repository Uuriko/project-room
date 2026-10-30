import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createMcpInviteOAuth } from "../server/mcp-invite-oauth.mjs";
import { createMcpEventSubscriptions } from "../server/mcp-event-subscriptions.mjs";
import { exportNdjsonText, replayNdjson } from "../server/room-export.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { assertShardClassification, tableHome } from "../server/room-shard-tables.mjs";

const resource = "https://room.example/mcp";
const clients = [{ clientId: "native-recovery", name: "Recovery fixture", redirectUris: ["https://client.example/callback"] }];
const verifier = "v".repeat(43);
const secret = `whsec_${Buffer.alloc(32, 17).toString("base64")}`;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "native-agent-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "source.sqlite");
  const store = new RoomStore(filename); store.initialize(initialRoom());
  t.after(() => store.close());
  const native = createMcpInviteOAuth({ store, clients, resource });
  const invitation = store.invites.create(store.issueAccessKey("commons", "owner"), "commons", { profile: "member" });
  const { nonce } = native.begin(new URLSearchParams({ client_id: clients[0].clientId, redirect_uri: clients[0].redirectUris[0], resource,
    scope: "chat:read", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }));
  const code = new URL(native.approve(nonce, invitation.code, "Recovery friend")).searchParams.get("code");
  const pair = native.provider.exchangeCode({ code, clientId: clients[0].clientId, redirectUri: clients[0].redirectUris[0], codeVerifier: verifier, resource });
  return { store, directory, native, pair };
}
function events(store, sent = []) {
  return createMcpEventSubscriptions({ store, authorize: async () => true,
    dnsResolvers: { lookup: async () => [{ address: "8.8.8.8", family: 4 }] },
    transport: async (_url, _addresses, request) => {
      const body = JSON.parse(request.body);
      if (body.type !== "verification") sent.push(body);
      return { status: 200, text: async () => JSON.stringify({ challenge: body.challenge }) };
    } });
}

test("mounted native tables pass recovery and remain directory authority", async t => {
  const f = fixture(t); events(f.store);
  assert.ok(auditRecovery(f.store).checks.writerFence);
  const names = f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assertShardClassification(names);
  for (const name of names.filter(value => value.startsWith("oauth_invite_") || value.startsWith("mcp_event_"))) assert.equal(tableHome(name), "directory");
});

test("sanitized export restores lazy schemas without leaking or reviving callback secrets or revoked grants", async t => {
  const f = fixture(t), manager = events(f.store);
  const grant = f.store.db.prepare("SELECT * FROM oauth_invite_grants").get();
  const principal = { principalType: "invited-agent", familyId: "testfamily", resource, roomId: grant.room_id, identityId: grant.identity_id, memberId: grant.member_id, scopes: ["chat:read"] };
  await manager.subscribe({ principal, name: "room.requested", arguments: { roomId: grant.room_id, memberId: grant.member_id }, delivery: { mode: "webhook", url: "https://callback.example/events", secret } });
  manager.enqueueRequested({ roomId: grant.room_id, memberId: grant.member_id, eventId: "wake1", requestId: "request1" });
  f.native.provider.revoke(f.pair.refreshToken);
  const exported = exportNdjsonText(f.store.db);
  assert.ok(!exported.includes(secret));
  assert.ok(!exported.includes(f.pair.refreshToken));
  const filename = join(f.directory, "restored.sqlite");
  const replay = replayNdjson(exported, filename);
  assert.equal(replay.verified, true);
  assert.equal(replay.audit.ok, true);
  const restored = new RoomStore(filename); t.after(() => restored.close());
  const native = createMcpInviteOAuth({ store: restored, clients, resource });
  assert.equal(native.provider.verifyAccessToken(f.pair.accessToken, { resource }), null);
  assert.throws(() => native.provider.refresh({ refreshToken: f.pair.refreshToken, clientId: clients[0].clientId, resource }));
  const row = restored.db.prepare("SELECT state,document FROM mcp_event_subscriptions").get();
  assert.equal(row.state, "inactive"); assert.equal(row.document, "{}");
  const sent = []; await events(restored, sent).drain(); assert.equal(sent.length, 0);
});

for (const mode of ["buffered", "streaming"]) test(`Workers ${mode} restore prepares native lazy schemas and preserves grant revocation`, async t => {
  const { replayNdjsonInto, createBackupReplaySession } = await import("../server/restore-ndjson.mjs");
  const f = fixture(t); f.native.provider.revoke(f.pair.refreshToken);
  const grant = f.store.db.prepare("SELECT * FROM oauth_invite_grants").get();
  await events(f.store).subscribe({ principal: { principalType: "invited-agent", familyId: "family", resource, roomId: grant.room_id, identityId: grant.identity_id, memberId: grant.member_id, scopes: ["chat:read"] }, name: "room.requested", arguments: { roomId: grant.room_id, memberId: grant.member_id }, delivery: { mode: "webhook", url: "https://callback.example/events", secret } });
  const exported = exportNdjsonText(f.store.db);
  const restored = new RoomStore(join(f.directory, `${mode}.sqlite`)); t.after(() => restored.close());
  let result;
  if (mode === "buffered") result = replayNdjsonInto(exported, restored);
  else { const session = createBackupReplaySession(restored); session.writeText(exported); result = session.finish(); }
  assert.equal(result.verified, true); assert.equal(result.audit.ok, true);
  const provider = createMcpInviteOAuth({ store: restored, clients, resource }).provider;
  assert.equal(provider.verifyAccessToken(f.pair.accessToken, { resource }), null);
  assert.equal(restored.db.prepare("SELECT state FROM mcp_event_subscriptions").get().state, "inactive");
});

test("invitation-only retention works without an account OAuth provider table", async t => {
  const { pruneOAuthProvider } = await import("../server/oauth-provider-store.mjs");
  const f = fixture(t);
  assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='oauth_provider_clients'").get(), undefined);
  f.store.db.exec("UPDATE oauth_invite_pending SET expires_at=0; UPDATE oauth_invite_grants SET expires_at=0");
  assert.ok(pruneOAuthProvider(f.store.db, { now: Date.now() }).pruned >= 2);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM oauth_invite_grants").get().n, 0);
  assert.equal(f.native.provider.verifyAccessToken(f.pair.accessToken, { resource }), null);
});

test("event maintenance bounds deletion work per tick without reviving expired subscriptions", async t => {
  const f = fixture(t), manager = events(f.store);
  f.store.transaction(() => {
    const sub = f.store.db.prepare("INSERT INTO mcp_event_subscriptions VALUES(?,?,?,?,?,?)");
    for (let i = 0; i < 105; i++) sub.run(`expired${i}`, "{}", "{}", "generation", "inactive", 0);
    const job = f.store.db.prepare("INSERT INTO mcp_event_outbox(subscription_id,event_id,document,state,next_at) VALUES(?,?,?,?,?)");
    for (let i = 0; i < 205; i++) job.run("gone", `event${i}`, "{}", "dead", 0);
  });
  await manager.drain({ limit: 1 });
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM mcp_event_subscriptions").get().n, 5);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM mcp_event_outbox").get().n, 5);
  await manager.drain({ limit: 1 });
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM mcp_event_subscriptions").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM mcp_event_outbox").get().n, 0);
});
