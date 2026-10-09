import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { agentErrorAx, validAgentNext } from "../src/agent-error.mjs";
import { rmSync } from "node:fs";

// qa200-EP-03 (2026-10-08): POST /api/agent-invites/redeem with a garbage
// invite code returned 404 invite_unavailable, but the hint fell through to
// the unmapped-code branch — "Unknown error 'invite_unavailable'. Re-check
// access..." — sending a stranger down an access wild-goose chase for a
// code-format problem. The 404 message already names the exact recovery; the
// hint must match it.

function assertHint(ax) {
  assert.equal(ax.reason, "invite_unavailable");
  assert.equal(ax.status, "action_required");
  assert.ok(typeof ax.hint === "string" && ax.hint.length > 0 && ax.hint.length < 160, "short hint");
  assert.doesNotMatch(ax.hint, /Unknown error/, "no unmapped-code fallthrough");
  assert.doesNotMatch(ax.hint, /[Rr]e-check access/, "no access wild-goose chase");
  assert.match(ax.hint, /format|typo/i, "names the format problem");
  assert.match(ax.hint, /fresh code|inviter/i, "names the recovery");
  assert.ok(validAgentNext(ax.next), "next[]");
}

test("agentErrorAx: invite_unavailable (format) gets a dedicated hint", () => {
  const ax = agentErrorAx({
    httpStatus: 404,
    code: "invite_unavailable",
    message: "Invite code has the wrong format: invite codes are two letters, a dash, then 16 characters (no I, L, O, or U). Check for typos or ask the inviter for a fresh code"
  });
  assertHint(ax);
});

test("agentErrorAx: invite_unavailable (no invite issued) gets a dedicated hint", () => {
  const ax = agentErrorAx({
    httpStatus: 404,
    code: "invite_unavailable",
    message: "No invite was issued for this code. Ask the inviter for a fresh code"
  });
  assertHint(ax);
});

test("live: redeem garbage invite code -> 404 with dedicated hint (not fallthrough)", async (t) => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agent-invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "QA200-EP03-GARBAGE-xxxx", displayName: "EP03-ghost" })
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "invite_unavailable");
  assertHint({ reason: body.reason, status: body.status, hint: body.hint, next: body.next });
});

// ---------------------------------------------------------------------------
// ch-2064 adversarial challenge (2026-10-08): the dedicated invite_unavailable
// hint fires on EVERY site that emits the code, but names the agent-invite
// code format ("two letters, a dash, then 16 characters") and the agent-invite
// recovery ("ask the inviter for a fresh code"). The same code is emitted for
// guest invites (GX- + 32 chars), guest credentials (ga1. bearer tokens), the
// v1 guest-credential refresh flow ("not this endpoint"), referral invites
// (signed tokens), and the owner invite-revoke handle (a hash prefix, not a
// code). On those paths the hint is actively wrong. These tests are fail-first:
// they FAIL on the pre-fix head and PASS once the branch is scoped per family.
// ---------------------------------------------------------------------------

function assertSane(ax) {
  assert.equal(ax.reason, "invite_unavailable");
  assert.equal(ax.status, "action_required");
  assert.doesNotMatch(ax.hint, /Unknown error/, "no unmapped-code fallthrough");
  assert.doesNotMatch(ax.hint, /[Rr]e-check access/, "no access wild-goose chase");
  assert.ok(validAgentNext(ax.next), "next[]");
}

test("ch-2064 break: guest invite 410 must not name the agent-invite code format", () => {
  // server/guest-invites.mjs preview()/redeem(): guest codes are GX- + 32 chars.
  const ax = agentErrorAx({ httpStatus: 410, code: "invite_unavailable", message: "This guest invite is not valid." });
  assertSane(ax);
  assert.doesNotMatch(ax.hint, /two letters, a dash, then 16 characters/, "guest codes are GX- + 32 chars, not RM- 16-char");
  assert.match(ax.hint, /GX-|guest invite/i, "names the guest recovery");
});

test("ch-2064 break: guest credential 410 must not name the agent-invite code format", () => {
  // server/guest-invites.mjs rotate(): credentials are ga1. bearer tokens.
  const ax = agentErrorAx({ httpStatus: 410, code: "invite_unavailable", message: "This guest credential is not valid." });
  assertSane(ax);
  assert.doesNotMatch(ax.hint, /two letters, a dash, then 16 characters/, "a credential is not an invite code");
  assert.doesNotMatch(ax.hint, /check it for typos against the format/, "no code-format advice for a credential");
});

