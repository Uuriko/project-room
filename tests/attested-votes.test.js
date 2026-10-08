// Attested-ballot protocol (identity-sybil guild W6): Ed25519
// challenge-response ballots, one ballot per identityId, offline recount.
//
// Fail-first suite: every test here failed before server/attested-votes.mjs,
// server/attested-vote-routes.mjs, verifySignatureBytes and keyForIdentityAt
// existed. Run: TMPDIR=<worktree>/.tmp node --test tests/attested-votes.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { canonicalBallotBytes } from "../server/attested-votes.mjs";
import {
  generateKeyPair,
  signBytes,
  signCard,
  verifySignatureBytes,
} from "../server/agent-card-signing.mjs";

const ROOM = "commons";
const OPTIONS = [{ id: "opt_a", label: "Alpha" }, { id: "opt_b", label: "Beta" }];

const startServer = async (t, f) => {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
};

const jsonFetch = (origin, path, { method = "GET", body = null, bearer = null, identitySecret = null } = {}) => fetch(`${origin}${path}`, {
  method,
  headers: {
    "content-type": "application/json",
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    ...(identitySecret ? { "x-identity-secret": identitySecret } : {}),
  },
  ...(body === null ? {} : { body: JSON.stringify(body) }),
});
const errorOf = async res => {
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, code: parsed?.error?.code, detail: parsed?.error?.detail, body: parsed };
};

// Per-test world: fresh fixture, server, and one allowlist vote room.
const world = async (t, { proofMode = "signature", mode = "allowlist", voters = 2, title = "Convention vote" } = {}) => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identities = Array.from({ length: voters }, (_, i) => f.store.identities.create(`Voter ${i}`));
  const created = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms`, {
    method: "POST", bearer: f.keys.owner,
    body: { title, mode, proofMode, options: OPTIONS, identityIds: identities.map(i => i.identityId) },
  });
  assert.equal(created.status, 201, `vote room create: ${created.status}`);
  const { voteRoomId } = await created.json();
  return { f, origin, identities, voteRoomId };
};

const challengeFor = async (origin, voteRoomId, identity, { bearer, expect = 201 } = {}) => {
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/challenge`, {
    method: "POST", bearer, identitySecret: identity.secret, body: { identityId: identity.identityId },
  });
  assert.equal(res.status, expect, `challenge: ${res.status}`);
  return res.json();
};

const signBallotBody = ({ privateKey, voteRoomId, identityId, choice, nonce, challengeId, issuedAt }) => {
  const signature = signBytes({
    privateKey,
    bytes: canonicalBallotBytes({ voteRoomId, identityId, choice, nonce, challengeId, issuedAt }),
  });
  return { identityId, choice, nonce, challengeId, issuedAt, signature };
};

const castBallot = async (origin, voteRoomId, identity, ballotBody, { bearer, expect = 201 } = {}) => {
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer, identitySecret: identity.secret, body: ballotBody,
  });
  assert.equal(res.status, expect, `ballot: ${res.status} ${JSON.stringify(await res.clone().json().catch(() => ({})))}`);
  return res.json();
};

// ---- vote-room creation ----

test("vote room creation pins the admitted-delegate allowlist (owner only)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const a = f.store.identities.create("A");
  const created = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms`, {
    method: "POST", bearer: f.keys.owner,
    body: { title: "T", mode: "allowlist", options: OPTIONS, identityIds: [a.identityId] },
  });
  assert.equal(created.status, 201);
  const { voteRoomId } = await created.json();
  assert.match(voteRoomId, /^vr_/);
  const read = await (await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}`, { bearer: f.keys.owner })).json();
  assert.equal(read.voteRoom.mode, "allowlist");
  assert.equal(read.voteRoom.proofMode, "signature");
  assert.equal(read.admittedCount, 1);
  assert.equal(read.ballotsCast, 0);
  // A non-owner member cannot open a vote room.
  const denied = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms`, {
    method: "POST", bearer: f.keys.producer,
    body: { title: "T", mode: "open", options: OPTIONS },
  });
  assert.equal(denied.status, 403);
});

test("vote room creation validates its shape", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  for (const body of [
    { title: "T", mode: "allowlist", options: OPTIONS, identityIds: [] },          // empty roster
    { title: "T", mode: "allowlist", options: [{ id: "x" }], identityIds: ["ai_x"] }, // single option
    { title: "T", mode: "nope", options: OPTIONS },                                // bad mode
    { title: "", mode: "open", options: OPTIONS },                                // empty title
  ]) {
    const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms`, { method: "POST", bearer: f.keys.owner, body });
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal((await res.json()).error.code, "invalid_vote_room");
  }
});

