// #3891: spend's "adjust" action is a pointer that needs an owner-chosen
// body, not a decision. The cockpit must not render it as a Deny button.
import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerCockpit } from "../src/owner-cockpit.js";

function fakeSection() {
  const box = () => ({ innerHTML: "", textContent: "", hidden: false, querySelector: () => null, querySelectorAll: () => [] });
  const parts = { "#cockpit-summary": box(), "#cockpit-decisions": box(), "#cockpit-exceptions": box(), "#cockpit-room-stubs": box(), h3: box() };
  return { hidden: true, parts, querySelector: selector => parts[selector] ?? null, setAttribute() {} };
}

const item = (id, kind, actions) => ({ id, kind, roomId: "r1", roomName: "Room one", title: id, ageMs: 60000, actions });
const path = "/api/rooms/r1/spend-allowance";

test("spend adjust renders as a room link, approve/deny stay buttons", async () => {
  const section = fakeSection();
  const cockpit = createOwnerCockpit({ section, decide: async () => {}, accountClient: { ownerOverview: async () => ({
    decisions: { total: 2, waiting: 2, overdue: 0, oldestAgeMs: 60000, items: [
      item("spend-1", "spend", [{ action: "adjust", method: "POST", path, hint: "Send { allowanceCents }" }]),
      item("join-1", "join", [{ action: "approve", method: "POST", path: "/x", body: {} }, { action: "deny", method: "POST", path: "/x", body: {} }]),
    ] },
    exceptions: { total: 0, items: [] }, rooms: { label: null }, roomErrors: [], jobs: [],
  }) } });
  await cockpit.refresh();
  const html = section.parts["#cockpit-decisions"].innerHTML;
  const spend = html.slice(html.indexOf('data-kind="spend"'), html.indexOf('data-kind="join"'));
  assert.ok(spend.length > 0, "spend item rendered");
  assert.doesNotMatch(spend, /data-cockpit-decide/);
  assert.doesNotMatch(spend, />Deny</);
  assert.match(spend, /Review in room/);
  assert.match(html, /data-cockpit-decide="approve" data-item-id="join-1">Approve</);
  assert.match(html, /data-cockpit-decide="deny" data-item-id="join-1">Deny</);
});
