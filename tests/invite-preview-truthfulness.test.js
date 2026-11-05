// FUNNEL-FIXES pack 4 (wave-2700 lane-04, probe lane-09 PASS with R1-R5):
// invite-preview false-410 cure. A live RM- agent invite presented to the
// share-links preview door must get a truthful 422 wrong-door answer (shape
// only, byte-identical for live/dead/fabricated codes), genuine share-link
// previews must name their own dead state, and join/admission answers must
// stay byte-identical to the pin (folded 410 link_unavailable).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { llmsFullTxt, kitsTxt } from "../server/agent-discovery.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-invite-preview-"));
  let now = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const makeLink = (overrides = {}) => {
    const linkToken = randomBytes(32).toString("base64url");
    const created = store.shareLinks.create(ownerKey, "commons",
      { requestId: randomUUID(), linkToken, expiresAt: now + 3600000, maxJoins: 2, expectedMemberRevision: 0, ...overrides }, null);
    return { linkToken, created };
  };
  const guestJoin = (linkToken, name = "Guest") => {
    const slot = store.createAccountSessionSlot();
    const current = store.accountSessionSlot(slot.token);
    const joined = store.shareLinks.join(slot.token, linkToken, { displayName: name, redemptionId: randomUUID(),
      expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
    return { slot, joined };
  };
  return { store, ownerKey, makeLink, guestJoin, setNow: v => { now = v; }, now: () => now };
}

const codeOf = error => error && error.code;
const FABRICATED_RM = "RM-0123456789ABCDEF"; // Crockford-valid shape, never issued

test("1. live agent invite at the share-links door: 422 wrong-kind, correct door truthful, preview consumes nothing", t => {
  const f = fixture(t);
  const minted = f.store.invites.create(f.ownerKey, "commons", { profile: "collaborate" }, null);
  for (const presented of [minted.code, `https://room.trydemigod.com/a/${minted.code}`, `#agent-invite/${minted.code}`]) {
    assert.throws(() => f.store.shareLinks.preview(presented),
      error => error.status === 422 && error.code === "wrong_link_kind_agent_invite" && /\/api\/agent-invites\/preview/.test(error.message)
        && !JSON.stringify(error).includes("commons"));
  }
  const preview = f.store.invites.preview(minted.code);
  assert.equal(preview.roomId, "commons");
  assert.equal(preview.profile, "collaborate");
  const joined = f.store.invites.redeem(minted.code, { displayName: "Invitee" });
  assert.equal(joined.roomId, "commons");
});

test("2. dead agent-invite states keep their own signals at the correct door", t => {
  const f = fixture(t);
  const revoked = f.store.invites.create(f.ownerKey, "commons", { profile: "chat" }, null);
  f.store.invites.revoke(f.ownerKey, "commons", revoked.inviteId ?? revoked.id, null);
  assert.throws(() => f.store.invites.preview(revoked.code), e => e.status === 410 && codeOf(e) === "invite_revoked");
  const expiring = f.store.invites.create(f.ownerKey, "commons", { profile: "chat", expiresInMinutes: 5 }, null);
  f.setNow(f.now() + 6 * 60000);
  assert.throws(() => f.store.invites.preview(expiring.code), e => e.status === 410 && codeOf(e) === "invite_expired");
  f.setNow(f.now() - 6 * 60000);
  const used = f.store.invites.create(f.ownerKey, "commons", { profile: "chat" }, null);
  f.store.invites.redeem(used.code, { displayName: "First" });
  assert.throws(() => f.store.invites.preview(used.code), e => e.status === 409 && codeOf(e) === "invite_already_used");
  assert.throws(() => f.store.invites.preview(FABRICATED_RM), e => e.status === 404 && codeOf(e) === "invite_unavailable");
});

test("3. dead share-link states return their own preview signals; active member recovery still works", t => {
  const f = fixture(t);
  const cancelled = f.makeLink();
  f.store.shareLinks.cancel(f.ownerKey, "commons", cancelled.created.link.id, null);
  assert.throws(() => f.store.shareLinks.preview(cancelled.linkToken), e => e.status === 410 && codeOf(e) === "link_cancelled");
  const expired = f.makeLink({ expiresAt: f.now() + 1000 });
  f.setNow(f.now() + 2000);
  assert.throws(() => f.store.shareLinks.preview(expired.linkToken), e => e.status === 410 && codeOf(e) === "link_expired");
  f.setNow(f.now() - 2000);
  const full = f.makeLink({ maxJoins: 1 });
  f.guestJoin(full.linkToken, "Only");
  assert.throws(() => f.store.shareLinks.preview(full.linkToken), e => e.status === 410 && codeOf(e) === "link_full");
  const authority = f.makeLink();
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "owner", expectedMemberRevision: 0, permissions: f.store.room("commons").state.members.owner.permissions, active: true } });
  assert.throws(() => f.store.shareLinks.preview(authority.linkToken), e => e.status === 410 && codeOf(e) === "link_authority_changed");
  assert.throws(() => f.store.shareLinks.preview(randomBytes(32).toString("base64url")), e => e.status === 404 && codeOf(e) === "link_not_found");
  assert.throws(() => f.store.shareLinks.preview("not-a-link"), e => e.status === 422 && codeOf(e) === "invalid_link");
  // Existing-member recovery: a member of the room may still preview a dead link.
  const member = f.guestJoin(f.makeLink({ expectedMemberRevision: 1 }).linkToken, "Member");
  const slotNow = f.store.accountSessionSlot(member.slot.token);
  const recovered = f.store.shareLinks.preview(cancelled.linkToken, member.slot.token, slotNow.sessionBinding);
  assert.equal(recovered.link.status, "cancelled");
});

