// QA-200 P1: a #invite/RM-<code> fragment is an agent-invite link in the
// SPA's fragment form. The SPA's invitation dialog only redeems 43-char
// human share-link tokens; without a redirect it renders "This invitation
// link is unavailable." before any API call. These tests pin the pure
// fragment -> join-page mapping in src/invite-context.js (the app.js call
// sites consume it via redirectAgentInvite()).
import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_INVITE_CODE_PATTERN, agentInviteJoinPath } from "../src/invite-context.js";

const V2_CODE = "RM-0123456789ABCDE"; // 16 Crockford symbols
const LEGACY_CODE = "RM-ABCDEFGH"; // v1 8-symbol code (no longer redeems, but still a code shape)

test("agent invite code pattern accepts RM- codes, rejects human tokens", () => {
  assert.ok(AGENT_INVITE_CODE_PATTERN.test(V2_CODE));
  assert.ok(AGENT_INVITE_CODE_PATTERN.test(LEGACY_CODE));
  assert.ok(!AGENT_INVITE_CODE_PATTERN.test("a".repeat(43)));
  assert.ok(!AGENT_INVITE_CODE_PATTERN.test("RM-"));
  assert.ok(!AGENT_INVITE_CODE_PATTERN.test("RM-abc")); // lowercase is not minted
  assert.ok(!AGENT_INVITE_CODE_PATTERN.test("#invite/" + V2_CODE));
});

test("RM- fragment maps to the join page on the bare door", () => {
  assert.equal(agentInviteJoinPath(`#invite/${V2_CODE}`, "/"), `/join/${V2_CODE}`);
  assert.equal(agentInviteJoinPath(`#invite/${LEGACY_CODE}`, "/"), `/join/${LEGACY_CODE}`);
});

test("RM- fragment keeps the www-door /room prefix", () => {
  assert.equal(agentInviteJoinPath(`#invite/${V2_CODE}`, "/room/"), `/room/join/${V2_CODE}`);
  assert.equal(agentInviteJoinPath(`#invite/${V2_CODE}`, "/room"), `/room/join/${V2_CODE}`);
});

test("non-agent fragments return null (SPA keeps its existing behavior)", () => {
  assert.equal(agentInviteJoinPath(`#invite/${"a".repeat(43)}`, "/"), null);
  assert.equal(agentInviteJoinPath("#invite/garbage", "/"), null);
  assert.equal(agentInviteJoinPath("#join/" + V2_CODE, "/"), null);
  assert.equal(agentInviteJoinPath("", "/"), null);
  assert.equal(agentInviteJoinPath(null, "/"), null);
  assert.equal(agentInviteJoinPath(`#invite/${V2_CODE}`, "/other/"), `/join/${V2_CODE}`);
});
