import test from "node:test";
import assert from "node:assert/strict";
import { completeChat, MissingOpenAIKeyError, OPENAI_URL, DEFAULT_MODEL, KEY_ENV } from "../server/openai-complete.mjs";
import { main, missingOperatorEnv, replyCommand, runCycle, AGENT_KEY_ENV } from "../scripts/room-openai-agent.mjs";

const openaiEnv = "openai-env-present";
const agentEnv = "agent-env-present";
const assistantReply = "Room-visible fixture reply.";

function directedPage(viewerId = "room-agent") {
  return {
    events: [{
      sequence: 4,
      event: {
        id: "evt-ask",
        type: "message.posted",
        actorId: "owner",
        data: { messageId: "msg-ask", body: "What is the room pulse?", toMemberId: viewerId }
      }
    }],
    next: 4,
    hasMore: false
  };
}

function mockFetch(calls, { openaiText = assistantReply, roomEvents = directedPage() } = {}) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === OPENAI_URL) {
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { role: "assistant", content: openaiText } }] })
      };
    }
    if (String(url).endsWith("/api/session")) {
      return { ok: true, json: async () => ({ member: { id: "room-agent" }, roomId: "commons" }) };
    }
    if (String(url).includes("/events")) {
      return { ok: true, json: async () => roomEvents };
    }
    if (String(url).includes("/commands")) {
      return { ok: true, status: 201, json: async () => ({ duplicate: false }) };
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

test("missing OpenAI key refuses and does not fetch", async () => {
  const calls = [];
  await assert.rejects(
    () => completeChat({
      env: {},
      fetchImpl: mockFetch(calls),
      messages: [{ role: "user", content: "hello" }]
    }),
    error => error instanceof MissingOpenAIKeyError && error.code === "missing_openai_key"
  );
  assert.equal(calls.length, 0);
});

test("missing operator env exits non-zero and posts nothing", async () => {
  const calls = [];
  const lines = [];
  assert.deepEqual(missingOperatorEnv({}), [AGENT_KEY_ENV, KEY_ENV]);
  const code = await main({ ROOM_AGENT_ORIGIN: "http://127.0.0.1:4173" }, {
    error(message) { lines.push(message); }
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /ROOM_AGENT_KEY/);
  assert.match(lines.join("\n"), /PROJECT_ROOM_OPENAI_API_KEY/);
  assert.equal(calls.length, 0);
  const openaiMissing = await runCycle({
    env: { [AGENT_KEY_ENV]: agentEnv },
    fetchImpl: mockFetch(calls)
  });
  assert.equal(openaiMissing.ok, false);
  assert.equal(openaiMissing.posted, false);
  assert.deepEqual(openaiMissing.missing, [KEY_ENV]);
  assert.equal(openaiMissing.command, null);
  assert.equal(calls.length, 0);
});

test("successful completion posts one room message and omits the key from the command body", async () => {
  const calls = [];
  const env = {
    [KEY_ENV]: openaiEnv,
    [AGENT_KEY_ENV]: agentEnv,
    ROOM_AGENT_ORIGIN: "http://127.0.0.1:4173",
    ROOM_AGENT_ROOM: "commons"
  };
  const result = await runCycle({
    env,
    fetchImpl: mockFetch(calls),
    after: 0,
    ids: { commandId: "cmd-reply-1", messageId: "msg-reply-1" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.posted, true);
  const openaiCalls = calls.filter(call => call.url === OPENAI_URL);
  const commandCalls = calls.filter(call => call.url.includes("/commands"));
  assert.equal(openaiCalls.length, 1);
  assert.equal(commandCalls.length, 1);
  const openaiBody = JSON.parse(openaiCalls[0].options.body);
  assert.equal(openaiBody.model, DEFAULT_MODEL);
  assert.equal(openaiCalls[0].options.headers.Authorization, `Bearer ${openaiEnv}`);
  const command = JSON.parse(commandCalls[0].options.body);
  assert.equal(command.type, "message.posted");
  assert.equal(command.data.body, assistantReply);
  assert.equal(commandCalls[0].options.headers.Authorization, `Bearer ${agentEnv}`);
  const outbound = JSON.stringify(command);
  assert.equal(outbound.includes(openaiEnv), false);
  assert.equal(outbound.includes(agentEnv), false);
  assert.equal(outbound.includes("Authorization"), false);
  assert.equal(JSON.stringify(result.command), outbound);
  const rebuilt = replyCommand(directedPage().events[0].event, assistantReply, {
    commandId: "cmd-reply-1",
    messageId: "msg-reply-1"
  });
  assert.equal(JSON.stringify(rebuilt).includes(openaiEnv), false);
});
