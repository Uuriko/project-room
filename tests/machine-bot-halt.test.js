import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineBot } from "../machine/bot/loop.mjs";

// The owner halted the machine. A board item assigned to its bot must stay on
// the board with its wake unacked, as a pause leaves it. The bot used to ack
// the wake, claim the item, lease a slot, then block the item at its first
// step ("Halted by the operator"), so the work vanished from the board and
// nobody picked it up after resume.
function harness(t, { tier = "t3", halted = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "room-bot-halt-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const daemon = { state: { halted, pausedUntil: null, slots: { desk: null, scratch: null }, running: {} } };
  const bot = new MachineBot({ home, env: {}, daemon, provider: { name: "scripted", computerUse: true, next: async () => ({ actions: [], text: "Done.", costUsd: 0 }) } });
  bot.bot = { rooms: ["commons"], tier, goMembers: [], maxSteps: 5, maxWallMs: 60_000, maxSpendUsd: 1 };
  bot.config = { machineId: "mac-1", ownerMemberId: "owner" };
  const calls = [];
  bot.api = new Proxy({}, {
    get: (_target, name) => async (...args) => {
      calls.push(String(name));
      if (name === "pause") return { ok: true, status: 200, value: { pause: null, memberId: "bot-member" } };
      if (name === "tier") return { ok: false, status: 404, value: null };
      if (name === "claims") return { ok: true, status: 200, value: { claims: [] } };
      if (name === "post") return { ok: true, status: 201, messageId: "plan-1", value: {} };
      return { ok: true, status: 200, value: { id: `${String(name)}-${calls.length}`, state: "claimed", args } };
    },
  });
  bot.readQueue = async () => ({ ok: true, kind: "work", messageId: "m1", updateId: null, basisToken: null });
  bot.readSource = async () => ({ ok: true, kind: "work", roomId: "commons", messageId: "m1", text: "open Safari and send a screenshot", workItemId: null });
  return { bot, calls, daemon };
}

const WRITES = ["ack", "createClaim", "takeClaim", "updateClaim", "post", "markUpdate"];

test("a halted machine's bot leaves an assigned board item and its wake alone", async t => {
  const { bot, calls } = harness(t, { tier: "t3" });
  const result = await bot.handleSignal({ roomId: "commons", signalId: "wake-1" });
  assert.equal(result.halted, true, JSON.stringify(result));
  assert.equal(bot.active, null);
  assert.deepEqual(calls.filter(name => WRITES.includes(name)), [], "no ack, no claim, no lease, no post");
});

test("a halted machine's bot does not post a plan for a mention", async t => {
  const { bot, calls } = harness(t, { tier: "t1" });
  const result = await bot.handleSignal({ roomId: "commons", signalId: "wake-2" });
  assert.equal(result.halted, true, JSON.stringify(result));
  assert.equal(bot.pending, null);
  assert.deepEqual(calls.filter(name => WRITES.includes(name)), []);
});

test("after resume the same wake starts the work", async t => {
  const { bot, calls, daemon } = harness(t, { tier: "t3" });
  await bot.handleSignal({ roomId: "commons", signalId: "wake-3" });
  daemon.state.halted = false;
  const result = await bot.handleSignal({ roomId: "commons", signalId: "wake-3" });
  assert.equal(result.started, true, JSON.stringify(result));
  assert.ok(calls.includes("ack") && calls.includes("createClaim"));
});

test("the run loop waits instead of spinning on wakes a halt or pause holds back", async t => {
  const { bot } = harness(t);
  let rounds = 0;
  bot.once = async () => {
    rounds += 1;
    await new Promise(resolve => setImmediate(resolve));
    return { enabled: true, results: [{ signalId: "wake-4", halted: true }] };
  };
  const running = bot.run();
  await new Promise(resolve => setTimeout(resolve, 300));
  await bot.stop();
  assert.ok(rounds <= 2, `ran ${rounds} rounds in 300 ms`);
  await Promise.race([running, new Promise(resolve => setTimeout(resolve, 1500))]);
});
