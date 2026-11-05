// CONTEXT-FIX adversarial item (iii) — J-25 EFFECT-PREVENTION closure, with
// the sweep-14 E2 amendments (coordinator STATE.md, "J-25 closure
// criterion" + "Amendments").
// LANE-11 REWORK of lane 09's file (lane 10 PROBE.md findings C1 + C2):
// every API below is the pin's real shape, verified at pin
// 8c9deff7534ed549df88b730c03af2d9d3a11db8 by object-store reads:
//   - Owner-delegate grant/revoke are OwnerDelegates class methods
//     (server/owner-delegates.mjs:64 grant(token, roomId, { identityId }),
//     :99 revoke) reached through the store handle (store.ownerDelegates,
//     server/store.mjs:1443). guest-agent-links.mjs exports no
//     grantOwnerDelegate / revokeOwnerDelegate and GuestAgentLinks has no
//     mintForDelegate method.
//   - Minting is GuestInvites.mint(token, roomId, details, binding)
//     (server/guest-invites.mjs:471) through store.guestInvites
//     (store.mjs:1471); its issued shape carries inviteId + code
//     (guest-invites.mjs:543), not a minted.id.
//   - The server entry is the repo-root server.mjs (package.json
//     "start": "node server.mjs"); its real env names come from
//     server/deployment.mjs:22-34 (HOST, PORT, ROOM_ORIGIN, ROOM_DB).
//   - Revocation targets the GUEST (CURE-PLAN §iii): the guest is
//     disconnected via GuestInvites.disconnect(token, roomId, memberId)
//     (guest-invites.mjs:771), which deactivates the seat and — through
//     the MEMBER_ACCESS_CHANGED command it issues — revokes the member's
//     credentials rows (server/store.mjs, command(): credentials
//     revoked=1 on active=false). Revoking the delegate's GRANT instead
//     would leave the ga1. credential live: OwnerDelegates.revoke
//     (owner-delegates.mjs:99-118) only stamps revoked_at + journals.
//     The disconnect caller is the delegate: disconnect's ownerGate
//     (guest-invites.mjs:314-326) admits an account session or a
//     delegate, and the fixture owner is an agent identity whose pri_
//     authenticates with account:null by construction (store.mjs pri_
//     branch), so the owner cannot call it; the delegate is therefore
//     linked with manage_members so the disconnect's inner store.command
//     passes the reducer's manage_members requirement
//     (src/events.js changeMemberAccess).
//
//   1. Single-parent invariant: the parentage of every ga1. fixture row is
//      recorded and asserted (issuance: guest_invites + guest_invite_
//      authority; holder: guest_members seat + credentials rows). At the pin
//      GX-derived rows are single-parent by construction (member_id PK,
//      UNIQUE(room_id, guest_identity_id), deterministic member id, no
//      credentials rebind path). Legacy ga1. rows with no guest_members row
//      are graded INEXACT for the tree model — none are used here.
//   2. Decision-reason receipts: a denial without a committed
//      decision_reason grades NOT-RUN. At the pin the product commits no
//      decision_reason for credential denials, so that leg is a registered
//      skip (NOT-RUN) — never a pass.
//   3. Enforcement-point arm: post-revocation denial is proven by executed
//      HTTP calls presenting the credentials to the live check
//      (POST /api/rooms/:roomId/commands), not by store records alone.
//
// Scenario (lane 07 REPRO.md §5 coordinates): owner grants a delegate; the
// delegate mints a guest invite (the R2-cured path); a guest redeems it and
// holds a ga1. pass; the guest is then DISCONNECTED (revoked) — afterwards
// BOTH credential types — the ga1. pass and the guest identity's pri_
// secret — must be denied at the enforcement point AND commit no effect
// (head sequence + event count unchanged).
//
// pri_ positive control (C2 rework, with a pin-evidence caveat): a guest
// identity's pri_ never resolves to the guest seat on the commands route —
// authenticate resolves pri_ only through identity_links
// (server/agent-identities.mjs:1417-1426) and redemption creates no
// identity_links row — so no commands-route call with pri_ can succeed
// before revocation either; a commands-route positive control for pri_ is
// impossible at the pin. The control is therefore placed where pri_
// actually commits effects: the redemption itself, which is pri_-
// authenticated and created the seat + ga1. credential (sequence advance
// and rows asserted in the positive-control test). The post-revocation
// pri_ leg still asserts denial + no effect at the enforcement point.
//
// FAIL-on-main: the delegate mint dies 409 at the pin (R2), so setup fails.
// ALL RESULTS ARE NOT-RUN until an execution lane runs this file in a
// checkout at the cured head (lane 11 fixed executability at source level
// only). Copy into tests/ to run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.LANE11_EP_PORT ?? "18979";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOM_ID = "effect-room";

