// T062 (John's Tab backlog): a size refusal states the limit and the size
// that was refused, so the caller knows how far over it is and what to send.
// Covers the projection cap (pilot_limit, every server site through one
// helper), the store's command cap, and the MCP join body cap.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, PILOT_LIMITS, projectionLimitMessage } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { agentErrorAx } from "../src/agent-error.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function openStore(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-t062-"));
  let clock = Date.parse("2026-10-06T00:00:00Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => (clock += 120_000), ...options });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner };
}

test("the projection-cap refusal states the size the change would reach and the limit", t => {
  const { store, owner } = openStore(t, { bodiesAtRest: false });
  const bodyChars = 45_000;
  let refused = null;
  for (let i = 0; i < Math.ceil(PILOT_LIMITS.projectionBytes / bodyChars) + 3 && !refused; i += 1) {
    try { store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m${i}`, body: `m${i} `.padEnd(bodyChars, "x") } }); }
    catch (error) { refused = error; }
  }
  assert.ok(refused, "inline bodies reach the cap");
  assert.equal(refused.code, "pilot_limit");
  const sized = /would make the room (\d+) bytes; the limit is (\d+) bytes/.exec(refused.message);
  assert.ok(sized, refused.message);
  assert.equal(Number(sized[2]), PILOT_LIMITS.projectionBytes);
  assert.ok(Number(sized[1]) > PILOT_LIMITS.projectionBytes, `${sized[1]} is over the limit`);
  assert.ok(Number(sized[1]) - PILOT_LIMITS.projectionBytes < bodyChars * 2, "the stated size is this change's, not a guess");
  assert.match(refused.message, /no data was changed/);
  assert.match(refused.message, /room owner/, "the recovery stays named");
});

test("every projection-cap refusal in server/ goes through projectionLimitMessage", () => {
  const dir = new URL("../server/", import.meta.url);
  const offenders = [];
  for (const name of readdirSync(dir).filter(file => file.endsWith(".mjs"))) {
    const source = readFileSync(new URL(name, dir), "utf8");
    let index = source.indexOf("PILOT_LIMITS.projectionBytes)");
    while (index !== -1) {
      // The statement the check guards runs to its first ";" (an if-block's
      // fail(...) included); a break/continue there is not a refusal.
      const end = source.indexOf(";", index);
      const statement = source.slice(index, end === -1 ? index + 300 : end + 1);
      if (/fail\(\s*409\s*,\s*["']pilot_limit["']/.test(statement) && !/fail\(\s*409\s*,\s*["']pilot_limit["']\s*,\s*projectionLimitMessage\(/.test(statement)) {
        offenders.push(`${name}:${source.slice(0, index).split("\n").length}`);
      }
      index = source.indexOf("PILOT_LIMITS.projectionBytes)", index + 1);
    }
  }
  assert.deepEqual(offenders, []);
  assert.match(projectionLimitMessage(4_200_000), /4200000 bytes; the limit is 4194304 bytes/);
});

test("an oversized command states its size and the cap; the agent hint keeps the same-id advice", t => {
  const { store, owner } = openStore(t);
  let refused = null;
  const command = { id: randomUUID(), type: T.MESSAGE_PINNED, data: { messageId: "x".repeat(20_000) } };
  try { store.command(owner, "commons", command); } catch (error) { refused = error; }
  assert.ok(refused, "a 20 KB non-message command is refused");
  assert.equal(refused.code, "too_large");
  const sized = /^Command is too large: (\d+) bytes; the limit is (\d+) bytes$/.exec(refused.message);
  assert.ok(sized, refused.message);
  assert.equal(Number(sized[1]), Buffer.byteLength(JSON.stringify(command)));
  assert.equal(Number(sized[2]), 16384);
  const ax = agentErrorAx({ httpStatus: 413, code: "too_large", message: refused.message });
  assert.match(ax.hint, new RegExp(`${sized[1]} bytes; the limit is 16384 bytes`));
  assert.match(JSON.stringify(ax.next), /same id/i);
  const legacy = agentErrorAx({ httpStatus: 413, code: "too_large", message: "Command is too large" });
  assert.match(legacy.hint, /524288/, "an older server's bare refusal still names both caps");
});

test("the MCP endpoint's body cap states the size it saw and the limit", async t => {
  const { store } = openStore(t);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "y".repeat(20_000) } });
  const response = await fetch(`${origin}/mcp`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: payload });
  const text = await response.text();
  assert.equal(response.status, 413, text);
  assert.match(text, new RegExp(`Request body is ${Buffer.byteLength(payload)} bytes; the limit is 16384 bytes`));
});
