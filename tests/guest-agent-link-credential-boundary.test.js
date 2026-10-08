import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { GUEST_AGENT_TOKEN_PREFIX } from "../server/guest-agent-links.mjs";

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), "guest-credential-test-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, owner };
};
const details = requestId => ({ requestId, expectedOwnerRevision: 0, displayName: "Visitor" });

test("server-issued guest credential is random, hashed, usable and not recoverable on tokenless replay", t => {
  const { store, owner } = fixture(t);
  const requestId = randomUUID();
  const first = store.guestAgentLinks.mint(owner, "commons", details(requestId));
  assert.match(first.token, /^ga1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(first.duplicate, false);
  assert.equal(store.authenticate(first.token, "commons").member.id, first.member.id);
  assert.equal(store.db.prepare("SELECT hash FROM credentials WHERE member_id=?").get(first.member.id).hash.length, 64);
  const replay = store.guestAgentLinks.mint(owner, "commons", details(requestId));
  assert.equal(replay.duplicate, true);
  assert.equal(Object.hasOwn(replay, "token"), false);
  assert.equal(replay.member.id, first.member.id);
  const second = store.guestAgentLinks.mint(owner, "commons", { ...details(randomUUID()), displayName: "Caller" });
  assert.notEqual(second.token, first.token);
  assert.throws(() => store.guestAgentLinks.mint(owner, "commons", { ...details(requestId), displayName: "Changed" }), { code: "idempotency_conflict" });
});

test("GA-1 (issue #941): caller-provided linkToken is rejected — the server always issues", t => {
  const { store, owner } = fixture(t);
  const requestId = randomUUID();
  // The legacy caller-picked credential shape is gone: minting with a
  // client-chosen token fails closed instead of becoming a live credential.
  assert.throws(() => store.guestAgentLinks.mint(owner, "commons", {
    ...details(requestId),
    linkToken: GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url"),
  }), { code: "client_token_rejected" });
  // And a different client-chosen token on the same requestId is the same
  // rejection, not an idempotency probe.
  assert.throws(() => store.guestAgentLinks.mint(owner, "commons", {
    ...details(requestId),
    linkToken: GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url"),
  }), { code: "client_token_rejected" });
  // The seat was never created by the rejected mints.
  assert.equal(store.guestAgentLinks.liveCount("commons"), 0);
});
