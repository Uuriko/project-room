// #1549: the guest-invite expiry recovery docs must not drift from the code.
// Guards the decision tree in docs/GUEST-AGENT-LINKS.md ("Session died
// mid-task: recovery") and its pointer in docs/JOINING.md against the
// server constants, route surface, and lifecycle semantics they describe:
// v0 TTL is fixed at 2h with a self-service refresh route (#1563: an
// expired v0 credential refreshes to a fresh one for the same seat, no
// owner round-trip); v1 codes are single-use (burned at redemption) so
// re-redeem needs a fresh live code and reuses the same seat; rotate keeps
// the same expiry (leak response only).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAL_MD = join(root, "docs", "GUEST-AGENT-LINKS.md");
const JOINING_MD = join(root, "docs", "JOINING.md");
const V0 = join(root, "server", "guest-agent-links.mjs");
const V1 = join(root, "server", "guest-invites.mjs");
const HTTP = join(root, "server", "http.mjs");
const STORE = join(root, "server", "store.mjs");

const galMd = readFileSync(GAL_MD, "utf8");
const joiningMd = readFileSync(JOINING_MD, "utf8");
const v0Src = readFileSync(V0, "utf8");
const v1Src = readFileSync(V1, "utf8");
const httpSrc = readFileSync(HTTP, "utf8");
const storeSrc = readFileSync(STORE, "utf8");

// The recovery section: everything from its heading to the next ## heading.
function recoverySection(md) {
  const start = md.indexOf("## Session died mid-task: recovery");
  assert.ok(start !== -1, "GUEST-AGENT-LINKS.md must keep the recovery section");
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next === -1 ? undefined : next);
}
const recovery = recoverySection(galMd);

// Read an exported millisecond constant's evaluated value out of source.
// Shape: export const NAME = <arithmetic expression over numbers>;
function exportedMs(src, name) {
  const m = src.match(new RegExp(`export const ${name} = ([\\d *+()/.-]+);`));
  assert.ok(m, `could not parse ${name} from source`);
  return Function(`"use strict"; return (${m[1]});`)();
}

test("recovery section names both invite kinds and their dead-end error codes", () => {
  assert.ok(recovery.includes("v0"), "recovery must cover the v0 token path");
  assert.ok(recovery.includes("v1"), "recovery must cover the v1 GX- code path");
  assert.ok(recovery.includes("link_unavailable"), "v0 dead end is 410 link_unavailable");
  assert.ok(recovery.includes("invite_unavailable"), "v1 dead end is 410 invite_unavailable");
  // The codes really are the 410s the server throws.
  assert.ok(v0Src.includes('fail(410, "link_unavailable"'), "v0 code must throw 410 link_unavailable");
  assert.ok(v1Src.includes('fail(410, "invite_unavailable"'), "v1 code must throw 410 invite_unavailable");
});

