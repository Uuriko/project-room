// From the 23 Sep agent user test in Build Together: a DM refusal told the
// agent "This credential cannot do that. Check access", and a mistyped
// command type ("message.post", "message.reacted") only said "Invalid
// command id or type". Both now name the next call.
import test from "node:test";
import assert from "node:assert/strict";
import { agentErrorAx } from "../src/agent-error.mjs";
import { validateCommand } from "../server/store.mjs";

test("dm_consent_required points at DM consent, not at access or the owner", () => {
  const ax = agentErrorAx({ httpStatus: 403, code: "dm_consent_required", message: "Direct messages need the recipient's consent", roomId: "room-1" });
  assert.equal(ax.reason, "dm_consent_required");
  assert.match(ax.hint, /DM consent/);
  assert.doesNotMatch(ax.hint, /credential|owner/);
  assert.deepEqual(ax.next[0], { path: "/api/rooms/room-1/dm-consents" });
  assert.match(agentErrorAx({ httpStatus: 403, code: "dm_consent_required", message: "Your DM request is still pending" }).hint, /pending/);
  const blocked = agentErrorAx({ httpStatus: 403, code: "dm_blocked", message: "not accepting" });
  assert.equal(blocked.reason, "dm_blocked");
  assert.match(blocked.hint, /Post in the room/);
});

test("an unknown command type names the closest real type and its family", () => {
  const refused = type => { try { validateCommand({ id: "11111111-1111-4111-8111-111111111111", type, data: {} }); } catch (error) { return error; } };
  for (const [type, expected] of [["message.post", "message.posted"], ["message.reacted", "message.reaction_set"], ["work.accept", "work.accepted"]]) {
    const error = refused(type);
    assert.equal(error.status, 422); assert.equal(error.code, "invalid_command");
    assert.match(error.message, new RegExp(`Did you mean "${expected.replace(".", "\\.")}"`));
  }
  assert.match(refused("message.post").message, /message types: message\.posted, .*message\.reaction_set/);
  assert.doesNotMatch(refused("bogus").message, /Did you mean/);
  assert.match(refused("bogus").message, /Types include message\.posted/);
  // A bad id keeps its old message; the type check only runs on a valid id.
  assert.throws(() => validateCommand({ id: "not a uuid", type: "message.posted", data: {} }), /Invalid command id or type/);
  const ax = agentErrorAx({ httpStatus: 422, code: "invalid_command", message: refused("message.post").message });
  assert.match(ax.hint, /command types named in the error/);
});

test("the People panel stops offering a DM request to someone who can already answer", async () => {
  const { dmConsentActionsForPeer, dmConsentPairDescription } = await import("../src/dm-consents.js");
  const answering = { outgoing: null, incoming: "approved" };
  assert.equal(dmConsentActionsForPeer(answering).some(a => a.action === "request"), false);
  assert.match(dmConsentPairDescription(answering, "Grok").join(" "), /you can answer/);
  assert.ok(dmConsentActionsForPeer({ outgoing: null, incoming: null }).some(a => a.action === "request"));
  assert.ok(dmConsentActionsForPeer({ outgoing: "rejected", incoming: "approved" }).some(a => a.action === "request"));
});
