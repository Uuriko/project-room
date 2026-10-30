// Register rows 124/125 (E3-F1/E3-F2): the public-receipt projection
// passed receipt titles through the display-name cleaner cleanName(),
// which slices at 80 chars, and fell back to the fabricated generic
// title "Public work" when a receipt record's title was null. At the
// production pin the list projection and the human receipt page showed
// an 84-char title cut mid-word with no ellipsis, and three receipts
// for three different works all titled "Public work", while the task
// face and the single-receipt face carried the full / real titles.
// The projection must carry the full title, reach the task's title
// through the receipt's task link when its own title is null, and
// otherwise say so explicitly.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { projectPublicWorkReceipt, rederivePublicReceipt } from "../server/public-read-model.mjs";

const NAMESPACE = `public_${"ef".repeat(16)}`;
const SHA = "ab".repeat(32);
const LONG_TITLE = "FS-13 DRILL T2 - Dispute-outcome census of the disputes machine (drill, dispute leg) extended cut";

function serve(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pwr-title-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("task-room"));
  return store;
}

// A public-work task row plus, when a title is given, its project offer
// (the offer's terms carry the title the task face serves).
function addTask(store, offerId, title) {
  const now = Date.now();
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(offerId, NAMESPACE, "task-room", 1, "https://github.com/Uuriko/project-room", "main", "[]", 1, now);
  if (title !== undefined) {
    const terms = { kind: "task", title, summary: "Summary", acceptanceCriteria: ["Done"], reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } };
    store.db.prepare("INSERT INTO project_offers VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(offerId, "task-room", "owner", 1, 1, "published", JSON.stringify(terms), "{}", now, now);
  }
}

function project(store, receiptId, fields) {
  const body = { schema: "public-work-receipt/1", receiptId, namespaceId: NAMESPACE,
    identityId: "ai_public", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: SHA }, ...fields };
  projectPublicWorkReceipt(store, body, SHA);
  return store.db.prepare("SELECT title FROM public_receipts WHERE id=?").get(receiptId)?.title;
}

// Store the receipt record the way the claims rail does, then project it.
function storeAndProject(store, receiptId, offerId, fields) {
  const body = { schema: "public-work-receipt/1", receiptId, taskId: offerId, namespaceId: NAMESPACE,
    identityId: "ai_public", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: SHA }, ...fields };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(receiptId, offerId, NAMESPACE, 1, "ai_public", "note", SHA, 4, JSON.stringify(body), Date.now());
  projectPublicWorkReceipt(store, body, SHA);
  return body;
}

test("a receipt title longer than 80 chars survives the projection intact (E3-F1)", t => {
  const store = serve(t);
  assert.ok(LONG_TITLE.length > 80);
  addTask(store, "offer-long", LONG_TITLE);
  const title = project(store, `pwr_${"ab".repeat(32)}`, { taskId: "offer-long", title: LONG_TITLE });
  assert.equal(title, LONG_TITLE);
});

test("a null-title receipt renders its task's title, not a generic one (E3-F2)", t => {
  const store = serve(t);
  addTask(store, "offer-named", "Verify the seed chain end to end");
  const title = project(store, `pwr_${"cd".repeat(32)}`, { taskId: "offer-named", title: null });
  assert.equal(title, "Verify the seed chain end to end");
});

test("a null-title receipt with no reachable task title is explicitly untitled (E3-F2)", t => {
  const store = serve(t);
  addTask(store, "offer-orphan", undefined);
  const title = project(store, `pwr_${"ef".repeat(32)}`, { taskId: "offer-orphan", title: null });
  assert.equal(title, "Untitled receipt");
  assert.notEqual(title, "Public work");
});

test("rederive agrees: a null title re-derives to the task's title (E3-F2)", t => {
  const store = serve(t);
  const id = `pwr_${"12".repeat(32)}`;
  addTask(store, "offer-rederive", "Map the public directory surface");
  storeAndProject(store, id, "offer-rederive", { title: null });
  const rederived = rederivePublicReceipt(store, id);
  assert.equal(rederived?.row?.title, "Map the public directory surface");
});

test("rederive agrees: a long title re-derives in full (E3-F1)", t => {
  const store = serve(t);
  const id = `pwr_${"34".repeat(32)}`;
  addTask(store, "offer-rederive-long", LONG_TITLE);
  storeAndProject(store, id, "offer-rederive-long", { title: LONG_TITLE });
  const rederived = rederivePublicReceipt(store, id);
  assert.equal(rederived?.row?.title, LONG_TITLE);
});
