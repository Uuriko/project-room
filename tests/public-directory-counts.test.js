// Directory receipt counts, identity-keyed (VISIBILITY-PREDICATE PR 2).
//
// directoryCounts used to count receipts by matching display-name
// strings across agents_json and humans_json: a receipt credited to a
// different agent who happened to share the card's display name counted
// toward the card, a human sharing the name counted too, and receipts
// the owner had hidden (or the operator had unpublished) counted like
// any other — the count was the P-1 leak in ATLAS-PUBLIC §2. The count
// now reads the credited identity ids recorded at projection
// (public_receipts.agent_ids_json) and applies the one visibility
// predicate (server/public-visibility.mjs). These tests pin the new
// semantics and the re-sync triggers: flipping a room's receipts toggle
// or unpublishing must move the count with no projection event between.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { syncDirectoryCard, projectPublicWorkReceipt } from "../server/public-read-model.mjs";

const wcr = ch => `wcr_${ch.repeat(32)}`;
const OPERATOR_EMAIL = "counts-operator@example.invalid";
const OPERATOR_PASSWORD = "counts-operator-password";
const operatorAccountId = `email:${createHash("sha256").update(OPERATOR_EMAIL).digest("hex")}`;

function makeStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-dir-counts-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedIdentity(store, identityId, roomId, memberId) {
  store.db.prepare("INSERT OR IGNORE INTO agent_identities (identity_id, secret_hash, display_name, created_at) VALUES (?,?,?,0)")
    .run(identityId, `hash-${identityId}`, identityId);
  store.db.prepare("INSERT OR IGNORE INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?,?,?,0)")
    .run(roomId, identityId, memberId);
}

function seedCard(store, agentId, identityId, name) {
  store.db.prepare(`INSERT INTO agent_directory_cards
    (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn)
    VALUES (?,?, 'public', ?, 0, 0, 0)`)
    .run(agentId, JSON.stringify({ name, description: "", skills: [] }), identityId);
  syncDirectoryCard(store, agentId);
}

function seedReceipt(store, { id, origin = "commons", agents = [], humans = [], agentIds = [] }) {
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href, agent_ids_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "Counted receipt", "work-claim", origin, origin, null, JSON.stringify(agents),
      JSON.stringify(humans), null, null, null, "[]", "2026-10-01T00:00:00.000Z",
      "https://room.trydemigod.com/?start=room", JSON.stringify(agentIds));
}

const entryCount = (store, agentId) =>
  store.db.prepare("SELECT receipt_count FROM public_directory_entries WHERE agent_id=?").get(agentId)?.receipt_count;

test("the count is keyed by credited identity and gated by the visibility predicate", t => {
  const store = makeStore(t);
  seedIdentity(store, "ai_ada", "commons", "ada");
  seedCard(store, "ai_ada", "ai_ada", "Ada");

  seedReceipt(store, { id: wcr("a"), agents: ["Ada"], agentIds: ["ai_ada"] }); // counts
  seedReceipt(store, { id: wcr("b"), agents: ["Ada"], agentIds: ["ai_bob"] }); // a namesake's receipt: no
  seedReceipt(store, { id: wcr("c"), agents: [], humans: ["Ada"], agentIds: [] }); // a human namesake: no
  seedReceipt(store, { id: wcr("d"), agents: ["A. Lovelace"], agentIds: ["ai_ada"] }); // renamed, still hers: counts
  seedReceipt(store, { id: wcr("e"), origin: "vault-room", agents: ["Ada"], agentIds: ["ai_ada"] }); // owner-hidden room: no
  store.db.prepare(`INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at, public_receipts)
    VALUES ('vault-room', 0, NULL, 0, 0)`).run();
  seedReceipt(store, { id: wcr("f"), agents: ["Ada"], agentIds: ["ai_ada"] }); // operator-unpublished: no
  store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('receipt', ?, 0, 'op')").run(wcr("f"));

  syncDirectoryCard(store, "ai_ada");
  assert.equal(entryCount(store, "ai_ada"), 2, "only the two visible receipts credited to ai_ada count");
});

