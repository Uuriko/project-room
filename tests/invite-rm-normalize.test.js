// WAVE-500 G2: #invite/RM-<code> edge-case audit.
//
// The server folds case and trims (server/agent-invites.mjs) and the /join
// page uppercases (parseJoinCode in src/join.js), but the SPA's #invite/
// detector was strictly /^RM-[A-Z0-9]+$/ — a redeemable code pasted in
// lowercase, with whitespace, or with trailing tracker junk dead-ended on
// "This invitation link is unavailable." before any API call.
// normalizeAgentInviteCode() in src/invite-context.js is the tolerant
// detector both app.js (consumeInvitationFragment) and agentInviteJoinPath
// now share.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentInviteCode, agentInviteJoinPath } from "../src/invite-context.js";

const V2 = "RM-0123456789ABCDE"; // 16 Crockford symbols, as minted
const LEGACY = "RM-ABCDEFGH"; // v1 8-symbol shape

test("normalizeAgentInviteCode folds case to the canonical uppercase code", () => {
  assert.equal(normalizeAgentInviteCode(V2.toLowerCase()), V2);
  assert.equal(normalizeAgentInviteCode("rm-0123456789abcde"), V2);
  assert.equal(normalizeAgentInviteCode("Rm-AbCdEfGh"), LEGACY);
});

test("normalizeAgentInviteCode decodes and trims pasted whitespace", () => {
  assert.equal(normalizeAgentInviteCode(`%20${V2}%20`), V2);
  assert.equal(normalizeAgentInviteCode(`  ${V2}\t`), V2);
  assert.equal(normalizeAgentInviteCode(encodeURIComponent(` ${V2} `)), V2);
});

test("normalizeAgentInviteCode drops trailing query/fragment/slash junk", () => {
  assert.equal(normalizeAgentInviteCode(`${V2}?utm_source=x`), V2);
  assert.equal(normalizeAgentInviteCode(`${V2}#frag`), V2);
  assert.equal(normalizeAgentInviteCode(`${V2}/`), V2);
  assert.equal(normalizeAgentInviteCode(`${V2.toLowerCase()}?x=1`), V2);
});

test("normalizeAgentInviteCode rejects non-codes", () => {
  assert.equal(normalizeAgentInviteCode("garbage"), null);
  assert.equal(normalizeAgentInviteCode("RM-"), null);
  assert.equal(normalizeAgentInviteCode("RM-ABC!DEF"), null);
  assert.equal(normalizeAgentInviteCode(""), null);
  assert.equal(normalizeAgentInviteCode(null), null);
  assert.equal(normalizeAgentInviteCode(undefined), null);
  assert.equal(normalizeAgentInviteCode("100%"), null); // bad percent-escape, kept raw
});

test("normalizeAgentInviteCode never hijacks a 43-char human token", () => {
  const token = `RM-${"a".repeat(40)}`; // base64url can produce an "RM-" prefix
  assert.equal(token.length, 43);
  assert.equal(normalizeAgentInviteCode(token), null);
  assert.equal(normalizeAgentInviteCode(`${token}?utm=x`), null);
});

test("agentInviteJoinPath routes tolerated fragments to the join page", () => {
  assert.equal(agentInviteJoinPath(`#invite/${V2.toLowerCase()}`, "/"), `/join/${V2}`);
  assert.equal(agentInviteJoinPath(`#invite/%20${V2}%20`, "/"), `/join/${V2}`);
  assert.equal(agentInviteJoinPath(`#invite/${V2}?utm_source=x`, "/"), `/join/${V2}`);
  assert.equal(agentInviteJoinPath(`#invite/${V2}/`, "/"), `/join/${V2}`);
  assert.equal(agentInviteJoinPath(`#invite/${V2.toLowerCase()}`, "/room"), `/room/join/${V2}`);
  assert.equal(agentInviteJoinPath(`#invite/${V2.toLowerCase()}`, "/room/"), `/room/join/${V2}`);
});

test("agentInviteJoinPath still rejects non-agent fragments", () => {
  const token = `RM-${"a".repeat(40)}`;
  assert.equal(agentInviteJoinPath(`#invite/${token}`, "/"), null);
  assert.equal(agentInviteJoinPath("#invite/garbage", "/"), null);
  assert.equal(agentInviteJoinPath("#join/" + V2, "/"), null);
  assert.equal(agentInviteJoinPath("", "/"), null);
  assert.equal(agentInviteJoinPath(null, "/"), null);
});