// ---- challenge issuance ----

test("issues a single-use challenge to an admitted identity", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  assert.match(ch.challengeId, /^ch_/);
  assert.equal(ch.voteRoomId, voteRoomId);
  assert.equal(ch.identityId, voter.identityId);
  const nonceBytes = Buffer.from(ch.nonce, "base64url");
  assert.ok(nonceBytes.length >= 16, "nonce is 16+ bytes");
  const ttl = ch.expiresAt - Date.now();
  assert.ok(ttl > 4 * 60 * 1000 && ttl <= 5 * 60 * 1000, `TTL ~5min, got ${ttl}`);
  // The raw nonce is never stored — only its sha256.
  const row = f.store.db.prepare("SELECT nonce_hash FROM vote_challenges WHERE challenge_id=?").get(ch.challengeId);
  assert.equal(row.nonce_hash, createHash("sha256").update(ch.nonce).digest("hex"));
  assert.ok(!JSON.stringify(row).includes(ch.nonce.slice(0, 8)));
});

test("refuses a challenge for a non-allowlisted identity", async t => {
  const { f, origin, voteRoomId } = await world(t);
  const outsider = f.store.identities.create("Outsider");
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/challenge`, {
    method: "POST", bearer: f.keys.owner, identitySecret: outsider.secret, body: { identityId: outsider.identityId },
  });
  const err = await errorOf(res);
  assert.equal(err.status, 403);
  assert.equal(err.code, "not_admitted");
});

test("refuses a challenge for a legacy identity with no registered key", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [legacy] = identities;
  f.store.db.prepare("DELETE FROM agent_key_registry WHERE identity_id=?").run(legacy.identityId);
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/challenge`, {
    method: "POST", bearer: f.keys.owner, identitySecret: legacy.secret, body: { identityId: legacy.identityId },
  });
  const err = await errorOf(res);
  assert.equal(err.status, 409);
  assert.equal(err.code, "no_identity_key");
  assert.match(JSON.stringify(err.detail ?? {}), /keys\/rotate/);
});

test("legacy identity votes after self-service key registration", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [legacy] = identities;
  f.store.db.prepare("DELETE FROM agent_key_registry WHERE identity_id=?").run(legacy.identityId);
  // The upgrade path is the existing rotate route — no new code.
  const fresh = generateKeyPair();
  const rotated = await jsonFetch(origin, `/api/agent-identities/${legacy.identityId}/keys/rotate`, {
    method: "POST", bearer: legacy.secret, body: { newPublicKey: fresh.publicKey },
  });
  assert.equal(rotated.status, 200);
  const ch = await challengeFor(origin, voteRoomId, legacy, { bearer: f.keys.owner });
  assert.match(ch.challengeId, /^ch_/);
  const issuedAt = Date.now();
  const receipt = await castBallot(origin, voteRoomId,
    { ...legacy, privateKey: fresh.privateKey },
    signBallotBody({ privateKey: fresh.privateKey, voteRoomId, identityId: legacy.identityId,
      choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt }),
    { bearer: f.keys.owner });
  assert.equal(receipt.proofMode, "signature");
  assert.equal(receipt.publicKey, fresh.publicKey);
});

// ---- ballot verification ----