test("v0: documented fixed 2h TTL matches code, and the refresh route exists", () => {
  assert.ok(/fixed 2 hours/.test(recovery), "recovery must say the v0 TTL is fixed at 2 hours");
  assert.equal(exportedMs(v0Src, "GUEST_AGENT_TTL_MS"), 2 * 60 * 60 * 1000);
  // #1563: v0 gained a self-service refresh for expired credentials — the
  // recovery docs must name the endpoint and its same-seat semantics.
  assert.ok(recovery.includes("/api/guest-agent-links/refresh"), "recovery must document the v0 refresh endpoint");
  const v0Routes = httpSrc.match(/\/api\/guest-agent-links[^\s"']*/g) ?? [];
  const refreshish = v0Routes.filter(r => /refresh|rotate|extend|renew/i.test(r));
  assert.deepEqual(refreshish, ["/api/guest-agent-links/refresh"],
    `v0 must expose exactly the refresh route (found: ${refreshish})`);
  assert.ok(/same member/.test(recovery), "recovery must say refresh keeps the same member");
  // The refresh revokes the old credential row: burned codes never resurrect.
  assert.ok(/UPDATE credentials SET revoked=1/.test(v0Src), "refresh must revoke the old credential row");
  // v0 refresh-less fallback: a fresh mint creates a NEW member because the
  // member id derives from account+requestId; reusing the requestId is a 409.
  assert.ok(recovery.includes("new member"), "recovery must say a fresh v0 invite creates a new member");
  assert.ok(v0Src.includes("membership_ended"), "code must reject refreshing an ended v0 membership");
});

test("v1: codes are single-use — the burned code cannot re-redeem", () => {
  assert.ok(/single-use/.test(recovery), "recovery must say v1 codes are single-use");
  assert.ok(/burned/.test(recovery), "recovery must say a redeemed code is burned");
  // liveInvite() gates preview and redeem on status === "active"...
  const live = v1Src.match(/liveInvite\(row\) \{\s*return ([^;]+);/);
  assert.ok(live && live[1].includes('status === "active"'), "liveInvite must require an active code");
  // ...and redeem burns the row to status='redeemed'.
  assert.ok(/SET status='redeemed'/.test(v1Src), "redeem must burn the invite row");
});

test("v1: documented TTL bounds match the exported code constants", () => {
  assert.ok(recovery.includes("default 72h"), "recovery must state the 72h credential TTL default");
  assert.ok(recovery.includes("1h–14d"), "recovery must state the 1h–14d credential TTL range");
  assert.ok(recovery.includes("default 24h"), "recovery must state the 24h redeem-window default");
  assert.ok(recovery.includes("1 hour – 7 days"), "recovery must state the 1h–7d redeem-window range");
  assert.equal(exportedMs(v1Src, "GUEST_CREDENTIAL_TTL_DEFAULT_MS"), 72 * 60 * 60 * 1000);
  assert.equal(exportedMs(v1Src, "GUEST_CREDENTIAL_TTL_MIN_MS"), 60 * 60 * 1000);
  assert.equal(exportedMs(v1Src, "GUEST_CREDENTIAL_TTL_MAX_MS"), 14 * 24 * 60 * 60 * 1000);
  assert.equal(exportedMs(v1Src, "GUEST_INVITE_REDEEM_DEFAULT_MS"), 24 * 60 * 60 * 1000);
  assert.equal(exportedMs(v1Src, "GUEST_INVITE_REDEEM_MIN_MS"), 60 * 60 * 1000);
  assert.equal(exportedMs(v1Src, "GUEST_INVITE_REDEEM_MAX_MS"), 7 * 24 * 60 * 60 * 1000);
});

test("v1: re-redeem with a fresh code reuses the same seat — stated and real", () => {
  assert.ok(/reuses its (guest )?seat/.test(recovery), "recovery must say re-redeem reuses the seat");
  assert.ok(/no new member/.test(recovery), "recovery must say re-redeem creates no new member");
  // redeem(): same identity + live seat -> duplicate=true (same memberId);
  // deactivated seat -> reactivateGuestSeat (identity-bound reactivation).
  assert.ok(v1Src.includes("duplicate = true"), "redeem must reuse the live seat for the same identity");
  assert.ok(v1Src.includes("reactivateGuestSeat"), "redeem must reactivate an expired-swept seat");
});

test("rotate is documented as leak response with the same expiry — not an extension", () => {
  assert.ok(recovery.includes("rotate"), "recovery must mention rotate");
  assert.ok(/same expiry/i.test(recovery), "recovery must say rotate keeps the same expiry");
  assert.ok(/not an\s*extension|never extends/i.test(recovery), "recovery must say rotate is not a lifetime extension");
  // The rotated credential row is written with the OLD expiry...
  const rot = v1Src.match(/rotate\(guestToken, roomId, binding\) \{([\s\S]*?)\n  \}/);
  assert.ok(rot, "could not locate rotate() in server/guest-invites.mjs");
  assert.ok(/INSERT INTO credentials\([^)]*\)[\s\S]*?\.run\(hash\(token\), roomId, member\.id, row\.expires_at\)/.test(rot[1]),
    "rotate must issue the new credential with the same expires_at");
  // ...and rotate 410s once the credential is already dead.
  assert.ok(/row\.expires_at <= this\.store\.now\(\)/.test(rot[1]), "rotate must 410 an expired credential");
});

test("recovery section keeps the invite vocabulary (no internal mechanism names)", () => {
  // Mirrors the banned-name scanner in tests/join-vocabulary.test.js: the
  // recovery copy is user-facing, so `ga1.` and friends stay out of it.
  assert.ok(!recovery.includes("ga1."), "recovery must not leak the ga1. token prefix");
  assert.ok(!/self-mint/.test(recovery), "recovery must not leak self-mint");
});

test("token expiry 401 teaches the recovery: doc wording matches the store message", () => {
  assert.ok(recovery.includes("401"), "recovery must name the 401 status");
  assert.ok(recovery.includes("unauthenticated"), "recovery must name the unchanged error code");
  assert.ok(recovery.includes("Guest credential expired"), "recovery must quote the teaching message");
  assert.ok(recovery.includes("It cannot be renewed"), "recovery must say the credential cannot be renewed");
  assert.ok(recovery.includes("Session or key expired or revoked"), "recovery must say revocation keeps the generic message");
  // The message the server throws, guest-scoped, with status+code unchanged.
  assert.ok(storeSrc.includes("Guest credential expired. It cannot be renewed"),
    "store.mjs must throw the documented guest-expiry message");
  assert.ok(/fail\(401, "unauthenticated", "Guest credential expired/.test(storeSrc),
    "teaching failure keeps 401 + unauthenticated (backward compatible)");
  assert.ok(storeSrc.includes("isGuestAgentMemberId(row.member_id)"),
    "the teaching branch must be scoped to guest credentials");
});

test("self-serve expiry recovery is documented and matches code constants", () => {
  assert.ok(/self-serve/i.test(recovery), "recovery must cover the self-serve path");
  assert.ok(recovery.includes("24 hours"), "recovery must state the fixed 24h self-serve TTL");
  assert.ok(recovery.includes("new") && recovery.includes("requestId"),
    "recovery must say a fresh joinRequest needs a new requestId");
  assert.ok(recovery.includes("renewed"), "recovery must name the renewed renewal marker");
  assert.ok(recovery.includes("stale_card"), "recovery must say replaying the old requestId 422s");
  assert.equal(exportedMs(v1Src, "GUEST_SELF_SERVE_TTL_MS"), 24 * 60 * 60 * 1000);
  assert.ok(httpSrc.includes("/api/guest-invites/request"), "the self-serve route must exist");
});

test("JOINING.md points at the recovery decision tree with the corrected v1 wording", () => {
  const pointer = "GUEST-AGENT-LINKS.md#session-died-mid-task-recovery";
  assert.ok(joiningMd.includes(pointer), `JOINING.md must link ${pointer}`);
  assert.ok(joiningMd.includes("single-use"), "JOINING.md must say v1 codes are single-use");
  assert.ok(joiningMd.includes("no new member"), "JOINING.md must say re-redeem reuses the seat");
});
