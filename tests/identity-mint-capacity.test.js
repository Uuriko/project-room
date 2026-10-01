// Anonymous identity mint capacity.
//
// Authoring gate:
// 1. Anonymous mints cannot pass the address, network, daily, or per-minute
//    budgets; a proof is required once the free quota is spent; the 428
//    proof object is enough to compute a nonce the server accepts; anonymous
//    rows that never authenticate, post, or get linked expire; auth, link,
//    post, a room membership, an invite, and a pending claim keep them;
//    invite-style and recoverable replays do not spend a new slot; the HTTP
//    routes pass the client address and proof; llms.txt and agents.json name
//    the same proof recipe. Closing the store before a deferred activation
//    flushes does not throw.
// 2. Dropping a budget check, the proof check, a proof-body field, the
//    expiry delete, a membership/invite/claim exclusion, the closed-store
//    guard, or the HTTP anonymous argument fails these tests.
// 3. Existing tests cover the 5000-row cap and the 30/minute pre-body
//    limiter only.
// 4. Limits are the same constructor options production uses. The bucket,
//    verify, and solve helpers are the production functions.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { encodeRow } from "../server/persisted-row.mjs";
import { GUEST_CREDENTIAL_TTL_MIN_MS } from "../server/guest-invites.mjs";
import { agentsJson, llmsTxt } from "../deploy/agent-discovery.mjs";
import {
  AgentIdentities,
  IDENTITY_POW_BITS,
  IDENTITY_POW_WINDOW_MS,
  anonymousMintBuckets,
  verifyIdentityMintProof,
  solveIdentityMintProof as solveOnServer,
} from "../server/agent-identities.mjs";
import {
  IDENTITY_MINT_POW_BITS,
  IDENTITY_MINT_POW_WINDOW_MS,
  solveIdentityMintProof as solveInBrowser,
} from "../src/client.js";
import {
  IDENTITY_MINT_POW_BITS as CLI_POW_BITS,
  IDENTITY_MINT_POW_WINDOW_MS as CLI_POW_WINDOW_MS,
  solveIdentityMintProof as solveInCli,
} from "../client/room-agent.mjs";

const DAY = 24 * 60 * 60 * 1000;