test("4. no regression: live share link previews, joins, and join doors stay folded", t => {
  const f = fixture(t);
  const { linkToken } = f.makeLink();
  const before = f.store.shareLinks.preview(linkToken);
  assert.equal(before.link.remainingJoins, 2);
  const identity = f.store.identities.create("Joiner");
  const joined = f.store.shareLinks.joinAgent(identity.secret, linkToken, "Joiner");
  assert.equal(joined.roomId, "commons");
  assert.equal(f.store.shareLinks.preview(linkToken).link.remainingJoins, 1);
  const dead = f.makeLink();
  f.store.shareLinks.cancel(f.ownerKey, "commons", dead.created.link.id, null);
  assert.throws(() => f.store.shareLinks.joinAgent(f.store.identities.create("Late").secret, dead.linkToken, "Late"),
    e => e.status === 410 && codeOf(e) === "link_unavailable");
  assert.throws(() => f.store.shareLinks.joinAgent(identity.secret, randomBytes(32).toString("base64url"), "Nobody"),
    e => e.status === 410 && codeOf(e) === "link_unavailable");
  // An RM-shaped input at a join door keeps the pin's folded 410 (probe R3):
  // the 422 gate lives in the preview path only.
  const minted = f.store.invites.create(f.ownerKey, "commons", { profile: "chat" }, null);
  assert.throws(() => f.store.shareLinks.joinAgent(identity.secret, minted.code, "Wrong door"),
    e => e.status === 410 && codeOf(e) === "link_unavailable");
});

test("5. negative control: fabricated RM code gets the identical 422; no room data anywhere", t => {
  const f = fixture(t);
  const minted = f.store.invites.create(f.ownerKey, "commons", { profile: "chat" }, null);
  const grab = value => { try { f.store.shareLinks.preview(value); } catch (e) { return { status: e.status, code: e.code, message: e.message }; } throw new Error("no throw"); };
  assert.deepEqual(grab(FABRICATED_RM), grab(minted.code));
  // Probe R2 shapes: a legacy 8-symbol code containing 8/9/U and a v2 code
  // written with confusables (I/L/O fold to 1/1/0) classify identically.
  assert.deepEqual(grab("RM-ABCDEFG8"), grab(minted.code));
  assert.deepEqual(grab("RM-O123456789ABCDEI"), grab(minted.code));
  assert.throws(() => f.store.shareLinks.preview(randomBytes(32).toString("base64url")),
    e => e.status === 404 && !/commons/.test(e.message));
});

test("6. packet documents /a/ and the reconciled URL wording", t => {
  const full = llmsFullTxt(), kits = kitsTxt();
  assert.ok(full.includes("/a/RM-"), "llms-full join guidance names the /a/ form");
  assert.ok(full.includes("/api/agent-invites/preview"), "llms-full routes RM codes to the agent-invite door");
  assert.ok(kits.includes("/a/RM-"), "kits join guidance names the /a/ form");
  const f = fixture(t);
  const minted = f.store.invites.create(f.ownerKey, "commons", { profile: "chat" }, null);
  const descriptions = (minted.next ?? []).map(step => step.description ?? "").join("\n");
  assert.ok(descriptions.includes("never in a query string"), "create next steps carry the reconciled wording");
  assert.ok(!/never put the code in a URL/.test(descriptions), "unqualified URL ban is gone");
});

test("7. HTTP envelope: 422 byte-identical for live, revoked and fabricated RM codes (no oracle)", async t => {
  const f = fixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const preview = async linkToken => {
    const res = await fetch(`${origin}/api/share-links/preview`, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ linkToken }) });
    return { status: res.status, text: await res.text() };
  };
  const live = f.store.invites.create(f.ownerKey, "commons", { profile: "chat" }, null);
  const deadMint = f.store.invites.create(f.ownerKey, "commons", { profile: "chat" }, null);
  f.store.invites.revoke(f.ownerKey, "commons", deadMint.inviteId ?? deadMint.id, null);
  const a = await preview(live.code), b = await preview(deadMint.code), c = await preview(FABRICATED_RM);
  assert.equal(a.status, 422);
  // Byte-identical apart from operationId, a random per-request envelope id
  // attached to every response regardless of input — it carries no liveness
  // signal (probe lane-09 claim 3a), so it is normalised out for the compare.
  const strip = text => text.replace(/"operationId":"[^"]+"/, '"operationId":"X"');
  assert.equal(strip(a.text), strip(b.text));
  assert.equal(strip(a.text), strip(c.text));
  assert.ok(a.text.includes("wrong_link_kind_agent_invite"));
  assert.ok(!a.text.includes("commons"));
});
