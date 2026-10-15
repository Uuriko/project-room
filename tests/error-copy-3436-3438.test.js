// Regression tests for the error-copy defects #3436 and #3438 (Q1 human
// user-testing, re-verified verbatim in round 2, 2026-10-15):
//
// #3436a — an over-cap attachment upload was refused as invalid "canonical
//   base64" because validAttachmentData() folded the size cap into the
//   encoding check, leaving the 413 attachment_too_large branch unreachable.
//   Oversize must now refuse as 413 naming the actual size and the limit, on
//   both the room-file and inbox-attachment paths; genuine encoding errors
//   stay 422.
// #3436b — an over-limit JSON body to the escrow routes was misreported as
//   422 invalid_bounty_input "Expected a JSON body." because readPayload
//   swallowed the shared body reader's 413 too_large. The 413 (which names
//   the actual size and the limit) must pass through; a genuinely malformed
//   body keeps the 422.
// #3438 — the insufficient_funds refusal named the account by raw identity
//   id and gave no remedy. It must use the holder's display name, state
//   what is held and what is needed, and say what to do next.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { attachmentLimits } from "../server/attachment-schema.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";

const errOf = error => ({ status: error?.status, code: error?.code, message: error?.message });

// --- #3436a: room files -----------------------------------------------------

function attachmentStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "error-copy-attach-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => 1_700_000_000_000 });
  const rooms = new AgentRooms(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.identities.create("Copy owner");
  const created = rooms.create(owner.secret, {
    roomId: "copy-den", title: "Copy den", purpose: "Error copy", kind: "personal", displayName: "Copy owner"
  });
  return { store, owner, roomId: created.roomId };
}

test("#3436: oversized room-file upload refuses 413 attachment_too_large naming size and limit", t => {
  const { store, owner, roomId } = attachmentStore(t);
  const data = Buffer.alloc(attachmentLimits.fileBytes + 1, 7).toString("base64");
  assert.throws(
    () => store.roomAttachments.stage(owner.secret, roomId, {
      id: "toobig", filename: "big.bin", mediaType: "application/octet-stream", data
    }),
    error => {
      const e = errOf(error);
      assert.equal(e.status, 413);
      assert.equal(e.code, "attachment_too_large");
      assert.ok(e.message.includes(String(attachmentLimits.fileBytes + 1)), `actual size named: ${e.message}`);
      assert.ok(e.message.includes(String(attachmentLimits.fileBytes)), `limit named: ${e.message}`);
      assert.ok(!/canonical base64/.test(e.message), `not misreported as encoding: ${e.message}`);
      return true;
    });
});

test("#3436: malformed base64 still refuses 422 invalid_attachment; at-cap file stages", t => {
  const { store, owner, roomId } = attachmentStore(t);
  // Whitespace inside the payload: a genuine encoding error, under the cap.
  const dirty = Buffer.from("hello world").toString("base64").replace(/.$/, " ");
  assert.throws(
    () => store.roomAttachments.stage(owner.secret, roomId, {
      id: "dirty", filename: "n.txt", mediaType: "text/plain", data: dirty
    }),
    error => {
      const e = errOf(error);
      assert.equal(e.status, 422);
      assert.equal(e.code, "invalid_attachment");
      assert.match(e.message, /canonical base64/);
      return true;
    });
  // Exactly at the cap is accepted (control: the size check is >, not >=).
  const atCap = Buffer.alloc(attachmentLimits.fileBytes, 3).toString("base64");
  const staged = store.roomAttachments.stage(owner.secret, roomId, {
    id: "atcap", filename: "cap.bin", mediaType: "application/octet-stream", data: atCap
  });
  assert.equal(staged.attachment.byteLength, attachmentLimits.fileBytes);
});

test("#3436: oversized inbox attachment refuses 413 attachment_too_large naming size and limit", t => {
  const { store } = attachmentStore(t);
  const data = Buffer.alloc(attachmentLimits.fileBytes + 1, 9).toString("base64");
  assert.throws(
    () => store.inboxAttachments.put("ai_copytester", {
      id: "toobig", filename: "big.bin", mediaType: "application/octet-stream", data
    }),
    error => {
      const e = errOf(error);
      assert.equal(e.status, 413);
      assert.equal(e.code, "attachment_too_large");
      assert.ok(e.message.includes(String(attachmentLimits.fileBytes + 1)), `actual size named: ${e.message}`);
      assert.ok(e.message.includes(String(attachmentLimits.fileBytes)), `limit named: ${e.message}`);
      return true;
    });
});

