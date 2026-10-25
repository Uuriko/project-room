// Result-mode receipts (#3636): a done claim with no pull request used to
// project nothing at all — the public read model only emitted work-claim
// rows for server-verified merges, so a result-mode finish in an opted-in
// room had no stranger-viewable receipt. Now it projects at the
// verification tier recorded on the claim (member-verified when a
// distinct member reviewed it, self-attested when the worker's finish is
// the only record), the member receipt names its public twin, and a room
// that never opted in still projects nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  ensurePublicReceiptVerificationColumn, publicWorkClaimReceiptId, workClaimVerificationTier,
} from "../server/public-read-model.mjs";

const HASH = `sha256:${"ab".repeat(32)}`;

function addAda(store, roomId, ownerKey) {
  store.command(ownerKey, roomId, { id: `add-ada-${roomId}`, type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-result-receipts-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("quiet-room"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const quietOwnerKey = store.issueAccessKey("quiet-room", "owner");
  addAda(store, "commons", ownerKey);
  addAda(store, "quiet-room", quietOwnerKey);
  const adaKey = store.issueAccessKey("commons", "ada");
  const quietAdaKey = store.issueAccessKey("quiet-room", "ada");
  // A result-mode finish a distinct member reviewed and approved.
  store.workClaims.set("commons", {
    id: "verified-result", title: "Verified result work", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "distinct_member", reviewedBy: "owner",
    tags: ["result"],
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T10:00:00.000Z", note: "Delivered the field guide" }],
    pullRequest: null, blobs: [HASH], updatedAt: "2026-10-02T10:00:00.000Z",
  });
  // A result-mode finish only the worker attests.
  store.workClaims.set("commons", {
    id: "self-result", title: "Self attested work", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "self_attested",
    tags: ["result"],
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T11:00:00.000Z", note: "Finished the survey" }],
    pullRequest: null, blobs: [], updatedAt: "2026-10-02T11:00:00.000Z",
  });
  // The merge path, unchanged: the server settled this merge.
  store.workClaims.set("commons", {
    id: "merged-claim", title: "Merged work", state: "done", owner: "ada",
    deliveryMode: "merged",
    history: [
      { action: "state:done", agentId: "ada", at: "2026-10-02T08:00:00.000Z", note: "Merged the fix" },
      { action: "pr_merged", agentId: "ada", at: "2026-10-02T08:05:00.000Z" },
    ],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/21", outcome: "merged", syncedAt: "2026-10-02T08:05:00.000Z" },
    blobs: [HASH], updatedAt: "2026-10-02T08:05:00.000Z",
  });
  // A claim carrying a PR link whose merge the server never settled: the
  // merge gate owns PR-carrying claims, so this projects nothing.
  store.workClaims.set("commons", {
    id: "pr-unsettled", title: "Unsettled merge claim", state: "done", owner: "ada",
    deliveryMode: "merged",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T09:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/22", outcome: "merged", syncedAt: "2026-10-02T09:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-02T09:00:00.000Z",
  });
  // Unfinished and retired claims project nothing.
  store.workClaims.set("commons", {
    id: "open-result", title: "Unfinished work", state: "in_progress", owner: "ada",
    deliveryMode: "result", history: [], pullRequest: null, blobs: [], updatedAt: "2026-10-02T12:00:00.000Z",
  });
  store.workClaims.set("commons", {
    id: "closed-result", title: "Retired work", state: "closed", owner: "ada",
    deliveryMode: "result", history: [], pullRequest: null, blobs: [], updatedAt: "2026-10-02T12:00:00.000Z",
  });
  // The same verified finish in a room that never opted in.
  store.workClaims.set("quiet-room", {
    id: "quiet-verified", title: "Quiet verified work", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "distinct_member", reviewedBy: "owner",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T10:00:00.000Z", note: "Done quietly" }],
    pullRequest: null, blobs: [HASH], updatedAt: "2026-10-02T10:00:00.000Z",
  });
  store.command(ownerKey, "commons", { id: "publish-page", type: "room.public_page_set", data: { enabled: true } });
  store.command(ownerKey, "commons", { id: "publish-receipts", type: "room.public_receipts_set", data: { enabled: true } });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, adaKey, quietAdaKey };
}

async function raw(origin, path, { headers = {} } = {}) {
  const res = await fetch(`${origin}${path}`, { headers });
  return { status: res.status, text: await res.text() };
}

test("the tier derivation reads the recorded fact at its true strength", () => {
  // The #3627 verification object, when a claim carries one, is the fact.
  assert.equal(workClaimVerificationTier({ verification: { state: "verified" }, owner: "ada" }), "verified");
  assert.equal(workClaimVerificationTier({ verification: { state: "self_attested" }, reviewedBy: "owner", owner: "ada" }), "self_attested");
  // On main the fact is reviewedBy, route-enforced at the done transition.
  assert.equal(workClaimVerificationTier({ reviewedBy: "owner", owner: "ada" }), "verified");
  assert.equal(workClaimVerificationTier({ reviewedBy: "ada", owner: "ada" }), "self_attested");
  assert.equal(workClaimVerificationTier({ owner: "ada" }), "self_attested");
  // An unrecognized recorded state never upgrades: the main shape decides.
  assert.equal(workClaimVerificationTier({ verification: { state: "pending" }, reviewedBy: "owner", owner: "ada" }), "verified");
  assert.equal(workClaimVerificationTier({ verification: { state: "pending" }, owner: "ada" }), "self_attested");
});

test("a legacy public_receipts table gains the verification column additively", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-result-migration-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  const columns = () => store.db.prepare("PRAGMA table_info(public_receipts)").all().map(column => column.name);
  assert.ok(columns().includes("verification_state"), "fresh tables carry the column");
  store.db.exec("ALTER TABLE public_receipts DROP COLUMN verification_state");
  assert.equal(columns().includes("verification_state"), false);
  ensurePublicReceiptVerificationColumn(store.db);
  assert.ok(columns().includes("verification_state"), "the ensure restores it on a legacy table");
  ensurePublicReceiptVerificationColumn(store.db);
  assert.ok(columns().includes("verification_state"), "and is idempotent");
});

test("result-mode finishes project at their true tier and resolve anonymously", async t => {
  const { origin } = await serve(t);
  const feed = await raw(origin, "/api/public/receipts?limit=50");
  assert.equal(feed.status, 200);
  const receipts = JSON.parse(feed.text).receipts;
  const byTitle = new Map(receipts.map(receipt => [receipt.title, receipt]));

  const verified = byTitle.get("Verified result work");
  assert.ok(verified, "the member-verified result finish is in the public feed");
  assert.match(verified.id, /^wcr_[a-f0-9]{32}$/);
  assert.equal(verified.id, publicWorkClaimReceiptId("commons", "verified-result"));
  assert.equal(verified.source, "work-claim");
  assert.deepEqual(verified.verification, { state: "verified" });
  assert.equal(verified.pullRequest, null);
  assert.equal(verified.mergedAt, null);
  assert.deepEqual(verified.hashes, [HASH]);
  assert.equal(verified.at, "2026-10-02T10:00:00.000Z");

  const selfAttested = byTitle.get("Self attested work");
  assert.ok(selfAttested, "the self-attested result finish is in the public feed");
  assert.deepEqual(selfAttested.verification, { state: "self_attested" });
  assert.equal(selfAttested.pullRequest, null);
  assert.equal(selfAttested.mergedAt, null);

  // The merge-verified path is unchanged: same fields, no verification key.
  const merged = byTitle.get("Merged work");
  assert.ok(merged, "the server-verified merge still projects");
  assert.equal("verification" in merged, false);
  assert.equal(merged.pullRequest, "https://github.com/Uuriko/project-room/pull/21");
  assert.equal(merged.mergedAt, "2026-10-02T08:05:00.000Z");

  // Nothing else projects: not the unsettled PR claim, not unfinished or
  // retired work, and nothing from the room that never opted in.
  for (const title of ["Unsettled merge claim", "Unfinished work", "Retired work", "Quiet verified work"]) {
    assert.equal(byTitle.has(title), false, title);
  }

  // The feed page labels each result-mode tier in plain words.
  const feedHtml = await raw(origin, "/receipts");
  assert.equal(feedHtml.status, 200);
  assert.match(feedHtml.text, /Verified result work/);
  assert.match(feedHtml.text, /Member-verified completion/);
  assert.match(feedHtml.text, /Self-attested completion/);

  // Both tiers resolve anonymously, page and JSON twin, labeled truthfully.
  const verifiedPage = await raw(origin, `/receipts/${verified.id}`);
  assert.equal(verifiedPage.status, 200);
  assert.match(verifiedPage.text, /Member-verified completion/);
  assert.match(verifiedPage.text, /a room member other than the worker reviewed this delivery and recorded approval/);
  const verifiedJson = await raw(origin, `/receipts/${verified.id}.json`);
  assert.equal(verifiedJson.status, 200);
  assert.deepEqual(JSON.parse(verifiedJson.text).verification, { state: "verified" });

  const selfPage = await raw(origin, `/receipts/${selfAttested.id}`);
  assert.equal(selfPage.status, 200);
  assert.match(selfPage.text, /Self-attested completion/);
  assert.match(selfPage.text, /No other member reviewed it/);
  const selfJson = await raw(origin, `/receipts/${selfAttested.id}.json`);
  assert.equal(selfJson.status, 200);
  assert.deepEqual(JSON.parse(selfJson.text).verification, { state: "self_attested" });

  // The non-opted-in room's twin id 404s, like any private receipt.
  const quietTwin = publicWorkClaimReceiptId("quiet-room", "quiet-verified");
  assert.equal((await raw(origin, `/receipts/${quietTwin}`)).status, 404);
  assert.equal((await raw(origin, `/receipts/${quietTwin}.json`)).status, 404);

  // The proof page names the same tiers with the same words.
  const proof = await raw(origin, "/r/commons/proof.json");
  assert.equal(proof.status, 200);
  const entries = new Map(JSON.parse(proof.text).entries.map(entry => [entry.id, entry]));
  assert.equal(entries.get(verified.id).proofLevel, "member-verified-completion");
  assert.equal(entries.get(verified.id).proofLabel, "Member-verified completion");
  assert.equal(entries.get(selfAttested.id).proofLevel, "self-attested-completion");
  assert.equal(entries.get(selfAttested.id).proofLabel, "Self-attested completion");
  assert.equal(entries.get(merged.id).proofLevel, "server-verified-merge");
});

test("member receipts name the public twin when one resolves, null when none does", async t => {
  const { origin, adaKey, quietAdaKey } = await serve(t);
  const member = await raw(origin, "/api/rooms/commons/receipts", { headers: { authorization: `Bearer ${adaKey}` } });
  assert.equal(member.status, 200);
  const receipts = JSON.parse(member.text).receipts;
  const byId = new Map(receipts.map(receipt => [receipt.workItemId, receipt]));

  const verified = byId.get("verified-result");
  const expectedId = publicWorkClaimReceiptId("commons", "verified-result");
  assert.equal(verified.publicId, expectedId);
  assert.equal(verified.publicUrl, `https://room.trydemigod.com/receipts/${expectedId}`);
  // The advertised link is the one the anonymous feed carries.
  const feed = JSON.parse((await raw(origin, "/api/public/receipts?limit=50")).text).receipts;
  assert.ok(feed.some(receipt => receipt.id === verified.publicId));

  const merged = byId.get("merged-claim");
  assert.equal(merged.publicId, publicWorkClaimReceiptId("commons", "merged-claim"));
  assert.equal(merged.publicUrl, `https://room.trydemigod.com/receipts/${merged.publicId}`);

  // A done claim that never projected gets nulls, never a dead link.
  const unsettled = byId.get("pr-unsettled");
  assert.equal(unsettled.publicId, null);
  assert.equal(unsettled.publicUrl, null);

  // And in the room that never opted in, the same finish has no twin.
  const quiet = await raw(origin, "/api/rooms/quiet-room/receipts", { headers: { authorization: `Bearer ${quietAdaKey}` } });
  assert.equal(quiet.status, 200);
  const quietReceipt = JSON.parse(quiet.text).receipts.find(receipt => receipt.workItemId === "quiet-verified");
  assert.equal(quietReceipt.publicId, null);
  assert.equal(quietReceipt.publicUrl, null);
});
