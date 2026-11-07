// PERF-50 E2-a: the hosted MCP door used to be capped at 60 requests per
// fixed 60 s window per client ADDRESS (family "mcp-join"), every method
// and every identity sharing the one bucket. A host running 10 agents
// behind one egress address gave each agent 6 MCP calls/min, and the 61st
// request from the address 429'd no matter which identity sent it.
//
// The door is now keyed per authenticated identity (bearer hash):
//   - a presented bearer gets its own 300/min bucket (family "mcp");
//   - every authenticated request also counts against a 600/min
//     per-address backstop (family "mcp-addr"), so rotating identities
//     behind one address cannot exceed the aggregate ceiling;
//   - anonymous join traffic (no bearer) keeps the original 60/min
//     per-address bucket (family "mcp-join") unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const first = store.identities.create("MCP door rate one");
  const second = store.identities.create("MCP door rate two");
  const third = store.identities.create("MCP door rate three");
  // Tests pick the visitor address per request, standing in for many clients.
  const server = createRoomServer({ store, resolveClientAddress: req => req.headers["x-test-address"] || "127.0.0.1" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const list = (address, secret) => fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "X-Test-Address": address,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "door-rate", method: "tools/list", params: {} })
  });
  // Fire `count` calls in parallel batches and return every status.
  const burst = async (address, secret, count) => {
    const statuses = [];
    for (let done = 0; done < count; done += 100) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(100, count - done) }, () => list(address, secret).then(r => r.status))
      );
      statuses.push(...batch);
    }
    return statuses;
  };
  return { first, second, third, list, burst };
}

test("two identities from one address each get their own MCP allowance", async t => {
  const { first, second, list, burst } = await serve(t);
  const address = "10.4.0.1";
  // The first identity can use its full 300/min working budget from this
  // address — five times the old shared 60/min address bucket.
  const firstStatuses = await burst(address, first.secret, 300);
  assert.ok(firstStatuses.every(status => status === 200), `first identity: ${firstStatuses.join(",")}`);
  // Its 301st request is refused by its OWN bucket, not the address's.
  const over = await list(address, first.secret);
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("x-ratelimit-bucket"), "mcp");
  assert.equal(over.headers.get("x-ratelimit-limit"), "300");
  assert.equal((await over.json()).error.code, "rate_limited");
  // A second identity from the SAME address still has its own allowance:
  // under the old keying this request was the address's 302nd and 429'd.
  const other = await list(address, second.secret);
  assert.equal(other.status, 200, "second identity keeps its own allowance from the same address");
});

test("the per-address backstop still trips at its aggregate limit", async t => {
  const { first, second, third, list, burst } = await serve(t);
  const address = "10.4.0.2";
  // Two identities together fill the 600/min address backstop, each within
  // its own per-identity budget (300 + 300).
  assert.ok((await burst(address, first.secret, 300)).every(status => status === 200));
  assert.ok((await burst(address, second.secret, 300)).every(status => status === 200));
  // The 601st authenticated request from the address — from a third
  // identity whose own bucket is untouched — hits the backstop.
  const over = await list(address, third.secret);
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("x-ratelimit-bucket"), "mcp-addr");
  assert.equal(over.headers.get("x-ratelimit-limit"), "600");
  assert.equal((await over.json()).error.code, "rate_limited");
  // The same third identity from a different address is unaffected.
  const elsewhere = await list("10.4.0.3", third.secret);
  assert.equal(elsewhere.status, 200);
});

test("anonymous MCP traffic keeps the original 60/min per-address bucket", async t => {
  const { list, burst } = await serve(t);
  const address = "10.4.0.4";
  assert.ok((await burst(address, null, 60)).every(status => status === 200));
  const over = await list(address, null);
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("x-ratelimit-bucket"), "mcp-join");
  assert.equal(over.headers.get("x-ratelimit-limit"), "60");
  assert.equal((await list("10.4.0.5", null)).status, 200, "a different address keeps its own allowance");
});