test("accepts a well-formed signed ballot and returns a receipt carrying the proof", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  const issuedAt = Date.now();
  const receipt = await castBallot(origin, voteRoomId, voter,
    signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
      choice: "opt_b", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt }),
    { bearer: f.keys.owner });
  assert.match(receipt.ballotId, /^b_/);
  assert.equal(receipt.voteRoomId, voteRoomId);
  assert.equal(receipt.identityId, voter.identityId);
  assert.equal(receipt.choice, "opt_b");
  assert.equal(receipt.publicKey, voter.publicKey);
  assert.equal(receipt.proofMode, "signature");
  assert.equal(receipt.issuedAt, issuedAt);
  assert.ok(typeof receipt.signature === "string" && receipt.signature.length > 0);
  // The proof travels with the ballot row.
  const row = f.store.db.prepare("SELECT public_key, signature FROM attested_ballots WHERE ballot_id=?").get(receipt.ballotId);
  assert.equal(row.public_key, voter.publicKey);
  assert.equal(row.signature, receipt.signature);
});

test("rejects a ballot signed over the wrong nonce", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
    body: signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
      choice: "opt_a", nonce: "AAAAAAAAAAAAAAAAAAAAAA", challengeId: ch.challengeId, issuedAt: Date.now() }),
  });
  const err = await errorOf(res);
  assert.equal(err.status, 422);
  assert.equal(err.code, "bad_signature");
});

test("rejects a key transplant: attacker key under the victim identityId", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [victim, attacker] = identities;
  const ch = await challengeFor(origin, voteRoomId, victim, { bearer: f.keys.owner });
  // Attacker signs with their own valid key but claims the victim's identity.
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: victim.secret,
    body: signBallotBody({ privateKey: attacker.privateKey, voteRoomId, identityId: victim.identityId,
      choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
  });
  const err = await errorOf(res);
  assert.equal(err.status, 422);
  assert.equal(err.code, "bad_signature");
});

test("rejects a cross-room replay: room-A bytes submitted to room-B", async t => {
  const { f, origin, identities, voteRoomId: roomA } = await world(t);
  const [voter] = identities;
  const created = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms`, {
    method: "POST", bearer: f.keys.owner,
    body: { title: "B", mode: "allowlist", options: OPTIONS, identityIds: [voter.identityId] },
  });
  const { voteRoomId: roomB } = await created.json();
  const chA = await challengeFor(origin, roomA, voter, { bearer: f.keys.owner });
  const chB = await challengeFor(origin, roomB, voter, { bearer: f.keys.owner });
  const issuedAt = Date.now();
  // Signed for room A, submitted to room B with room B's challenge.
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${roomB}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
    body: signBallotBody({ privateKey: voter.privateKey, voteRoomId: roomA, identityId: voter.identityId,
      choice: "opt_a", nonce: chB.nonce, challengeId: chB.challengeId, issuedAt }),
  });
  const err = await errorOf(res);
  assert.equal(err.status, 422);
  assert.equal(err.code, "bad_signature");
  void chA;
});

test("rejects an expired challenge", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  f.store.db.prepare("UPDATE vote_challenges SET expires_at=? WHERE challenge_id=?").run(Date.now() - 1000, ch.challengeId);
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
    body: signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
      choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
  });
  const err = await errorOf(res);
  assert.equal(err.status, 410);
  assert.equal(err.code, "challenge_expired");
});

test("rejects a reused challenge (single-use nonces)", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  const issuedAt = Date.now();
  await castBallot(origin, voteRoomId, voter,
    signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
      choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt }),
    { bearer: f.keys.owner });
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
    body: signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
      choice: "opt_b", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt }),
  });
  const err = await errorOf(res);
  assert.equal(err.status, 409);
  assert.equal(err.code, "challenge_reused");
});

test("rejects a stale issuedAt outside the skew bound", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
    body: signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
      choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() - 3600_000 }),
  });
  const err = await errorOf(res);
  assert.equal(err.status, 422);
  assert.equal(err.code, "stale_ballot");
});

// ---- double-vote: the incident regression ----

test("a second ballot from the same identityId is rejected and the tally counts one", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  for (const choice of ["opt_a", "opt_b"]) {
    const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
    if (choice === "opt_a") {
      await castBallot(origin, voteRoomId, voter,
        signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
          choice, nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
        { bearer: f.keys.owner });
    } else {
      const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
        method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
        body: signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
          choice, nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
      });
      const err = await errorOf(res);
      assert.equal(err.status, 409);
      assert.equal(err.code, "ballot_duplicate");
    }
  }
  const tally = await (await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/tally`, { bearer: f.keys.owner })).json();
  assert.deepEqual(tally.tally, { opt_a: 1 });
  assert.equal(tally.ballotsCast, 1);
});

