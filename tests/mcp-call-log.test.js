import test from "node:test";
import assert from "node:assert/strict";
import { summarizeMcpCall, withMcpCallLog } from "../server/mcp-call-log.mjs";

const call = (name, args = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("summary keeps only tool, outcome, reason, latency", () => {
  const s = summarizeMcpCall(call("room_post_message", { body: "secret text", roomId: "r1" }), { result: { content: [] } }, 12.34);
  assert.deepEqual(s, { event: "room.mcp_call", tool: "room_post_message", outcome: "ok", reason: null, ms: 12.3 });
  assert.equal(JSON.stringify(s).includes("secret"), false);
  assert.equal(JSON.stringify(s).includes("r1"), false);
});

test("tool errors, rpc errors and unsafe names", () => {
  assert.equal(summarizeMcpCall(call("x"), { result: { isError: true, structuredContent: { reason: "stale_revision" } } }, 1).reason, "stale_revision");
  assert.equal(summarizeMcpCall(call("x"), { result: { isError: true, structuredContent: { reason: "has spaces and Bearer abc" } } }, 1).reason, "tool_error");
  assert.deepEqual(summarizeMcpCall(call("x"), { error: { code: -32602 } }, 1).outcome, "rpc_error");
  assert.equal(summarizeMcpCall(call("bad name!"), {}, 1).tool, "unknown");
});

test("off by default; on logs once per tools/call and never breaks the call", async () => {
  const lines = [];
  const h = async () => ({ result: { content: [] } });
  await withMcpCallLog(h, { env: {}, sink: l => lines.push(l) })(call("a"));
  assert.equal(lines.length, 0);
  const on = withMcpCallLog(h, { env: { ROOM_MCP_CALL_LOG: "1" }, sink: l => lines.push(l) });
  await on({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  await on(call("a"));
  assert.equal(lines.length, 1);
  const boom = withMcpCallLog(h, { env: { ROOM_MCP_CALL_LOG: "1" }, sink: () => { throw new Error("sink down"); } });
  assert.deepEqual(await boom(call("a")), { result: { content: [] } });
  const thrower = withMcpCallLog(async () => { const e = new Error("x"); e.code = "no_access"; throw e; }, { env: { ROOM_MCP_CALL_LOG: "1" }, sink: l => lines.push(l) });
  await assert.rejects(thrower(call("b")));
  assert.equal(lines.at(-1).outcome, "thrown");
  assert.equal(lines.at(-1).reason, "no_access");
});

test('token-shaped untrusted tool names and error codes never enter logs', async()=>{
 const marker='synthetic_secret_abc123';
 const lines=[];
 const h=withMcpCallLog(async()=>({result:{isError:true,structuredContent:{code:marker}}}),{env:{ROOM_MCP_CALL_LOG:'1'},sink:l=>lines.push(l)});
 await h(call(marker));assert.equal(JSON.stringify(lines).includes(marker),false);
 assert.equal(summarizeMcpCall(call('room_post_message'),{error:{code:marker}},1).reason,'rpc_error');
 assert.equal(summarizeMcpCall(call('room_post_message'),null,1,{code:marker,name:marker}).reason,'error');
});
