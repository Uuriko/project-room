// #2009 (V168 follow-up): herdr-migrate force-release pre-validates operator
// authority before the release POST. The route (server/work-claim-routes.mjs
// authorityOver) 403s unless the caller is the claim holder, the room owner,
// or a manage_claims holder; the --execute/--confirm/--reason gates confirm
// intent, not authority. These tests pin the pure predicate the CLI checks
// against the room work view (viewerId + members + room.ownerId).
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { hasForceReleaseAuthority } from "../scripts/herdr-migrate.mjs";

const members = {
  holder: { id: "holder", active: true, permissions: [] },
  boss: { id: "boss", active: true, permissions: ["manage_claims"] },
  plain: { id: "plain", active: true, permissions: [] },
  gone: { id: "gone", active: false, permissions: ["manage_claims"] },
};
const claim = { id: "c1", owner: "holder", state: "claimed" };

test("the claim holder may force-release (ordinary path)", () => {
  assert.equal(hasForceReleaseAuthority({ viewerId: "holder", members, ownerId: "owner", claim }), true);
});

test("the room owner may force-release someone else's claim", () => {
  assert.equal(hasForceReleaseAuthority({ viewerId: "owner", members: { ...members, owner: { id: "owner", active: true, permissions: [] } }, ownerId: "owner", claim }), true);
});

test("a manage_claims holder may force-release someone else's claim", () => {
  assert.equal(hasForceReleaseAuthority({ viewerId: "boss", members, ownerId: "owner", claim }), true);
});

test("a plain member may NOT force-release someone else's claim", () => {
  assert.equal(hasForceReleaseAuthority({ viewerId: "plain", members, ownerId: "owner", claim }), false);
});

test("an inactive manage_claims member may NOT force-release", () => {
  assert.equal(hasForceReleaseAuthority({ viewerId: "gone", members, ownerId: "owner", claim }), false);
});

test("no viewer or no claim fails closed", () => {
  assert.equal(hasForceReleaseAuthority({ viewerId: null, members, ownerId: "owner", claim }), false);
  assert.equal(hasForceReleaseAuthority({ viewerId: "boss", members, ownerId: "owner", claim: null }), false);
});

test("inherited Object.prototype member names never satisfy the check", () => {
  assert.equal(hasForceReleaseAuthority({ viewerId: "toString", members, ownerId: "owner", claim }), false);
});