test("ch-2064 break: v1 guest refresh 410 must not tell the caller to ask for a fresh redeem code", () => {
  // server/guest-agent-links.mjs refresh(): recovery is a refresh through a
  // fresh owner code, NOT redeeming a fresh invite code at this endpoint.
  const ax = agentErrorAx({ httpStatus: 410, code: "invite_unavailable",
    message: "v1 guest-invite credentials refresh through a fresh owner code, not this endpoint." });
  assertSane(ax);
  assert.doesNotMatch(ax.hint, /ask the inviter for a fresh code/, "server says 'not this endpoint' — a fresh redeem code is the wrong recovery");
  assert.match(ax.hint, /owner code|refresh/i, "names the actual recovery");
});

test("ch-2064 break: referral invite 404 must not name the agent-invite code format", () => {
  // server/referral-invites.mjs: signed tokens, not RM- codes.
  const ax = agentErrorAx({ httpStatus: 404, code: "invite_unavailable", message: "That invite is not available" });
  assertSane(ax);
  assert.doesNotMatch(ax.hint, /two letters, a dash, then 16 characters/, "referral tokens are signed payloads, not RM- codes");
  assert.match(ax.hint, /referral/i, "names the referral recovery");
});

test("ch-2064 break: invite-revoke handle 404 must not name the agent-invite code format", () => {
  // server/agent-invites.mjs revoke(): the handle is an inviteId hash prefix,
  // and the caller is the owner — "ask the inviter for a fresh code" is nonsense.
  const ax = agentErrorAx({ httpStatus: 404, code: "invite_unavailable",
    message: "Invite code not found, already used, or already revoked" });
  assertSane(ax);
  assert.doesNotMatch(ax.hint, /two letters, a dash, then 16 characters/, "revoke handles are hash prefixes, not codes");
  assert.doesNotMatch(ax.hint, /ask the inviter for a fresh code/, "the caller IS the owner managing invites");
});

// Claimed-path re-verification (should PASS pre-fix): a well-formed but
// unissued agent code hits the "No invite was issued" 404 end to end.
test("ch-2064: well-formed unissued code redeems to 404 with the dedicated hint (live)", async (t) => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agent-invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "RM-0123456789ABCDEF", displayName: "ch-2064-ghost" })
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "invite_unavailable");
  assert.equal(body.error.message, "No invite was issued for this code. Ask the inviter for a fresh code");
  assertHint({ reason: body.reason, status: body.status, hint: body.hint, next: body.next });
});

// ---------------------------------------------------------------------------
// ch-2064 sibling sweep (2026-10-08): the invite redeem/preview path emits
// four more terminal codes that fell through to the unmapped branch —
// "Unknown error 'invite_expired'. Re-check access..." — the same access
// wild-goose chase #2064 fixed for invite_unavailable, and the expired invite
// is the most common stranger failure of all. join.js already maps these for
// the UI path (joinErrorMessage); the API path (agentErrorAx) had nothing.
// Fail-first: these FAIL on the pre-fix head.
// ---------------------------------------------------------------------------

function assertSiblingHint(ax, code, recoveryRe) {
  assert.equal(ax.reason, code);
  assert.equal(ax.status, "action_required");
  assert.doesNotMatch(ax.hint, /Unknown error/, "no unmapped-code fallthrough");
  assert.doesNotMatch(ax.hint, /[Rr]e-check access/, "no access wild-goose chase");
  assert.ok(ax.hint.length < 160, "short hint");
  assert.match(ax.hint, recoveryRe, "names the recovery");
  assert.ok(validAgentNext(ax.next), "next[]");
}

test("ch-2064 sibling: invite_expired gets a dedicated hint", () => {
  const ax = agentErrorAx({ httpStatus: 410, code: "invite_expired", message: "Invite code expired" });
  assertSiblingHint(ax, "invite_expired", /expired/i);
  assert.match(ax.hint, /fresh|new/i, "expired codes never come back — names the fresh-code recovery");
});

test("ch-2064 sibling: invite_revoked gets a dedicated hint", () => {
  const ax = agentErrorAx({ httpStatus: 410, code: "invite_revoked", message: "Invite code was revoked" });
  assertSiblingHint(ax, "invite_revoked", /revoked/i);
  assert.match(ax.hint, /new|fresh/i, "a revoked code never comes back");
});

test("ch-2064 sibling: invite_already_used gets a dedicated hint", () => {
  const ax = agentErrorAx({ httpStatus: 409, code: "invite_already_used", message: "Invite code was already used" });
  assertSiblingHint(ax, "invite_already_used", /already used|once/i);
  assert.doesNotMatch(ax.hint, /retry/i, "retrying a burned code is futile");
});

test("ch-2064 sibling: invite_authority_changed gets a dedicated hint", () => {
  const ax = agentErrorAx({ httpStatus: 409, code: "invite_authority_changed",
    message: "Inviter authority changed; ask for a new invite code" });
  assertSiblingHint(ax, "invite_authority_changed", /new invite|authority/i);
});
