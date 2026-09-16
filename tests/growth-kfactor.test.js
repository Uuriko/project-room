// G010: K-factor / referral tracking. Pure calculator tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { kFactor, KFactorError } from "../server/growth-kfactor.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof KFactorError && error.code === code);
const events = () => [
  { type: "member.invited", actorId: "a", invitedBy: "quill", at: "2026-09-10T10:00:00Z" },
  { type: "member.joined_via_invitation", actorId: "a", at: "2026-09-10T12:00:00Z" },
  { type: "member.invited", actorId: "b", invitedBy: "quill", at: "2026-09-10T10:00:00Z" },
  { type: "member.invited", actorId: "c", invitedBy: "grok", at: "2026-09-10T10:00:00Z" },
  { type: "member.joined_via_invitation", actorId: "c", at: "2026-09-10T11:00:00Z" },
  { type: "room.post", actorId: "quill", at: "2026-09-10T13:00:00Z" },
];

test("kFactor computes the viral coefficient and per-inviter stats", () => {
  const result = kFactor(events());
  assert.equal(result.invitesSent, 3);
  assert.equal(result.invitesConverted, 2);
  assert.equal(result.activeAgents, 4); // a, b, c, quill
  assert.equal(result.kFactor, 0.5);
  assert.equal(result.inviteConversionRate, 66.7);
  assert.equal(result.medianViralCycleMs, 5400000); // 1.5h median of 2h, 1h
  const quill = result.perInviter.find(entry => entry.inviter === "quill");
  assert.deepEqual([quill.sent, quill.converted, quill.conversionRate], [2, 1, 50]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.perInviter));
});
test("empty input yields nulls, not crashes", () => {
  const result = kFactor([]);
  assert.equal(result.kFactor, null);
  assert.equal(result.inviteConversionRate, null);
  assert.deepEqual(result.perInviter, []);
});
test("malformed inputs are refused", () => {
  throwsCode(() => kFactor("nope"), "invalid_kfactor_input");
  throwsCode(() => kFactor([{ type: "member.invited", actorId: "a", at: "2026-09-10T10:00:00Z" }]), "invalid_kfactor_input");
  throwsCode(() => kFactor([{ type: "x", actorId: "a", at: "bad" }]), "invalid_kfactor_input");
});