test("incident regression: ten delegates sharing one identity.json collapse to one ballot", async t => {
  const { f, origin, identities, voteRoomId } = await world(t, { voters: 1 });
  const [shared] = identities; // one identity.json in ten hands
  let recorded = 0, duplicates = 0;
  for (let delegate = 0; delegate < 10; delegate++) {
    const ch = await challengeFor(origin, voteRoomId, shared, { bearer: f.keys.owner });
    const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
      method: "POST", bearer: f.keys.owner, identitySecret: shared.secret,
      body: signBallotBody({ privateKey: shared.privateKey, voteRoomId, identityId: shared.identityId,
        choice: delegate % 2 ? "opt_a" : "opt_b", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
    });
    if (res.status === 201) recorded++;
    else { assert.equal((await res.json()).error.code, "ballot_duplicate"); duplicates++; }
  }
  assert.equal(recorded, 1);
  assert.equal(duplicates, 9);
  const tally = await (await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/tally`, { bearer: f.keys.owner })).json();
  assert.equal(tally.ballotsCast, 1);
  assert.deepEqual(tally.duplicates, []);
});

test("the duplicate-detection recount query finds zero rows in a healthy election", async t => {
  const { f, origin, identities, voteRoomId } = await world(t, { voters: 3 });
  for (const voter of identities) {
    const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
    await castBallot(origin, voteRoomId, voter,
      signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
        choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
      { bearer: f.keys.owner });
  }
  const dups = f.store.attestedVotes.findDuplicates(voteRoomId);
  assert.deepEqual(dups, []);
});

test("offline recount of the public ballot set matches the server tally", async t => {
  const { f, origin, identities, voteRoomId } = await world(t, { voters: 3 });
  const choices = ["opt_a", "opt_b", "opt_a"];
  for (const [i, voter] of identities.entries()) {
    const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
    await castBallot(origin, voteRoomId, voter,
      signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
        choice: choices[i], nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
      { bearer: f.keys.owner });
  }
  const serverTally = await (await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/tally`, { bearer: f.keys.owner })).json();
  // Independent recount: anyone with read access re-verifies every signature
  // against the proof attached to the ballot — no server trust required.
  const ballots = await (await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, { bearer: f.keys.owner })).json();
  const recount = {};
  for (const ballot of ballots.ballots) {
    const ok = verifySignatureBytes({
      publicKey: ballot.publicKey,
      signature: ballot.signature,
      bytes: canonicalBallotBytes({ voteRoomId, identityId: ballot.identityId, choice: ballot.choice,
        nonce: ballot.nonce, challengeId: ballot.challengeId, issuedAt: ballot.issuedAt }),
    });
    assert.ok(ok, `ballot ${ballot.ballotId} re-verifies offline`);
    recount[ballot.choice] = (recount[ballot.choice] ?? 0) + 1;
  }
  assert.deepEqual(recount, serverTally.tally);
});

// ---- key lifecycle ----

