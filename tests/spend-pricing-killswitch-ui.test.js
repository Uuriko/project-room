// Spend-pricing kill-switch UI (audit item 10): owner-only toggle wired to the
// existing owner-gated POST /api/rooms/:id/spend-pricing route. Fail-first:
// this suite imports ../src/spend-pricing-ui.js, which does not exist yet.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isSpendPricingOwner,
  spendPricingViewOf,
  killSwitchSectionHtml,
  flipSpendPricing,
  createSpendPricingKillSwitch,
} from "../src/spend-pricing-ui.js";

const ownerState = (enabled = true) => ({
  room: { id: "room1", ownerId: "owner1", spendPricing: { enabled, revision: 3, setById: "owner1", setAt: "2026-10-06T00:00:00Z" } },
  members: { owner1: { id: "owner1", kind: "human" }, viewer2: { id: "viewer2", kind: "human" }, agent9: { id: "agent9", kind: "agent" } },
});
const ownerSession = { member: { id: "owner1", kind: "human" } };
const memberSession = { member: { id: "viewer2", kind: "human" } };
const agentSession = { member: { id: "agent9", kind: "agent" } };

function stubClient(responses = {}) {
  const calls = [];
  return {
    calls,
    async request(path, { method = "GET", data } = {}) {
      calls.push({ path, method, data });
      const r = responses[path];
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r({ path, method, data }) : r;
    },
  };
}

function fakeContainer() {
  const listeners = {};
  return {
    hidden: false,
    innerHTML: "",
    dataset: {},
    listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener(name, fn) { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); },
    async fireAsync(name, event) { for (const fn of listeners[name] ?? []) await fn({ currentTarget: this, ...event }); },
  };
}
const clickOn = spendPricingAction => ({ target: { closest: () => ({ dataset: { spendPricing: spendPricingAction } }) } });

test("isSpendPricingOwner: only the human room owner qualifies", () => {
  const state = ownerState();
  assert.equal(isSpendPricingOwner({ session: ownerSession, state }), true);
  assert.equal(isSpendPricingOwner({ session: memberSession, state }), false, "plain member is not owner");
  assert.equal(isSpendPricingOwner({ session: agentSession, state }), false, "owner id held by an agent session is not the human owner");
  assert.equal(isSpendPricingOwner({ session: null, state }), false);
  assert.equal(isSpendPricingOwner({ session: ownerSession, state: null }), false);
});

test("spendPricingViewOf: projection state, default enabled when absent", () => {
  const view = spendPricingViewOf(ownerState(false));
  assert.equal(view.enabled, false);
  assert.equal(view.revision, 3);
  assert.equal(spendPricingViewOf({ room: { id: "r" }, members: {} }).enabled, true, "absent spendPricing means enabled");
});

test("non-owner never sees the toggle: container hidden, no content", () => {
  const box = fakeContainer();
  const sw = createSpendPricingKillSwitch();
  assert.equal(sw.sync(box, { session: memberSession, state: ownerState(true) }), "hidden");
  assert.equal(box.hidden, true);
  assert.ok(!box.innerHTML.includes("kill switch"), "no kill-switch markup leaks to non-owners");

  const agentBox = fakeContainer();
  const agentOwnerState = ownerState(true);
  agentOwnerState.room.ownerId = "agent9";
  assert.equal(sw.sync(agentBox, { session: agentSession, state: agentOwnerState }), "hidden");
  assert.ok(!agentBox.innerHTML.includes("kill switch"));
});

test("owner sees the labeled emergency toggle with the current state", () => {
  const box = fakeContainer();
  const sw = createSpendPricingKillSwitch();
  assert.equal(sw.sync(box, { session: ownerSession, state: ownerState(true) }), "shown");
  assert.equal(box.hidden, false);
  assert.ok(box.innerHTML.toLowerCase().includes("emergency"), "labels this as an emergency control");
  assert.ok(box.innerHTML.toLowerCase().includes("kill switch"));
  assert.ok(box.innerHTML.includes('data-spend-pricing="arm"'), "offers an arming button, not a direct flip");
  assert.ok(!box.innerHTML.includes('data-spend-pricing="confirm"'), "no live confirm before arming");

  const disabledBox = fakeContainer();
  createSpendPricingKillSwitch().sync(disabledBox, { session: ownerSession, state: ownerState(false) });
  assert.ok(disabledBox.innerHTML.includes("Pricing is currently DISABLED"), "shows the current state");
});

test("killSwitchSectionHtml is owner-only by contract: callers render nothing for non-owners", () => {
  // The module only ever produces markup; hiding is enforced by sync().
  assert.equal(typeof killSwitchSectionHtml, "function");
});

test("arming then confirming POSTs { enabled: false } to the spend-pricing route", async () => {
  const client = stubClient({ "/api/rooms/room1/spend-pricing": { ok: true } });
  const box = fakeContainer();
  const sw = createSpendPricingKillSwitch();
  sw.sync(box, { session: ownerSession, state: ownerState(true), client, roomId: "room1" });

  await box.fireAsync("click", clickOn("arm"));
  assert.ok(box.innerHTML.includes('data-spend-pricing="confirm"'), "armed state shows a confirm step");
  assert.ok(box.innerHTML.toLowerCase().includes("confirm"), "armed copy warns before the flip");

  await box.fireAsync("click", clickOn("confirm"));
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, "/api/rooms/room1/spend-pricing");
  assert.equal(client.calls[0].method, "POST");
  assert.equal(client.calls[0].data.enabled, false, "flip sends the flipped value");
  assert.equal(typeof client.calls[0].data.requestId, "string", "idempotent request id is sent");
  assert.ok(!box.innerHTML.includes('data-spend-pricing="confirm"'), "disarmed after the flip");
});

test("re-enable posts { enabled: true } when pricing is currently disabled", async () => {
  const client = stubClient({ "/api/rooms/room1/spend-pricing": { ok: true } });
  const box = fakeContainer();
  const sw = createSpendPricingKillSwitch();
  sw.sync(box, { session: ownerSession, state: ownerState(false), client, roomId: "room1" });
  await box.fireAsync("click", clickOn("arm"));
  await box.fireAsync("click", clickOn("confirm"));
  assert.equal(client.calls[0].data.enabled, true);
});

test("flipSpendPricing posts the payload and returns the server body", async () => {
  const client = stubClient({ "/api/rooms/room1/spend-pricing": { enabled: false, revision: 4 } });
  const body = await flipSpendPricing({ client, roomId: "room1", enabled: false });
  assert.equal(body.enabled, false);
  assert.equal(client.calls[0].method, "POST");
  assert.deepEqual(Object.keys(client.calls[0].data).sort(), ["enabled", "requestId"]);
});

test("a failed flip surfaces the error in the panel instead of failing silently", async () => {
  const failure = new Error("Only the room owner can set spend pricing");
  failure.status = 403;
  const client = stubClient({ "/api/rooms/room1/spend-pricing": failure });
  const box = fakeContainer();
  const sw = createSpendPricingKillSwitch();
  sw.sync(box, { session: ownerSession, state: ownerState(true), client, roomId: "room1" });
  await box.fireAsync("click", clickOn("arm"));
  await box.fireAsync("click", clickOn("confirm"));
  assert.ok(box.innerHTML.toLowerCase().includes("only the room owner can set spend pricing"), "error text is shown");
});