function openStore(t, now = () => Date.now()) {
  const directory = mkdtempSync(join(tmpdir(), "identity-mint-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function budgets(overrides = {}) {
  return {
    anonymousDailyLimit: 30,
    addressDailyLimit: 30,
    networkDailyLimit: 30,
    addressMinuteLimit: 30,
    proofFreePerAddress: 30,
    ...overrides,
  };
}

const mint = (store, overrides = {}) => new AgentIdentities(store, budgets(overrides));
const anon = (address, proof) => ({ anonymous: { address, ...(proof ? { proof } : {}) } });
const countOf = store => store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
const stored = (store, identityId) => store.db.prepare(
  "SELECT activated_at AS activatedAt, mint_address AS mintAddress FROM agent_identities WHERE identity_id=?"
).get(identityId);

function refusal(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

function assertProofRecipe(proof, displayName, now) {
  const name = displayName.trim();
  const bucket = Math.floor(now / IDENTITY_POW_WINDOW_MS);
  assert.equal(proof.algorithm, "sha256-prefix");
  assert.equal(proof.hash, "sha256");
  assert.equal(proof.encoding, "hex");
  assert.equal(proof.bits, IDENTITY_POW_BITS);
  assert.equal(proof.prefix, "0".repeat(IDENTITY_POW_BITS / 4));
  assert.equal(proof.input, "{bucket}:{trimmedDisplayName}:{nonce}");
  assert.equal(proof.challenge, `${bucket}:${name}`);
  assert.equal(proof.bucket, bucket);
  assert.deepEqual(proof.acceptBuckets, [bucket - 1, bucket, bucket + 1]);
  assert.equal(proof.windowMs, IDENTITY_POW_WINDOW_MS);
  assert.equal(proof.nonce, "^[A-Za-z0-9_-]{1,43}$");
  assert.deepEqual(proof.resend, { method: "POST", fields: ["displayName", "proof"] });
}

function nonceFromProof(proof, displayName) {
  const name = displayName.trim();
  const pattern = new RegExp(proof.nonce);
  for (let i = 0; i < 200_000; i++) {
    const nonce = i.toString(36);
    if (!pattern.test(nonce)) continue;
    const material = proof.input
      .replaceAll("{bucket}", String(proof.bucket))
      .replaceAll("{trimmedDisplayName}", name)
      .replaceAll("{nonce}", nonce);
    const hex = createHash(proof.hash).update(material).digest(proof.encoding);
    if (typeof hex === "string" && hex.startsWith(proof.prefix)) return nonce;
  }
  throw new Error("proof body did not yield a nonce");
}

test("anonymous mints are budgeted per address and per network", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const store = openStore({ after: () => {} }, () => now);
  try {
    const ids = mint(store, { addressDailyLimit: 1, networkDailyLimit: 2 });
    const first = ids.create("Addr One", anon("198.51.100.1"));
    assert.match(first.secret, /^pri_/);
    const sameAddress = refusal(() => ids.create("Addr Two", anon("198.51.100.1")));
    assert.equal(sameAddress.status, 429);
    assert.equal(sameAddress.code, "rate_limited");
    assert.match(sameAddress.message, /address budget/);
    assert.equal(countOf(store), 1);
    const other = ids.create("Addr Three", anon("198.51.101.4"));
    assert.equal(other.displayName, "Addr Three");

    const networked = mint(store, { addressDailyLimit: 10, networkDailyLimit: 2 });
    networked.create("Net One", anon("203.0.113.1"));
    networked.create("Net Two", anon("203.0.113.2"));
    const crowded = refusal(() => networked.create("Net Three", anon("203.0.113.3")));
    assert.equal(crowded.status, 429);
    assert.match(crowded.message, /network budget/);
    const nextNetwork = networked.create("Net Four", anon("203.0.114.1"));
    assert.equal(nextNetwork.displayName, "Net Four");

    const v6 = mint(store, { networkDailyLimit: 1, addressDailyLimit: 10 });
    v6.create("V6 One", anon("2001:db8:1:2::1"));
    const samePrefix = refusal(() => v6.create("V6 Two", anon("2001:db8:1:2::abcd")));
    assert.match(samePrefix.message, /network budget/);
    assert.equal(v6.create("V6 Three", anon("2001:db8:1:3::1")).displayName, "V6 Three");

    const mapped = mint(store, { addressDailyLimit: 1 });
    mapped.create("Mapped", anon("::ffff:192.0.2.10"));
    const mappedAgain = refusal(() => mapped.create("Mapped Two", anon("192.0.2.10")));
    assert.match(mappedAgain.message, /address budget/);

    const unknown = mint(store, { networkDailyLimit: 1, addressDailyLimit: 10 });
    unknown.create("Unknown One", anon("not-an-ip"));
    const unknownTwo = refusal(() => unknown.create("Unknown Two", anon("also-not")));
    assert.match(unknownTwo.message, /network budget/);
  } finally {
    store.close();
  }
});

test("minute and daily budgets stop anonymous mints and leave in-process mints alone", () => {
  let now = Date.parse("2026-06-02T00:00:00Z");
  const store = openStore({ after: () => {} }, () => now);
  try {
    const burst = mint(store, { addressMinuteLimit: 1 });
    burst.create("Minute One", anon("192.0.2.20"));
    const second = refusal(() => burst.create("Minute Two", anon("192.0.2.20")));
    assert.equal(second.status, 429);
    assert.equal(second.code, "rate_limited");
    assert.match(second.message, /Too many identity mints from this address/);
    assert.equal(second.headers["Retry-After"], "60");

  } finally {
    store.close();
  }

  const dailyStore = openStore({ after: () => {} }, () => now);
  try {
    const daily = mint(dailyStore, { anonymousDailyLimit: 1, addressDailyLimit: 10, networkDailyLimit: 10 });
    daily.create("Day One", anon("192.0.2.30"));
    const over = refusal(() => daily.create("Day Two", anon("192.0.2.31")));
    assert.match(over.message, /daily budget/);
    assert.equal(over.headers["Retry-After"], "3600");
    const invited = daily.create("Invited");
    assert.match(invited.secret, /^pri_/);
    assert.equal(stored(dailyStore, invited.identityId).mintAddress, null);
    assert.equal(countOf(dailyStore), 2);

    now += 25 * 60 * 60 * 1000;
    const rolled = daily.create("Day Three", anon("192.0.2.30"));
    assert.equal(rolled.displayName, "Day Three");
    assert.equal(countOf(dailyStore), 3);
  } finally {
    dailyStore.close();
  }
});

test("proof is required after the free quota, and recoverable replay does not spend another slot", () => {
  const now = Date.parse("2026-06-03T00:00:00Z");
  const store = openStore({ after: () => {} }, () => now);
  try {
    const locked = mint(store, { proofFreePerAddress: 0 });
    const missing = refusal(() => locked.create("Needs Proof", anon("198.51.100.20")));
    assert.equal(missing.status, 428);
    assert.equal(missing.code, "proof_required");
    assert.equal(missing.message, "Identity mint proof required");
    assertProofRecipe(missing.detail.proof, "Needs Proof", now);
    const proof = nonceFromProof(missing.detail.proof, "Needs Proof");
    assert.equal(verifyIdentityMintProof("Needs Proof", proof, now), true);
    const minted = locked.create("Needs Proof", anon("198.51.100.20", proof));
    assert.match(minted.secret, /^pri_/);
    let bad = "badnonce";
    for (let i = 0; i < 20 && verifyIdentityMintProof("Needs Proof", bad, now); i++) bad = `badnonce${i}`;
    assert.equal(verifyIdentityMintProof("Needs Proof", bad, now), false);
    const rejected = refusal(() => locked.create("Other Proof", anon("198.51.100.21", bad)));
    assert.equal(rejected.status, 428);
    assert.equal(rejected.code, "proof_required");

    const free = mint(store, { proofFreePerAddress: 1, addressDailyLimit: 10 });
    free.create("Free One", anon("198.51.100.40"));
    const second = refusal(() => free.create("Free Two", anon("198.51.100.40")));
    assert.equal(second.status, 428);
    free.create("Free Two", anon("198.51.100.40", solveOnServer("Free Two", now)));

    const enrolled = mint(store, { proofFreePerAddress: 0 });
    const curl = enrolled.create("Curl Guest", { anonymous: { address: "198.51.100.50", requireProof: false } });
    assert.match(curl.secret, /^pri_/);
  } finally {
    store.close();
  }

  const replayStore = openStore({ after: () => {} }, () => now);
  try {
    const replay = mint(replayStore, { anonymousDailyLimit: 1, proofFreePerAddress: 5 });
    const secret = `pri_${"c".repeat(43)}`;
    const saved = replay.create("Saved Name", { secret, anonymous: { address: "198.51.100.60" } });
    assert.equal(saved.duplicate, false);
    const again = replay.create("Saved Name", { secret, anonymous: { address: "198.51.100.60" } });
    assert.equal(again.duplicate, true);
    assert.equal(again.identityId, saved.identityId);
    const otherSecret = refusal(() => replay.create("Someone Else", {
      secret: `pri_${"d".repeat(43)}`,
      anonymous: { address: "198.51.100.61" },
    }));
    assert.equal(otherSecret.status, 429);
    assert.match(otherSecret.message, /daily budget/);
  } finally {
    replayStore.close();
  }
});

test("anonymous identities that never activate expire; auth, link, and post keep them", async () => {
  const now = Date.parse("2026-06-04T00:00:00Z");
  const store = openStore({ after: () => {} }, () => now);
  try {
    const ids = mint(store);
    const owner = store.issueAccessKey("commons", "owner");
    const stale = ids.create("Stale", anon("203.0.113.10"));
    const authed = ids.create("Authed", anon("203.0.113.11"));
    const linked = ids.create("Linked", anon("203.0.113.12"));
    const posted = ids.create("Posted", anon("203.0.113.13"));
    const quiet = ids.create("Quiet Read", anon("203.0.113.14"));
    const internal = ids.create("Internal");
    store.transaction(() => ids.noteActivated(authed.identityId));
    ids.link(owner, "commons", { identityId: linked.identityId, permissions: [] });
    ids.link(owner, "commons", { identityId: posted.identityId, permissions: [] });
    store.db.prepare("UPDATE agent_identities SET activated_at=NULL WHERE identity_id IN (?, ?)").run(linked.identityId, posted.identityId);
    setTier(store.db, "commons", posted.identityId, "t2_standard", { updatedBy: "owner", nowMs: now });
    store.command(posted.secret, "commons", {
      id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: "still here" },
    });
    assert.equal(stored(store, posted.identityId).activatedAt, now);

    store.readTransaction(() => {
      assert.ok(ids.resolveGlobalIdentitySecret(quiet.secret));
    });
    assert.equal(stored(store, quiet.identityId).activatedAt, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stored(store, quiet.identityId).activatedAt, now);

    const old = now - 8 * DAY;
    store.db.prepare("UPDATE agent_identities SET created_at=? WHERE identity_id IN (?, ?, ?, ?, ?)")
      .run(old, stale.identityId, authed.identityId, linked.identityId, quiet.identityId, internal.identityId);
    store.db.prepare("UPDATE agent_identities SET activated_at=NULL WHERE identity_id=?").run(internal.identityId);
    assert.equal(ids.expireInactive(), 1);
    assert.equal(stored(store, stale.identityId), undefined);
    for (const kept of [authed, linked, posted, quiet, internal]) assert.ok(stored(store, kept.identityId), kept.displayName);
    assert.equal(stored(store, internal.identityId).mintAddress, null);
  } finally {
    store.close();
  }
});

test("cleanup keeps a membership, an invite, or a pending claim", () => {
  const now = Date.parse("2026-06-06T00:00:00Z");
  const store = openStore({ after: () => {} }, () => now);
  try {
    const ids = mint(store);
    const made = name => ids.create(name, anon("198.51.100.70"));
    const seat = made("Guest Seat");
    const guestRedeemed = made("Guest Redeemed");
    const invitee = made("Invitee");
    const minter = made("Minter");
    const revokedMinter = made("Revoked Minter");
    const referred = made("Referred");
    const claimed = made("Claimed");
    const legacyClaim = made("Legacy Claim");
    const finished = made("Finished Claim");
    const roomClaim = made("Room Claim");
    const released = made("Released Claim");
    const bare = made("Bare");
    const old = now - 8 * DAY;
    const kept = [seat, guestRedeemed, invitee, minter, referred, claimed, legacyClaim, roomClaim];
    const dropped = [revokedMinter, finished, released, bare];
    store.transaction(() => {
      store.db.prepare("UPDATE agent_identities SET created_at=? WHERE identity_id IN (" + [...kept, ...dropped].map(() => "?").join(",") + ")")
        .run(old, ...[...kept, ...dropped].map(row => row.identityId));
      store.db.prepare(`INSERT INTO guest_invites(
        id, code_hash, room_id, tier, credential_ttl_ms, guest_label, minted_by_member_id,
        issue_request_id, created_at, redeem_by, status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        "gi-seat", "a".repeat(64), "commons", "observer", GUEST_CREDENTIAL_TTL_MIN_MS, "Seat", "owner",
        "req-seat", old, old + GUEST_CREDENTIAL_TTL_MIN_MS, "active"
      );
      store.db.prepare(`INSERT INTO guest_members(member_id, room_id, guest_identity_id, tier, invite_id, created_at)
        VALUES(?,?,?,?,?,?)`).run("gm-seat", "commons", seat.identityId, "observer", "gi-seat", old);
      store.db.prepare(`INSERT INTO guest_invites(
        id, code_hash, room_id, tier, credential_ttl_ms, guest_label, minted_by_member_id,
        issue_request_id, created_at, redeem_by, status, redeemed_by_identity_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "gi-redeem", "b".repeat(64), "commons", "observer", GUEST_CREDENTIAL_TTL_MIN_MS, "Redeemed", "owner",
        "req-redeem", old, old + GUEST_CREDENTIAL_TTL_MIN_MS, "redeemed", guestRedeemed.identityId
      );
      const invite = store.db.prepare(`INSERT INTO agent_invite_codes(
        code_hash, room_id, created_by, permissions_json, created_at, expires_at, redeemed_at, redeemed_identity_id, revoked_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`);
      invite.run("c".repeat(64), "commons", "owner", "[]", old, old + DAY, old, invitee.identityId, null);
      invite.run("d".repeat(64), "commons", minter.identityId, "[]", old, old + DAY, null, null, null);
      invite.run("e".repeat(64), "commons", revokedMinter.identityId, "[]", old, old + DAY, null, null, old);
      store.db.prepare(`INSERT INTO referral_invites(
        jti, room_id, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at, status, redeemed_identity_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        "jti-referred", "commons", "chain", "owner", 0, 1, old, old + DAY, "redeemed", referred.identityId
      );
      const claim = store.db.prepare("INSERT INTO work_claims(room_id, claim_id, item_json, updated_at) VALUES(?,?,?,?)");
      claim.run("commons", "held", JSON.stringify(encodeRow("work-claim", { id: "held", state: "claimed", owner: claimed.identityId })), old);
      claim.run("commons", "legacy", JSON.stringify({ id: "legacy", state: "in_progress", owner: legacyClaim.identityId }), old);
      claim.run("commons", "finished", JSON.stringify(encodeRow("work-claim", { id: "finished", state: "done", owner: finished.identityId })), old);
      claim.run("commons", "empty", JSON.stringify(encodeRow("work-claim", { id: "empty", state: "claimed", owner: null })), old);
      const projection = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
      projection.workItems = {
        ...(projection.workItems ?? {}),
        "wi-held": { id: "wi-held", claim: { holderId: roomClaim.identityId, status: "active", expiresAt: "2099-01-01T00:00:00.000Z" } },
        "wi-released": { id: "wi-released", claim: { holderId: released.identityId, status: "released" } },
      };
      store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(projection));
    });
    assert.equal(ids.expireInactive(), dropped.length);
    for (const row of kept) assert.ok(stored(store, row.identityId), row.displayName);
    for (const row of dropped) assert.equal(stored(store, row.identityId), undefined, row.displayName);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_invite_codes").get().n, 3);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM work_claims").get().n, 4);
  } finally {
    store.close();
  }
});

test("closing the store drops a deferred activation instead of throwing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "identity-mint-close-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    store.initialize(initialRoom("commons"));
    const created = mint(store).create("Late Close", anon("198.51.100.9"));
    store.readTransaction(() => {
      assert.ok(store.identities.resolveGlobalIdentitySecret(created.secret));
    });
    store.close();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("llms.txt and agents.json name the identity mint proof recipe", () => {
  const packet = llmsTxt();
  const agents = JSON.stringify(agentsJson());
  for (const text of [packet, agents]) {
    assert.match(text, /428 proof_required/);
    assert.match(text, /\{bucket\}:\{trimmedDisplayName\}:\{nonce\}/);
    assert.match(text, /proof\.prefix/);
    assert.match(text, /proof\.acceptBuckets/);
  }
});

test("HTTP mint accepts a quiet signup, then requires proof and enforces the address budget", async t => {
  const directory = mkdtempSync(join(tmpdir(), "identity-mint-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(data),
  });

  const created = await post("/api/agent-identities", { displayName: "Quiet Agent" });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.match(body.secret, /^pri_/);
  assert.ok(store.identities.resolveGlobalIdentitySecret(body.secret));
  assert.equal(typeof stored(store, body.identityId).activatedAt, "number");
  const aged = store.identities.create("Aged Out", anon("203.0.113.80"));
  store.db.prepare("UPDATE agent_identities SET created_at=? WHERE identity_id=?").run(store.now() - 8 * DAY, aged.identityId);
  assert.equal(store.identities.expireInactive(), 1);
  assert.equal(stored(store, aged.identityId), undefined);
  assert.ok(stored(store, body.identityId));

  const buckets = anonymousMintBuckets("127.0.0.1");
  const insert = store.db.prepare(
    "INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at,mint_address,mint_network) VALUES(?,?,?,?,?,?)"
  );
  const seed = (n, createdAt) => {
    store.transaction(() => {
      for (let i = 0; i < n; i++) {
        insert.run(`ai_${randomUUID().replaceAll("-", "")}`, `seed-${randomUUID()}`, "Seed", createdAt, buckets.address, buckets.network);
      }
    });
  };
  seed(7, store.now() - 120_000);
  const malformed = await post("/api/agent-identities", { displayName: "Bad Proof", proof: "!!" });
  assert.equal(malformed.status, 422);
  assert.equal((await malformed.json()).error.code, "invalid_identity");
  const challenged = await post("/api/agent-identities", { displayName: "Needs Proof" });
  assert.equal(challenged.status, 428);
  const challenge = await challenged.json();
  assert.equal(challenge.error.code, "proof_required");
  assert.equal(challenge.error.message, "Identity mint proof required");
  assert.equal(challenge.reason, "proof_required");
  assert.equal(challenge.category, "input");
  assert.ok(challenge.hint);
  assert.ok(challenge.next.length > 0);
  assert.equal(challenge.hint, "Resend displayName with proof. See proof.");
  assertProofRecipe(challenge.proof, "Needs Proof", store.now());
  const proved = await post("/api/agent-identities", {
    displayName: "Needs Proof",
    proof: nonceFromProof(challenge.proof, "Needs Proof"),
  });
  assert.equal(proved.status, 201);

  seed(12, store.now() - 120_000);
  const limited = await post("/api/agent-identities", {
    displayName: "Over Address",
    proof: solveOnServer("Over Address", store.now()),
  });
  assert.equal(limited.status, 429);
  const limitedBody = await limited.json();
  assert.equal(limitedBody.error.code, "rate_limited");
  assert.match(limitedBody.error.message, /address budget/);
  assert.equal(limitedBody.category, "rate_limited");
  const joined = await post("/api/join", {
    displayName: "Join Over Address",
    proof: solveOnServer("Join Over Address", store.now()),
  });
  assert.equal(joined.status, 429);
  assert.match((await joined.json()).error.message, /address budget/);
});

test("browser and CLI proofs satisfy the server verifier", async () => {
  assert.equal(IDENTITY_MINT_POW_BITS, IDENTITY_POW_BITS);
  assert.equal(CLI_POW_BITS, IDENTITY_POW_BITS);
  assert.equal(IDENTITY_MINT_POW_WINDOW_MS, IDENTITY_POW_WINDOW_MS);
  assert.equal(CLI_POW_WINDOW_MS, IDENTITY_POW_WINDOW_MS);
  const now = Date.parse("2026-06-05T03:00:00Z");
  const name = "Proof Lock";
  const browser = await solveInBrowser(name, now);
  const cli = solveInCli(name, now);
  assert.equal(verifyIdentityMintProof(name, browser, now), true);
  assert.equal(verifyIdentityMintProof(name, cli, now), true);
  assert.equal(browser, cli);
});