test("a ballot signed with the rotated key verifies inside the overlap window", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const fresh = generateKeyPair();
  const rotated = await jsonFetch(origin, `/api/agent-identities/${voter.identityId}/keys/rotate`, {
    method: "POST", bearer: voter.secret, body: { newPublicKey: fresh.publicKey, overlapMs: 60_000 },
  });
  assert.equal(rotated.status, 200);
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  const receipt = await castBallot(origin, voteRoomId,
    { ...voter, privateKey: fresh.privateKey },
    signBallotBody({ privateKey: fresh.privateKey, voteRoomId, identityId: voter.identityId,
      choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
    { bearer: f.keys.owner });
  assert.equal(receipt.publicKey, fresh.publicKey);
});

test("a ballot signed with a revoked key is rejected after revokedAt", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  const revoked = await jsonFetch(origin, `/api/agent-identities/${voter.identityId}/keys/revoke`, {
    method: "POST", bearer: voter.secret, body: { publicKey: voter.publicKey },
  });
  assert.equal(revoked.status, 200);
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
    body: signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
      choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
  });
  const err = await errorOf(res);
  // No key window covers issuedAt anymore: legacy-style refusal.
  assert.ok(err.status === 422 || err.status === 409, JSON.stringify(err));
  assert.ok(["bad_signature", "no_identity_key"].includes(err.code), err.code);
});

test("a pre-revocation ballot keeps verifying offline after the key is revoked", async t => {
  const { f, origin, identities, voteRoomId } = await world(t);
  const [voter] = identities;
  const ch = await challengeFor(origin, voteRoomId, voter, { bearer: f.keys.owner });
  const issuedAt = Date.now();
  const body = signBallotBody({ privateKey: voter.privateKey, voteRoomId, identityId: voter.identityId,
    choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt });
  const receipt = await castBallot(origin, voteRoomId, voter, body, { bearer: f.keys.owner });
  const revoked = await jsonFetch(origin, `/api/agent-identities/${voter.identityId}/keys/revoke`, {
    method: "POST", bearer: voter.secret, body: { publicKey: voter.publicKey },
  });
  assert.equal(revoked.status, 200);
  // History is stable: the stored proof still verifies against the ballot row.
  assert.ok(verifySignatureBytes({
    publicKey: receipt.publicKey,
    signature: receipt.signature,
    bytes: canonicalBallotBytes({ voteRoomId, identityId: voter.identityId, choice: "opt_a",
      nonce: ch.nonce, challengeId: ch.challengeId, issuedAt }),
  }));
});

// ---- registration mode + degradation ----

test("open room: one registration per identity", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const voter = f.store.identities.create("Open voter");
  const created = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms`, {
    method: "POST", bearer: f.keys.owner, body: { title: "Open", mode: "open", options: OPTIONS },
  });
  assert.equal(created.status, 201);
  const { voteRoomId } = await created.json();
  const register = () => jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/register`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret, body: { identityId: voter.identityId },
  });
  assert.equal((await register()).status, 201);
  const again = await register();
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, "already_registered");
  // Registration attests identity ownership: the wrong secret is refused.
  const other = f.store.identities.create("Other");
  const forged = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/register`, {
    method: "POST", bearer: f.keys.owner, identitySecret: other.secret, body: { identityId: voter.identityId },
  });
  assert.equal(forged.status, 403);
});

test("server proof mode: a dumb client ballot is recorded and deduplicated", async t => {
  const { f, origin, identities, voteRoomId } = await world(t, { proofMode: "server" });
  const [voter] = identities;
  // No challenge, no signature fields — bearer auth only.
  const cast = body => jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret, body,
  });
  const first = await cast({ identityId: voter.identityId, choice: "opt_a" });
  assert.equal(first.status, 201);
  const receipt = await first.json();
  assert.equal(receipt.proofMode, "server");
  assert.equal(receipt.choice, "opt_a");
  const second = await cast({ identityId: voter.identityId, choice: "opt_b" });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "ballot_duplicate");
  const tally = await (await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/tally`, { bearer: f.keys.owner })).json();
  assert.equal(tally.ballotsCast, 1);
});

test("either mode labels each receipt with its proof mode", async t => {
  const { f, origin, identities, voteRoomId } = await world(t, { proofMode: "either" });
  const [signer, dumber] = identities;
  const ch = await challengeFor(origin, voteRoomId, signer, { bearer: f.keys.owner });
  await castBallot(origin, voteRoomId, signer,
    signBallotBody({ privateKey: signer.privateKey, voteRoomId, identityId: signer.identityId,
      choice: "opt_a", nonce: ch.nonce, challengeId: ch.challengeId, issuedAt: Date.now() }),
    { bearer: f.keys.owner });
  const dumb = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: dumber.secret,
    body: { identityId: dumber.identityId, choice: "opt_b" },
  });
  assert.equal(dumb.status, 201);
  const ballots = await (await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, { bearer: f.keys.owner })).json();
  const modes = Object.fromEntries(ballots.ballots.map(b => [b.identityId, b.proofMode]));
  assert.deepEqual(modes, { [signer.identityId]: "signature", [dumber.identityId]: "server" });
});

