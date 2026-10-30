#!/usr/bin/env node
// Lives outside any test/ directory so the default `node --test` glob does not run it.
// Scripted ACP agent for tests. Mode via FAKE_ACP_MODE:
//   echo (default)   replies "echo: <prompt text>"
//   slow             waits FAKE_ACP_DELAY_MS (default 300) before replying
//   crash-mid-turn   exits during the first prompt of each process
//   ask-permission   requests permission, replies with the chosen optionId
//   no-loadSession   like echo but does not advertise loadSession
//   tools            emits a plan and tool calls before replying
import { createPeer } from "../src/jsonrpc.mjs";

const mode = process.env.FAKE_ACP_MODE ?? "echo";
const delay = Number(process.env.FAKE_ACP_DELAY_MS ?? 300);
const sessions = new Map();
let counter = 0;
const textOf = prompt => (Array.isArray(prompt) ? prompt : []).filter(block => block?.type === "text").map(block => block.text).join("\n");

const peer = createPeer({
  input: process.stdin, output: process.stdout,
  async onRequest(method, params) {
    if (method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: mode !== "no-loadSession", promptCapabilities: { embeddedContext: true } }, authMethods: [], agentInfo: { name: "fake-acp", version: "1" } };
    if (method === "session/new") { const sessionId = `fake-${process.pid}-${++counter}`; sessions.set(sessionId, []); return { sessionId }; }
    if (method === "session/load") { if (mode === "no-loadSession") throw Object.assign(new Error("loadSession unsupported"), { code: -32601 }); sessions.set(params.sessionId, sessions.get(params.sessionId) ?? []); return null; }
    if (method === "session/set_mode") return null;
    if (method === "session/prompt") {
      const text = textOf(params.prompt);
      sessions.get(params.sessionId)?.push(text);
      const say = chunk => peer.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } } });
      if (mode === "crash-mid-turn") { setTimeout(() => process.exit(3), 20); return new Promise(() => {}); }
      if (mode === "slow") await new Promise(resolve => setTimeout(resolve, delay));
      if (mode === "tools") {
        peer.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "plan", entries: [{ content: "read file", status: "completed" }, { content: "run tests", status: "completed" }] } });
        peer.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET THOUGHT" } } });
        peer.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit src/x.ts", kind: "edit", status: "completed" } });
        peer.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "npm test", kind: "execute", status: "completed" } });
      }
      if (mode === "ask-permission") {
        const answer = await peer.request("session/request_permission", { sessionId: params.sessionId, toolCall: { toolCallId: "p1", title: "Run rm -rf build", kind: "execute" }, options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }, { optionId: "reject_once", name: "Reject", kind: "reject_once" }] }).catch(() => ({ outcome: { outcome: "cancelled" } }));
        say(`permission: ${answer?.outcome?.outcome === "selected" ? answer.outcome.optionId : "cancelled"}`);
        return { stopReason: "end_turn" };
      }
      say("echo: ");
      say(text);
      return { stopReason: "end_turn" };
    }
    throw Object.assign(new Error("Method not found"), { code: -32601 });
  },
});
