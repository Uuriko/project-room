import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineBot } from "../machine/bot/loop.mjs";

// Independent Stop for one task. The owner stops a Mac bot's task by
// releasing or reassigning its board item (or closing it), without halting
// the whole machine. The bot only re-checked Halt, Pause and its budget
// between steps, so it kept acting on an item it no longer held, and could
// finish work someone else had already picked up.
function harness(t, { steps = 3 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "room-bot-board-stop-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const daemon = { state: { halted: false, pausedUntil: null, slots: { desk: null, scratch: null }, running: {} } };
  let turns = 0;
  const provider = {
    name: "scripted", computerUse: true,
    next: async () => {
      turns += 1;
      if (turns > 1) return { actions: [], text: "Done.", costUsd: 0 };
      return { actions: Array.from({ length: steps }, (_, i) => ({ tool: "shell.run", args: { i } })), costUsd: 0 };
    },
  };
  const bot = new MachineBot({ home, env: {}, daemon, provider });
  bot.bot = { rooms: ["commons"], tier: "t3", goMembers: [], maxSteps: 50, maxWallMs: 60_000, maxSpendUsd: 1, progressIntervalMs: 3_600_000 };
  bot.config = { machineId: "mac-1", ownerMemberId: "owner" };
  bot.provider = provider;
  bot.memberIds.set("commons", "bot-member");
  const board = { work: { id: "botw-1", state: "in_progress", owner: "bot-member" }, status: 200 };
  const calls = [];
  bot.api = {
    claim: async (_roomId, id) => {
      calls.push(["claim", id]);
      if (id !== "botw-1") return { ok: true, status: 200, value: { id, state: "in_progress", owner: "bot-member" } };
      if (board.status !== 200) return { ok: false, status: board.status, value: null };
      return { ok: true, status: 200, value: { ...board.work } };
    },
    pause: async () => ({ ok: true, status: 200, value: { pause: null, memberId: "bot-member" } }),
    post: async (_roomId, body) => { calls.push(["post", body]); return { ok: true, status: 201, messageId: "p" }; },
    markUpdate: async () => ({ ok: true, status: 200 }),
    updateClaim: async (_roomId, id, body) => { calls.push(["updateClaim", id, body.state]); return { ok: true, status: 200, value: {} }; },
  };
  const executed = [];
  bot.execute = async action => {
    executed.push(action.args.i);
    return { ok: true, observation: { tool: action.tool, ok: true } };
  };
  const finished = [];
  bot.finish = async text => { finished.push(text); bot.active = null; return { done: true }; };
  bot.active = {
    roomId: "commons", messageId: "m1", text: "tidy the downloads folder", updateId: null, basisToken: null,
    workId: "botw-1", leaseId: "botl-desk-1", slot: "desk", steps: 0, spendUsd: 0,
    startedAt: 0, lastProgressAt: 0, observations: [],
  };
  bot.clock = () => 1_000;
  return { bot, board, calls, executed, finished };
}

const posts = calls => calls.filter(c => c[0] === "post").map(c => c[1]);

test("releasing the bot's board item stops it before the next step", async t => {
  const { bot, board, calls, executed, finished } = harness(t);
  const execute = bot.execute;
  bot.execute = async action => {
    const done = await execute(action);
    if (action.args.i === 0) board.work = { id: "botw-1", state: "unclaimed", owner: null };
    return done;
  };
  const result = await bot.continueActive();
  assert.deepEqual(executed, [0], "no step after the release");
  assert.equal(result.stopped, true, JSON.stringify(result));
  assert.equal(bot.active, null);
  assert.deepEqual(finished, [], "a released item is not reported done");
  assert.match(posts(calls).join("\n"), /released/i);
  const updates = calls.filter(c => c[0] === "updateClaim");
  assert.deepEqual(updates.filter(c => c[1] === "botw-1"), [], "the bot does not block an item it no longer holds");
  assert.deepEqual(updates.filter(c => c[1] === "botl-desk-1").map(c => c[2]), ["unclaimed"], "its slot lease is given back");
});

test("reassigning the item to someone else stops the bot too", async t => {
  const { bot, board, calls, executed } = harness(t);
  board.work = { id: "botw-1", state: "claimed", owner: "someone-else" };
  const result = await bot.continueActive();
  assert.deepEqual(executed, []);
  assert.equal(result.stopped, true);
  assert.match(posts(calls).join("\n"), /reassigned/i);
  assert.deepEqual(calls.filter(c => c[0] === "updateClaim" && c[1] === "botw-1"), []);
});

test("closing the item on the board stops the bot without reporting it done", async t => {
  const { bot, board, calls, executed, finished } = harness(t, { steps: 1 });
  bot.execute = async action => {
    executed.push(action.args.i);
    board.work = { id: "botw-1", state: "done", owner: "bot-member" };
    return { ok: true, observation: { tool: action.tool, ok: true } };
  };
  await bot.continueActive();
  assert.deepEqual(executed, [0]);
  assert.deepEqual(finished, [], "the provider's 'Done.' is not posted over a board close");
  assert.match(posts(calls).join("\n"), /closed/i);
});

test("an item the bot still holds runs to the end", async t => {
  const { bot, executed, finished } = harness(t);
  await bot.continueActive();
  assert.deepEqual(executed, [0, 1, 2]);
  assert.deepEqual(finished, ["Done."]);
});

test("a board read that fails for a moment does not stop the work", async t => {
  const { bot, board, executed, finished } = harness(t);
  board.status = 503;
  await bot.continueActive();
  assert.deepEqual(executed, [0, 1, 2]);
  assert.deepEqual(finished, ["Done."]);
});
