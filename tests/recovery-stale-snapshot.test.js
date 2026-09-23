// G3 follow-up: stale-before-revocation / identity-unlink. No implementation edits.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const SCOPE = "/Users/johnpotter/src/project-room-identity-scope";
assert.equal(existsSync(`${SCOPE}/server/store.mjs`), true);
const { RoomStore } = await import(`${SCOPE}/server/store.mjs`);
const { initialRoom } = await import(`${SCOPE}/server/bootstrap.mjs`);

function counts(store, roomId = "commons") {
  const q = sql => store.db.prepare(sql).get(roomId)?.n ?? store.db.prepare(sql).get()?.n;
  const tables = {
    events: store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id=?").get(roomId).n,
    commands: store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE room_id=?").get(roomId).n,
    cursors: store.db.prepare("SELECT COUNT(*) AS n FROM cursors WHERE room_id=?").get(roomId).n,
    membership_invitations: store.db.prepare("SELECT COUNT(*) AS n FROM membership_invitations WHERE room_id=?").get(roomId).n,
    credentials: store.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE room_id=?").get(roomId).n,
    identity_links: store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE room_id=?").get(roomId).n
  };
  return tables;
}

test("stale live export imported after unlink resurrects event membership without restoring identity_links", () => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const { identityId } = store.identities.create("Recovery agent");
  store.identities.link(owner, "commons", { identityId, permissions: ["steer"] });
  assert.equal(counts(store).identity_links, 1);
  const liveExport = [...store.exportEvents(owner, "commons")];
  store.identities.unlink(owner, "commons", identityId);
  assert.equal(store.room("commons").state.members[identityId].active, false);
  assert.equal(counts(store).identity_links, 0);
  store.importEvents(owner, "commons", liveExport);
  const member = store.room("commons").state.members[identityId];
  assert.equal(member.active !== false, true, "stale export resurrects member.active from events");
  assert.equal(counts(store).identity_links, 0, "identity_links are not in the event export");
  assert.equal(counts(store).commands, 0, "commands wiped on import");
  assert.equal(counts(store).cursors, 0, "cursors wiped on import");
});

test("authority tables/witnesses for maintenance restore", () => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  const required = [
    "events", "commands", "cursors", "rooms", "credentials",
    "membership_invitations", "membership_invitation_events",
    "identity_links", "agent_identities", "projection_checkpoints"
  ];
  for (const name of required) assert.ok(names.includes(name), name);
  const witnesses = {
    replay: "events.sequence + events.body must dense-replay via applyEvent",
    dropOnImport: ["commands", "cursors", "membership_invitations", "membership_invitation_events", "projection_checkpoints"],
    notInExport: ["credentials", "identity_links", "agent_identities", "account_credentials"],
    recommendation: "Restore only onto a fresh database; re-issue room keys; re-link identities; do not DELETE invitation rows in-place (append-only audit)."
  };
  assert.ok(witnesses.dropOnImport.includes("commands"));
  assert.ok(witnesses.notInExport.includes("credentials"));
  assert.match(witnesses.recommendation, /fresh database/);
});