let server, store, fx;

async function commands(token, id, body) {
  const response = await fetch(`${ORIGIN}/api/rooms/${ROOM_ID}/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify({ id, type: "message.posted", data: { messageId: id, body } }),
  });
  return response.status;
}

const effectSnapshot = () => ({
  sequence: store.headSequence(ROOM_ID),
  events: store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=?").get(ROOM_ID).n,
});

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "lane11-effect-"));
  const dataFile = join(dir, "project-room.sqlite");
  let serverLog = "";
  server = spawn(process.execPath, [join(repoRoot, "server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env, NODE_ENV: "development", ROOM_DEPLOYMENT: "",
      ROOM_DB: dataFile, HOST: "127.0.0.1", PORT, ROOM_ORIGIN: ORIGIN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (chunk) => { serverLog += chunk; });
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try { up = (await fetch(`${ORIGIN}/api/health`)).ok; }
    catch { /* not up yet */ }
    if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!up) throw new Error(`server did not come up: ${serverLog.slice(-2000)}`);
  store = new RoomStore(dataFile);
  // D1b execution correction (pin-verified): the filed fixture created the
  // room through AgentRooms, whose owner member is kind "agent"
  // (server/agent-rooms.mjs MEMBER_ADDED kind:"agent"), and redemption then
  // dies on ANY head at the reducer's sponsor rule — MEMBER_ADDED requires
  // accountableHumanId to be a human member (src/events.js), and for a
  // delegate-minted invite that id is the granting owner. GX rooms are
  // human-owned by design (the ownerGate trust anchor), so the fixture room
  // is the bootstrap room (owner kind "human", server/bootstrap.mjs) at the
  // current representation, with the owner acting through a member access
  // key. FAIL-on-main is unchanged: setup still dies at the delegate mint.
  store.initialize(initialRoom(ROOM_ID), { representation: "normalized-current-v1" });
  const owner = { secret: store.issueAccessKey(ROOM_ID, "owner") };
  // Fixture sanity: the room really is current-format, so a pass/fail below
  // is about the format path, not a legacy-room accident.
  assert.ok(
    store.db.prepare("SELECT 1 FROM current_room_head WHERE room_id=?").get(ROOM_ID),
    "fixture room must be current-format (current_room_head row present)",
  );
  const delegate = store.identities.create("Effect Delegate");
  linkWithProof(store, owner.secret, ROOM_ID, delegate, {
    displayName: "Effect Delegate", permissions: ["manage_members"],
  });
  store.ownerDelegates.grant(owner.secret, ROOM_ID, { identityId: delegate.identityId });
  const authority = store.roomAuthority(ROOM_ID);
  const minted = store.guestInvites.mint(delegate.secret, ROOM_ID, {
    requestId: randomUUID(), guestLabel: "Effect visit",
    expectedOwnerRevision: authority.members[authority.ownerId].revision,
  });
  assert.ok(minted.inviteId && typeof minted.code === "string"
    && minted.code.startsWith("GX-"), "delegate mint returns inviteId + GX- code");
  const guest = store.identities.create("Effect Guest");
  const keys = generateKeyPair();
  const cardBody = { name: "Effect Guest", description: "visiting agent", capabilities: ["chat"] };
  const card = {
    ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: guest.identityId, card: cardBody, privateKey: keys.privateKey }),
  };
  // The redemption is the pri_-authenticated effect: it creates the guest
  // seat and issues the derived ga1. credential. Sequence is captured
  // around it so the pri_ positive control can assert the effect landed.
  const sequenceBeforeRedeem = store.headSequence(ROOM_ID);
  const redeemed = store.guestInvites.redeem(minted.code, guest.secret, card);
  const sequenceAfterRedeem = store.headSequence(ROOM_ID);
  fx = { owner, delegate, guest, minted, redeemed, sequenceBeforeRedeem, sequenceAfterRedeem };
});

after(() => { server?.kill("SIGTERM"); store?.close?.(); });

test("parentage record: every ga1. fixture row is single-parent (amendment 1)", () => {
  const memberId = fx.redeemed.member.id;
  const seat = store.db.prepare(
    "SELECT * FROM guest_members WHERE member_id=?").get(memberId);
  assert.ok(seat, "seat row exists");
  assert.equal(seat.guest_identity_id, fx.guest.identityId);
  assert.equal(seat.invite_id, fx.minted.inviteId, "issuance parent is the minted invite");
  const authority = store.db.prepare(
    "SELECT * FROM guest_invite_authority WHERE invite_id=?").get(fx.minted.inviteId);
  assert.ok(authority, "authority provenance row exists");
  assert.equal(authority.minted_via_delegate, 1);
  const seats = store.db.prepare(
    "SELECT count(*) AS n FROM guest_members WHERE room_id=? AND guest_identity_id=?",
  ).get(ROOM_ID, fx.guest.identityId);
  assert.equal(seats.n, 1, "exactly one seat per (room, identity)");
  const credentials = store.db.prepare(
    "SELECT member_id, kind, revoked FROM credentials WHERE room_id=? AND member_id=?",
  ).all(ROOM_ID, memberId);
  assert.ok(credentials.length >= 1);
  assert.ok(credentials.every((row) => row.member_id === memberId),
    "every credential row is held by the one seat member");
});

test("positive control: the ga1. pass commits an effect before revocation", async () => {
  const beforeFx = effectSnapshot();
  const status = await commands(fx.redeemed.token, "pre-revocation-post", "guest pass works");
  assert.ok(status >= 200 && status < 300, `expected success, got ${status}`);
  assert.equal(effectSnapshot().sequence, beforeFx.sequence + 1);
});

test("positive control: the pri_ secret committed an effect before revocation (the redemption)", () => {
  // pri_ cannot post to the commands route at any time (see header: it
  // resolves only through identity_links, and redemption creates none), so
  // its positive control is the pri_-authenticated redemption in before():
  // it advanced the room sequence and created the seat + ga1. credential
  // rows asserted in the parentage test.
  assert.ok(fx.sequenceAfterRedeem > fx.sequenceBeforeRedeem,
    "redemption committed at least one event");
  assert.ok(store.identities.resolveGlobalIdentitySecret(fx.guest.secret),
    "the pri_ secret is a live identity credential");
  const credential = store.db.prepare(
    "SELECT revoked FROM credentials WHERE room_id=? AND member_id=? AND kind='access'",
  ).get(ROOM_ID, fx.redeemed.member.id);
  assert.equal(credential.revoked, 0, "the derived ga1. credential is live before revocation");
});

test("effect prevention: after the guest is disconnected both credential types are denied and commit no effect (amendment 3)", async () => {
  // Revoke the GUEST, not the delegate grant (C2): disconnect deactivates
  // the seat and revokes its credentials rows at the store command layer.
  const result = store.guestInvites.disconnect(
    fx.delegate.secret, ROOM_ID, fx.redeemed.member.id);
  assert.equal(result.disconnected, true);
  const credential = store.db.prepare(
    "SELECT revoked FROM credentials WHERE room_id=? AND member_id=? AND kind='access'",
  ).get(ROOM_ID, fx.redeemed.member.id);
  assert.equal(credential.revoked, 1, "supporting evidence: ga1. row revoked in the store");
  const snapshot = effectSnapshot();
  const gaStatus = await commands(fx.redeemed.token, "post-revocation-ga", "must not land");
  assert.ok(gaStatus === 401 || gaStatus === 403, `ga1. denied at enforcement point, got ${gaStatus}`);
  const priStatus = await commands(fx.guest.secret, "post-revocation-pri", "must not land");
  assert.ok(priStatus === 401 || priStatus === 403, `pri_ denied at enforcement point, got ${priStatus}`);
  assert.deepEqual(effectSnapshot(), snapshot, "denied calls committed no effect");
});

test("decision-reason receipt for the denial (amendment 2)",
  // At the pin (and at the cured head — the cure adds no receipts) a denial
  // carries no committed decision_reason, so this leg grades NOT-RUN by the
  // amended criterion. Registered as an unconditional skip, never a pass.
  { skip: "no committed decision_reason exists for credential denials at this head — grades NOT-RUN per amendment 2" },
  () => { assert.fail("decision-reason leg must never pass without a committed decision_reason"); });
