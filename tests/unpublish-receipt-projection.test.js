// Projection keying for public-work receipts (#3404, residual under #3280).
//
// projectPublicWorkReceipt used to record the public-work claim NAMESPACE
// (an internal `public_<sha256…>` key) as the receipt's room_id/origin_room_id.
// The operator unpublish predicate (HIDDEN_RECEIPT in public-read-model.mjs)
// matches room takedowns against those columns, so a namespace key could never
// match: after a room-only unpublish the receipts site kept serving the
// taken-down room's public-work records, and the public record exposed the
// namespace key as if it were a room id (with room.title never populated,
// because the namespace is not a listed room). The door-level cluster
// (#3277/#3279/#3280) is fixed separately; this suite pins ONLY the projected
// sibling surface — /receipts/<id>.json and /api/public/receipts — both ways,
// plus the backfill sweep healing rows projected before the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { unpublishPublic } from "../server/legal-store.mjs";
import { backfillPublicReadModel } from "../server/public-read-model.mjs";

const COMMONS = "commons";
const ANNEX = "annex";
const TITLE_COMMONS = "Projection task title COMMONS";
const TITLE_ANNEX = "Projection task title ANNEX";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(COMMONS));
  store.initialize(initialRoom(ANNEX));
  const build = room => {
    const taskId = `pwj:${room}`;
    store.projectOffers.create(room, "owner", { requestId: `f-create-${room}`, offerId: taskId,
      reviewerMemberIds: ["owner"],
      terms: { kind: "task", title: room === COMMONS ? TITLE_COMMONS : TITLE_ANNEX, summary: "Seeded",
        acceptanceCriteria: ["Do it"], repositoryUrl: "https://github.com/Example/Project",
        reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
    store.projectOffers.transition(room, "owner", taskId, "publish", { requestId: `f-publish-${room}`, expectedRevision: 1 });
    store.publicWorkClaims.enable(room, "owner", taskId, { requestId: `f-enable-${room}`,
      expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["docs/HISTORY.md"] });
    store.roomDirectory.set(room, "owner", true);
    return { taskId };
  };
  const rooms = { [COMMONS]: build(COMMONS), [ANNEX]: build(ANNEX) };

  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { secret, body } = {}) => {
    const res = await fetch(origin + path, { method,
      headers: { Origin: origin, "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  };
  const minted = await call("POST", "/api/agent-identities", { body: { displayName: "projection-test-agent" } });
  const secret = minted.body.secret;
  const finishTask = async room => {
    const taskPath = `/api/public-work/tasks/${encodeURIComponent(rooms[room].taskId)}`;
    const read = await call("GET", taskPath);
    const claim = await call("POST", taskPath + "/claim", { secret, body: { requestId: `f-claim-${room}`, expectedTermsVersion: read.body.termsVersion, leaseHours: 1 } });
    const finish = await call("POST", taskPath + "/finish", { secret, body: {
      requestId: `f-finish-${room}`, expectedTermsVersion: read.body.termsVersion,
      generation: claim.body.task.claim.generation,
      artifactText: `ARTIFACT BODY ${room.toUpperCase()}`, checksReported: ["checked"] } });
    return finish.body.receipt.receiptId;
  };
  rooms[COMMONS].receiptId = await finishTask(COMMONS);
  rooms[ANNEX].receiptId = await finishTask(ANNEX);
  const namespaceOf = receiptId => JSON.parse(
    store.db.prepare("SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?").get(receiptId).receipt_json).namespaceId;
  return { store, call, rooms, namespaceOf };
}

test("published pwr_ receipts are projected under their true room", async t => {
  const { store, call, rooms, namespaceOf } = await fixture(t);
  const c = rooms[COMMONS], a = rooms[ANNEX];

  // The claim namespace is an internal key and differs from the room id —
  // that difference is the whole defect surface.
  const ns = namespaceOf(c.receiptId);
  assert.ok(ns && ns !== COMMONS);

  const sibling = await call("GET", `/receipts/${c.receiptId}.json`);
  assert.equal(sibling.status, 200);
  assert.equal(sibling.body.room?.id, COMMONS);
  assert.equal(sibling.body.room?.title, store.room(COMMONS).state.room.title);

  const annex = await call("GET", `/receipts/${a.receiptId}.json`);
  assert.equal(annex.status, 200);
  assert.equal(annex.body.room?.id, ANNEX);

  // The room filter speaks in room ids: the true room finds the receipt,
  // the namespace key finds nothing.
  const byRoom = await call("GET", `/api/public/receipts?room=${COMMONS}&limit=50`);
  assert.ok(JSON.stringify(byRoom.body).includes(c.receiptId));
  assert.ok(!JSON.stringify(byRoom.body).includes(a.receiptId));
  const byNamespace = await call("GET", `/api/public/receipts?room=${encodeURIComponent(ns)}&limit=50`);
  assert.ok(!JSON.stringify(byNamespace.body).includes(c.receiptId));
});

test("room unpublish hides the room's pwr_ receipts at the receipts site and list", async t => {
  const { store, call, rooms } = await fixture(t);
  const c = rooms[COMMONS], a = rooms[ANNEX];
  unpublishPublic(store.db, { kind: "room", id: COMMONS, byAccount: "operator-acct", now: Date.now() });

  assert.equal((await call("GET", `/receipts/${c.receiptId}.json`)).status, 404);
  const receiptList = await call("GET", "/api/public/receipts?limit=50");
  assert.ok(!JSON.stringify(receiptList.body).includes(c.receiptId));
  assert.ok(JSON.stringify(receiptList.body).includes(a.receiptId));
  const byRoom = await call("GET", `/api/public/receipts?room=${COMMONS}&limit=50`);
  assert.ok(!JSON.stringify(byRoom.body).includes(c.receiptId));

  // The untouched room's receipt still serves, keyed by its true room.
  const annex = await call("GET", `/receipts/${a.receiptId}.json`);
  assert.equal(annex.status, 200);
  assert.equal(annex.body.room?.id, ANNEX);
});

test("the backfill sweep re-projects legacy namespace-keyed rows so a takedown reaches them", async t => {
  const { store, call, rooms, namespaceOf } = await fixture(t);
  const c = rooms[COMMONS], a = rooms[ANNEX];

  // Simulate a row projected before the fix: namespace in both room columns.
  const ns = namespaceOf(c.receiptId);
  store.db.prepare("UPDATE public_receipts SET room_id=?, origin_room_id=?, room_title=NULL WHERE id=?")
    .run(ns, ns, c.receiptId);

  // In that legacy state the takedown cannot see the row (the live hazard).
  unpublishPublic(store.db, { kind: "room", id: COMMONS, byAccount: "operator-acct", now: Date.now() });
  assert.equal((await call("GET", `/receipts/${c.receiptId}.json`)).status, 200);

  // The receipts phase of the backfill re-projects stored receipt bodies
  // through projectPublicWorkReceipt, which now resolves the true room.
  for (let i = 0; i < 20 && !backfillPublicReadModel(store, { limit: 100 }).done; i++) { /* drain phases */ }

  const healed = store.db.prepare("SELECT room_id FROM public_receipts WHERE id=?").get(c.receiptId);
  assert.equal(healed.room_id, COMMONS);
  assert.equal((await call("GET", `/receipts/${c.receiptId}.json`)).status, 404);
  const receiptList = await call("GET", "/api/public/receipts?limit=50");
  assert.ok(!JSON.stringify(receiptList.body).includes(c.receiptId));
  assert.ok(JSON.stringify(receiptList.body).includes(a.receiptId));
});
