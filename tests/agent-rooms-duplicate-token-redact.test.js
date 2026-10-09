import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  AgentRooms,
  agentRoomSchema,
  ensureAgentRoomRequestIdColumn,
  ensureAgentRoomOnboardingKeyColumn,
  REDACTED_CREDENTIAL
} from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

// FIX-3: room-create responses leaked room-scoped MCP token material on
// idempotent replays. The codebase convention is "shown once at issue,
// redacted everywhere after" (guest-invites self-serve: the Bearer
// <redacted> is returned once, in the original response; replays redact).
// The original create still shows the onboarding credential once, to the
// authenticated creating identity, who must persist it — exactly like the
// scoped-keys surface ("the secret shown once at issue/rotate"). Every
// replay (client roomId or requestId) must answer with a redacted handle
// of the ORIGINAL issuance and must not mint a fresh key.

function setup(t, { capacity = 1000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-fix3-redact-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureAgentRoomRequestIdColumn(store.db);
  ensureAgentRoomOnboardingKeyColumn(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity, refillPerSecond: capacity })
  });
  const identity = store.identities.create("Fix3 Owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, identity };
}

const createArgs = (overrides = {}) => ({
  title: "Fix3 Den", purpose: "No token material on replays.",
  kind: "personal", displayName: "Fix3 Keeper", ...overrides
});

const keyIdsFor = (store, identityId) =>
  [...store.agentPlugin.keys.values()].filter(row => row.identityId === identityId).map(row => row.keyId);

test("the original room-create shows the onboarding credential once", t => {
  const { rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ roomId: "fix3-once" }));
  assert.equal(first.duplicate, false);
  assert.match(first.mcpToken.credential, /^rak_/, "shown once to the creating identity");
  assert.ok(first.mcpToken.keyId, "the issuance has a key handle");
});

test("a roomId replay returns a redacted handle, not a fresh credential", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ roomId: "fix3-roomid" }));
  const credential = first.mcpToken.credential;
  const before = keyIdsFor(store, identity.identityId);

  const retry = rooms.create(identity.secret, createArgs({ roomId: "fix3-roomid" }));
  assert.equal(retry.duplicate, true, "the retry is recognised as the same create");
  assert.equal(retry.roomId, first.roomId);
  assert.equal(retry.mcpToken.credential, REDACTED_CREDENTIAL, "no token material in the replay");
  assert.equal(retry.mcpToken.keyId, first.mcpToken.keyId, "the handle names the original issuance");
  assert.deepEqual(keyIdsFor(store, identity.identityId), before, "no fresh key was minted on replay");
  assert.equal(JSON.stringify(retry).includes(credential), false, "the live credential appears nowhere in the replay");
});

test("a requestId replay returns a redacted handle, not a fresh credential", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ requestId: "fix3-req-1" }));
  const credential = first.mcpToken.credential;
  const before = keyIdsFor(store, identity.identityId);

  const retry = rooms.create(identity.secret, createArgs({ requestId: "fix3-req-1" }));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.roomId, first.roomId);
  assert.equal(retry.mcpToken.credential, REDACTED_CREDENTIAL);
  assert.equal(retry.mcpToken.keyId, first.mcpToken.keyId);
  assert.deepEqual(keyIdsFor(store, identity.identityId), before, "no fresh key was minted on replay");
  assert.equal(JSON.stringify(retry).includes(credential), false);
});

test("a replay after the original key was revoked still leaks nothing", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ roomId: "fix3-revoked" }));
  const credential = first.mcpToken.credential;
  store.agentPlugin.keys.get(first.mcpToken.keyId).revoked = true;

  const retry = rooms.create(identity.secret, createArgs({ roomId: "fix3-revoked" }));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.mcpToken.credential, REDACTED_CREDENTIAL);
  assert.equal(JSON.stringify(retry).includes(credential), false, "the revoked credential appears nowhere");
});
