import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DENIAL_CONTRACTS,
  DENIAL_IDS,
  ERROR_ENVELOPE,
  LINK_UNAVAILABLE
} from "../src/index.js";

test("unavailable causes share one 410 / link_unavailable copy contract", () => {
  assert.equal(LINK_UNAVAILABLE.status, 410);
  assert.equal(LINK_UNAVAILABLE.code, "link_unavailable");
  assert.equal(
    LINK_UNAVAILABLE.message,
    "This link has expired, been cancelled, or reached its join limit. Ask for a new link."
  );
  for (const id of ["cancelled", "expired", "join-cap"]) {
    assert.equal(DENIAL_CONTRACTS[id].status, 410);
    assert.equal(DENIAL_CONTRACTS[id].code, "link_unavailable");
    assert.equal(DENIAL_CONTRACTS[id].message, LINK_UNAVAILABLE.message);
    assert.equal(DENIAL_CONTRACTS[id].hosted, "gap");
  }
  assert.ok(LINK_UNAVAILABLE.collapsedCauses.includes("authority_changed"));
});

test("removed-member contract keeps membership inactive and does not recreate via link", () => {
  const row = DENIAL_CONTRACTS["removed-member"];
  assert.equal(row.accountSession.status, 403);
  assert.equal(row.accountSession.code, "access_denied");
  assert.equal(row.accountSession.message, "Active human Room membership required");
  assert.equal(row.roomCredential.status, 401);
  assert.equal(row.roomCredential.code, "unauthenticated");
  assert.equal(row.inactiveMembership.message, "Room membership is inactive");
  assert.match(row.shareLinkReuse.note, /never recreates a removed membership/i);
  assert.equal(row.hosted, "gap");
});

test("signed-out Room read is 401 unauthenticated", () => {
  const row = DENIAL_CONTRACTS["signed-out-401"];
  assert.equal(row.status, 401);
  assert.equal(row.code, "unauthenticated");
  assert.ok(row.messages.includes("Browser session required"));
  assert.deepEqual(row.logoutReceipt, { status: 200, body: { signedOut: true } });
  assert.match(row.hosted, /not a hosted-check/);
});

test("guest session ended and guest admin denial stay distinct from 410", () => {
  const ended = DENIAL_CONTRACTS["guest-session-ended"];
  assert.equal(ended.status, 409);
  assert.equal(ended.code, "guest_session_ended");
  assert.match(ended.message, /Sign out before joining as a new guest/);
  const admin = DENIAL_CONTRACTS["guest-cannot-administer"];
  assert.equal(admin.status, 403);
  assert.equal(admin.code, "access_denied");
  assert.match(admin.message, /Only a human room administrator/);
});

test("HTTP errors use the { error: { code, message } } envelope", () => {
  assert.match(ERROR_ENVELOPE.shape, /error/);
  assert.ok(DENIAL_IDS.includes("cancelled"));
  assert.ok(DENIAL_IDS.includes("signed-out-401"));
});