// --- #3436b + #3438 over HTTP ------------------------------------------------

const ROOM = "commons";

async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"]) {
      escrow._append({ roomId: ROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable",
        memo: "test seeding: 100 credits", actor: { kind: "rule", id: "test" } });
    }
  });
  ensureSpendGrantsSchema(fixture.store.db);
  for (const memberId of ["producer", "reviewer"]) {
    issueSpendGrant(fixture.store.db, ROOM, memberId,
      { grantedBy: "owner", capCents: "100000", perTxCapCents: "100000", nowMs: Date.now() });
  }
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, keys: fixture.keys };
}

const bountyBody = (overrides = {}) => ({
  title: "Write the migration guide",
  criteria: "Cover every breaking change with a before/after example.",
  amount: 100,
  deadline: new Date(Date.now() + 86400000).toISOString(),
  ...overrides,
});

test("#3436: oversized JSON body to an escrow route refuses 413 too_large, not 'Expected a JSON body.'", async t => {
  const { origin, keys } = await startServer(t);
  // Valid JSON, ~20 KB — over the 16,384-byte JSON body limit.
  const big = bountyBody({ criteria: "x".repeat(20000) });
  const res = await fetch(`${origin}/api/rooms/${ROOM}/bounties`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.owner}` },
    body: JSON.stringify(big),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  const err = body.error ?? body;
  assert.equal(err.code, "too_large");
  assert.match(err.message, /limit is 16384 bytes/);
  assert.ok(!/Expected a JSON body/.test(err.message), `not misreported as malformed: ${err.message}`);
});

test("#3436: genuinely malformed JSON body keeps the 422 invalid_bounty_input refusal", async t => {
  const { origin, keys } = await startServer(t);
  const res = await fetch(`${origin}/api/rooms/${ROOM}/bounties`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.owner}` },
    body: "{not json",
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  const err = body.error ?? body;
  assert.equal(err.code, "invalid_bounty_input");
  assert.match(err.message, /Expected a JSON body\./);
});

test("#3438: insufficient_funds refusal states held/needed and the remedy, with no raw identity id", async t => {
  const { origin, keys } = await startServer(t);
  const createRes = await fetch(`${origin}/api/rooms/${ROOM}/bounties`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.owner}` },
    body: JSON.stringify(bountyBody({ amount: 500 })),
  });
  assert.equal(createRes.status, 201);
  const bountyId = (await createRes.json()).bounty.bountyId;
  // The owner lane holds the seeded 100 payable credits; the bounty needs 500.
  const fundRes = await fetch(`${origin}/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.owner}` },
    body: JSON.stringify({}),
  });
  assert.equal(fundRes.status, 422);
  const body = await fundRes.json();
  const err = body.error ?? body;
  assert.equal(err.code, "insufficient_funds");
  assert.match(err.message, /holds 100 payable credits, needs 500/);
  assert.match(err.message, /Reduce the amount to at most 100 credits, or add credits first\./);
  assert.ok(!/ai_[A-Za-z0-9]/.test(err.message), `no raw identity id: ${err.message}`);
  assert.ok(!err.message.includes("id:agent"), `no raw lane id: ${err.message}`);
});

// --- #3438: display-name rendering at the escrow layer -----------------------

test("#3438: insufficient_funds names the holder by display name, never the lane id", () => {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_copy_test");
    try { const out = fn(); db.exec("RELEASE escrow_copy_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_copy_test"); db.exec("RELEASE escrow_copy_test"); throw error; }
  };
  const JILL = "id:agent/jill";
  const store = {
    db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: JILL, members: {
      [JILL]: { id: JILL, displayName: "Jill", kind: "agent", active: true }
    } })
  };
  const escrow = new BountyEscrow(store, { now: () => 1_786_000_000_000 });
  escrow.ensureGenesis(ROOM); // 100 payable credits to the room's one member
  const bounty = escrow.postBounty(ROOM, {
    poster: JILL, title: "T", criteria: "C", amount: 500,
    deadline: new Date(1_786_000_000_000 + 3_600_000).toISOString()
  }).bounty;
  assert.throws(
    () => escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }),
    error => {
      assert.equal(error.code, "insufficient_funds");
      assert.match(error.message, /^fund: Jill holds 100 payable credits, needs 500\./);
      assert.match(error.message, /Reduce the amount to at most 100 credits, or add credits first\./);
      assert.ok(!error.message.includes(JILL), `no raw lane id: ${error.message}`);
      return true;
    });
});
