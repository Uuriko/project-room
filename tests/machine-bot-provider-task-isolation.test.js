import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineBot } from "../machine/bot/loop.mjs";
import { createAnthropicProvider } from "../machine/bot/providers/anthropic.mjs";
import { createOpenAiProvider } from "../machine/bot/providers/openai.mjs";
import { createLocalProvider } from "../machine/bot/providers/local.mjs";
import { createDashaProvider } from "../machine/bot/providers/dasha.mjs";

// Issue #2869: MachineBot caches its provider forever (resolveProvider
// returns this.provider once created), and every provider seeds the task
// only when its conversation history is empty. On the bot's second task the
// new task text was therefore never appended: continueActive drains the
// observations, so the provider resent task 1's history and never saw
// task 2 at all. A new task must start a fresh conversation, while turns
// within one task must keep their history.

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

function capturingFetch(responseValue) {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse(typeof responseValue === "function" ? responseValue(bodies.length) : responseValue);
  };
  return { bodies, fetchImpl };
}

const PROVIDERS = [
  {
    label: "anthropic",
    make: fetchImpl => createAnthropicProvider({ key: "sk-test", model: "claude-test", fetchImpl }),
    response: { content: [{ type: "text", text: "done" }] },
  },
  {
    label: "openai",
    make: fetchImpl => createOpenAiProvider({ key: "sk-test", model: "gpt-test", fetchImpl }),
    response: n => ({ id: `resp_${n}`, output: [{ type: "message", content: [{ text: "done" }] }] }),
  },
  {
    label: "local",
    make: fetchImpl => createLocalProvider({ model: "llama-test", vision: false, fetchImpl }),
    response: { message: { content: "done" } },
  },
  {
    label: "dasha",
    make: fetchImpl => createDashaProvider({ key: "sk-test", model: "room-bot", fetchImpl }),
    response: { choices: [{ message: { content: "done" } }] },
  },
];

for (const { label, make, response } of PROVIDERS) {
  test(`${label}: a second task is sent to the model and the first task's history is not resent`, async () => {
    const { bodies, fetchImpl } = capturingFetch(response);
    const provider = make(fetchImpl);

    await provider.next({ task: "first task text", observations: [] });
    assert.match(JSON.stringify(bodies[0]), /first task text/);

    // The loop drains observations between tasks, so the first turn of a
    // new task arrives with no observations — exactly the shape that used
    // to fall through and resend the previous conversation untouched.
    await provider.next({ task: "second task text", observations: [] });

    assert.equal(bodies.length, 2);
    const second = JSON.stringify(bodies[1]);
    assert.match(second, /second task text/, "the new task text must reach the model");
    assert.doesNotMatch(second, /first task text/, "the previous task's history must not leak into the new task");
    assert.equal(bodies[1].previous_response_id, undefined, "no stale vendor conversation id may carry over");
  });

  test(`${label}: reset() clears the conversation so the next task starts fresh`, async () => {
    const { bodies, fetchImpl } = capturingFetch(response);
    const provider = make(fetchImpl);

    await provider.next({ task: "first task text", observations: [] });
    assert.equal(typeof provider.reset, "function", "cached providers must expose reset()");
    provider.reset();
    await provider.next({ task: "second task text", observations: [] });

    const second = JSON.stringify(bodies[1]);
    assert.match(second, /second task text/);
    assert.doesNotMatch(second, /first task text/);
    assert.equal(bodies[1].previous_response_id, undefined);
  });
}

test("anthropic: turns within one task keep their history and tool results", async () => {
  const { bodies, fetchImpl } = capturingFetch(n => (n === 1
    ? { content: [{ type: "tool_use", id: "toolu_1", input: { action: "screenshot" } }] }
    : { content: [{ type: "text", text: "done" }] }));
  const provider = createAnthropicProvider({ key: "sk-test", model: "claude-test", fetchImpl });

  await provider.next({ task: "same task", observations: [] });
  await provider.next({
    task: "same task",
    observations: [{ id: "toolu_1", tool: "desktop.screenshot", result: { ok: true } }],
  });

  const second = JSON.stringify(bodies[1]);
  assert.match(second, /same task/, "the in-task conversation must be retained");
  assert.match(second, /tool_result/);
});

test("openai: turns within one task keep the previous_response_id chain", async () => {
  const { bodies, fetchImpl } = capturingFetch(n => ({ id: `resp_${n}`, output: [{ type: "message", content: [{ text: "done" }] }] }));
  const provider = createOpenAiProvider({ key: "sk-test", model: "gpt-test", fetchImpl });

  await provider.next({ task: "same task", observations: [] });
  await provider.next({
    task: "same task",
    observations: [{ callId: "call_1", tool: "desktop.screenshot", image: "data:image/png;base64,a", result: {} }],
  });

  assert.equal(bodies[1].previous_response_id, "resp_1", "in-task follow-ups must chain onto the same response");
});

// Loop level: begin() starts each new task, so it must reset the cached
// provider there — even when the new task's text is identical to the old
// one, where no provider-side task-change check could tell them apart.
test("bot: begin() resets the cached provider before a successive task, even with identical text", async t => {
  const home = mkdtempSync(join(tmpdir(), "room-bot-provider-reset-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const daemon = { state: { halted: false, pausedUntil: null, slots: { desk: null, scratch: null }, running: {} } };

  const sent = [];
  let history = [];
  let resets = 0;
  const provider = {
    name: "stateful",
    computerUse: true,
    reset() { resets += 1; history = []; },
    async next({ task, observations }) {
      if (history.length === 0) history.push(task);
      else if (observations.length > 0) history.push("observation");
      sent.push(JSON.stringify(history));
      history.push("assistant reply");
      return { actions: [], text: "Done.", costUsd: 0 };
    },
  };

  const bot = new MachineBot({ home, env: {}, daemon, provider });
  bot.bot = { rooms: ["commons"], tier: "t3", goMembers: [], maxSteps: 50, maxWallMs: 60_000, maxSpendUsd: 1, progressIntervalMs: 3_600_000 };
  bot.config = { machineId: "mac-1", ownerMemberId: "owner" };
  bot.api = {
    pause: async () => ({ ok: true, status: 200, value: { pause: null, memberId: "bot-member" } }),
    claims: async () => ({ ok: true, status: 200, value: { claims: [] } }),
    createClaim: async (_roomId, body) => ({ ok: true, status: 201, value: { id: body.id } }),
    takeClaim: async (_roomId, id) => ({ ok: true, status: 200, value: { id } }),
    updateClaim: async () => ({ ok: true, status: 200, value: {} }),
    post: async () => ({ ok: true, status: 201, messageId: "p" }),
  };

  const source = text => ({
    kind: "work", roomId: "commons", messageId: "m1", workItemId: null,
    updateId: null, basisToken: null, text,
  });

  await bot.begin(source("repeatable task"));
  assert.ok(bot.active, "first task started");
  await provider.next({ task: bot.active.text, observations: [] });
  bot.active = null; // task 1 finished/stopped: finish()/stopEarly() clear it

  await bot.begin(source("repeatable task"));
  assert.ok(bot.active, "second task started");
  assert.ok(resets >= 1, "begin() must reset the cached provider for the new task");
  await provider.next({ task: bot.active.text, observations: [] });

  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[1], /assistant reply/, "task 1's conversation must not be resent for task 2");
  assert.match(sent[1], /repeatable task/);
});
