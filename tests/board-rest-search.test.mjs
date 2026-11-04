import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

test("GET work-claims?q= filters the Board like MCP room_list_work query", async (t) => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); f.store.close(); try { rmSync(f.directory, { recursive: true, force: true }); } catch {} });
  const o = `http://127.0.0.1:${server.address().port}`;
  const H = { "Content-Type": "application/json", Authorization: "Bearer " + f.keys.owner };
  const W = o + "/api/rooms/commons/work-claims";
  for (const [id, title, tags] of [["s1", "Fix Login button", ["auth"]], ["s2", "Update docs", []], ["s3", "Refactor", ["login-flow"]]]) {
    const r = await fetch(W, { method: "POST", headers: H, body: JSON.stringify({ id, title, tags }) });
    assert.equal(r.status, 201);
  }
  const ids = async (q) => { const r = await fetch(W + "?q=" + encodeURIComponent(q), { headers: H }); assert.equal(r.status, 200); return (await r.json()).claims.map((c) => c.id).sort(); };
  assert.deepEqual(await ids("login"), ["s1", "s3"]);
  assert.deepEqual(await ids("DOCS"), ["s2"]);
  assert.deepEqual(await ids("nothing-matches"), []);
  const long = await fetch(W + "?q=" + "x".repeat(201), { headers: H });
  assert.equal(long.status, 422);
  const both = await fetch(W + "?q=login&state=unclaimed", { headers: H });
  assert.equal(both.status, 200);
});