test("projection records the credited identity ids on the row", t => {
  const store = makeStore(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  seedIdentity(store, "ai_ada", "commons", "ada");
  store.workClaims.set("commons", {
    id: "claim-1", title: "Ship the door", state: "done", owner: "ada",
    history: [{ action: "pr_merged", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: "2026-10-01T12:00:00.000Z" },
    blobs: [`sha256:${"ab".repeat(32)}`], updatedAt: "2026-10-01T12:00:00.000Z",
  });
  store.command(ownerKey, "commons", { id: "receipts-on", type: "room.public_receipts_set", data: { enabled: true } });
  const claim = store.db.prepare("SELECT agent_ids_json FROM public_receipts WHERE source='work-claim'").get();
  assert.deepEqual(JSON.parse(claim.agent_ids_json), ["ai_ada"], "the board receipt carries the worker's identity id");

  const PWR = `pwr_${"cd".repeat(32)}`;
  projectPublicWorkReceipt(store, {
    schema: "public-work-receipt/1", receiptId: PWR, namespaceId: "commons", identityId: "ai_ada",
    title: "Public task", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: "cd".repeat(32) },
  }, "cd".repeat(32));
  const pwr = store.db.prepare("SELECT agent_ids_json FROM public_receipts WHERE id=?").get(PWR);
  assert.deepEqual(JSON.parse(pwr.agent_ids_json), ["ai_ada"], "the public-work receipt carries its identity id");
});

test("flipping the room receipts toggle re-syncs affected cards with no projection event", t => {
  const store = makeStore(t);
  seedIdentity(store, "ai_ada", "commons", "ada");
  seedCard(store, "ai_ada", "ai_ada", "Ada");
  seedReceipt(store, { id: wcr("a"), agents: ["Ada"], agentIds: ["ai_ada"] });
  syncDirectoryCard(store, "ai_ada");
  assert.equal(entryCount(store, "ai_ada"), 1);

  store.roomDirectory.setReceiptsVisibility("commons", "owner", false);
  assert.equal(entryCount(store, "ai_ada"), 0, "the toggle flip alone drops the count");
  store.roomDirectory.setReceiptsVisibility("commons", "owner", true);
  assert.equal(entryCount(store, "ai_ada"), 1, "flipping back restores it");
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-dir-counts-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store, operatorAccountId });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store };
}

async function raw(origin, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...headers }, body });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const cookieOf = res => /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") || "")?.[1] ?? null;

async function signup(origin, store, email, password) {
  const slot = store.createAccountSessionSlot();
  const res = await raw(origin, "/api/auth/password/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  const cookie = cookieOf(res);
  const session = cookie ? store.authenticateAccountSession(cookie) : null;
  return { status: res.status, cookie, csrf: session?.csrf ?? null };
}

test("operator unpublish re-syncs affected cards with no projection event", async t => {
  const { origin, store } = await serve(t);
  seedIdentity(store, "ai_ada", "commons", "ada");
  seedCard(store, "ai_ada", "ai_ada", "Ada");
  seedReceipt(store, { id: wcr("a"), agents: ["Ada"], agentIds: ["ai_ada"] });
  seedReceipt(store, { id: wcr("b"), agents: ["Ada"], agentIds: ["ai_ada"] });
  syncDirectoryCard(store, "ai_ada");
  assert.equal(entryCount(store, "ai_ada"), 2);

  const operator = await signup(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  assert.equal(operator.status, 202);
  const unpublish = (kind, id) => raw(origin, "/api/operator/unpublish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `account_session=${operator.cookie}`, "X-CSRF-Token": operator.csrf },
    body: JSON.stringify({ kind, id }),
  });
  assert.equal((await unpublish("receipt", wcr("a"))).status, 200);
  assert.equal(entryCount(store, "ai_ada"), 1, "the receipt takedown alone drops its count");
  assert.equal((await unpublish("room", "commons")).status, 200);
  assert.equal(entryCount(store, "ai_ada"), 0, "the room takedown drops the rest");
});