// ---- endorsement gate (endorsement-tier worker not yet landed) ----

test("an unendorsed identity gets 403 unendorsed_identity on challenge and ballot", async t => {
  const { f, origin, identities, voteRoomId } = await world(t, { proofMode: "server" });
  const [voter] = identities;
  // The endorsement-tier worker has not landed: the gate is an injectable
  // seam (store.endorsementTiers / instance override), default-allow.
  f.store.attestedVotes.isEndorsed = () => false;
  t.after(() => { delete f.store.attestedVotes.isEndorsed; });
  const chRes = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/challenge`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret, body: { identityId: voter.identityId },
  });
  assert.equal(chRes.status, 403);
  assert.equal((await chRes.json()).error.code, "unendorsed_identity");
  const bRes = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
    body: { identityId: voter.identityId, choice: "opt_a" },
  });
  assert.equal(bRes.status, 403);
  assert.equal((await bRes.json()).error.code, "unendorsed_identity");
});

// ---- scope ----

// A real redeemed guest-agent credential (member id starts with
// "guest-agent-", the shape the guest write gate keys on).
const redeemGuest = async (origin, f) => {
  const { randomUUID } = await import("node:crypto");
  const mint = await jsonFetch(origin, `/api/rooms/${ROOM}/guest-invites`, {
    method: "POST", bearer: f.keys.owner,
    body: { requestId: randomUUID(), guestLabel: "ballot guest", expectedOwnerRevision: 0 },
  });
  assert.equal(mint.status, 201);
  const { code } = await mint.json();
  const identity = f.store.identities.create("Ballot guest");
  const keys = generateKeyPair();
  const cardBody = { name: "Ballot guest", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await jsonFetch(origin, "/api/guest-invites/redeem", {
    method: "POST", bearer: identity.secret, body: { inviteCode: code, card },
  });
  assert.equal(redeemed.status, 201);
  const value = await redeemed.json();
  assert.ok(value.member.id.startsWith("guest-agent-"));
  return value; // { token, member }
};

test("guests can read ballots and the tally but cannot cast", async t => {
  const { f, origin, identities, voteRoomId } = await world(t, { proofMode: "server" });
  const [voter] = identities;
  const guest = await redeemGuest(origin, f);
  const cast = body => jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret, body,
  });
  assert.equal((await cast({ identityId: voter.identityId, choice: "opt_a" })).status, 201);
  assert.equal((await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, { bearer: guest.token })).status, 200);
  assert.equal((await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/tally`, { bearer: guest.token })).status, 200);
  const denied = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: guest.token, identitySecret: voter.secret,
    body: { identityId: voter.identityId, choice: "opt_b" },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "guest_scope_denied");
});

test("a closed vote room refuses new ballots with vote_closed", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const voter = f.store.identities.create("Late voter");
  const created = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms`, {
    method: "POST", bearer: f.keys.owner,
    body: { title: "Closed", mode: "allowlist", proofMode: "server", options: OPTIONS,
      identityIds: [voter.identityId], closesAt: Date.now() - 1000 },
  });
  assert.equal(created.status, 201);
  const { voteRoomId } = await created.json();
  const res = await jsonFetch(origin, `/api/rooms/${ROOM}/vote-rooms/${voteRoomId}/ballots`, {
    method: "POST", bearer: f.keys.owner, identitySecret: voter.secret,
    body: { identityId: voter.identityId, choice: "opt_a" },
  });
  const err = await errorOf(res);
  assert.equal(err.status, 409);
  assert.equal(err.code, "vote_closed");
});
