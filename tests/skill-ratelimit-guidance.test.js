// PRODUCT-200 DOCS A5 (rate-limit guidance): skills/project-room/SKILL.md pins
// wire behavior for the throttle stack. These tests pin the pinned statements
// so docs/live drift fails loudly instead of silently misleading agents.
//
// Measured against server/http.mjs (2026-10-08):
// - the shared rate() buckets (write 60/min, login 10/min, ...) throw 429
//   with X-RateLimit-Limit/Remaining/Reset headers and NO Retry-After of
//   their own;
// - the request-handler catch (http.mjs ~L4936) then stamps EVERY 429 with a
//   hardcoded `Retry-After: 60` default, overridden only when the error
//   carries a real one (mint, chat flood guard, web-fetch quota, email
//   buckets). So a `Retry-After: 60` on a shared-bucket 429 is a placeholder:
//   the true wait is X-RateLimit-Reset, and the body message
//   ("Too many requests; retry after a minute") is approximate.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serveCommands(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return { f, origin: `http://127.0.0.1:${server.address().port}` };
}

test("write bucket: 61 rapid writes -> 429 with x-ratelimit headers and a hardcoded Retry-After: 60", async t => {
  const { f, origin } = await serveCommands(t);
  const post = body => fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.keys.owner}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: randomUUID(), type: "message.posted", data: { body } }),
  });
  let limited;
  for (let i = 0; i < 61; i++) {
    const res = await post(`a5 write probe ${i}`);
    if (i < 60) { await res.text(); continue; }
    limited = res;
  }
  // Every request spends a write token at the HTTP layer before dispatch, so
  // the 61st deterministically trips the 60/60s bucket even though the chat
  // flood guard may 429 some of the earlier posts (timing-dependent).
  assert.equal(limited.status, 429, "the 61st write in the window is refused");
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.message, "Too many requests; retry after a minute");
  assert.equal(limited.headers.get("x-ratelimit-limit"), "60");
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  // The hardcoded default: the doc says this 60 is a placeholder, not the
  // true wait. Pin it so a future fix that computes the real value must
  // update the doc too.
  assert.equal(limited.headers.get("retry-after"), "60",
    "shared-bucket 429s carry the hardcoded Retry-After: 60 default");
  const reset = Number(limited.headers.get("x-ratelimit-reset"));
  const nowEpoch = Math.floor(Date.now() / 1000);
  assert.ok(Number.isInteger(reset) && reset > nowEpoch - 5 && reset <= nowEpoch + 60,
    `x-ratelimit-reset is the true window end (epoch s), saw ${limited.headers.get("x-ratelimit-reset")}`);
  // The placeholder can overstate the remaining wait: the window opened on
  // the first request, so by the 61st the reset is strictly sooner than 60s
  // out (requests take non-zero time). The doc's rule: obey the reset header.
  assert.ok(reset <= nowEpoch + 59,
    `reset (${reset}) is sooner than the placeholder 60s wait (now ${nowEpoch})`);
});

test("login bucket: shared-bucket 429s also carry the hardcoded Retry-After: 60", async t => {
  const { origin } = await serveCommands(t);
  const login = () => fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "not-a-real-key" }),
  });
  for (let i = 0; i < 10; i++) await (await login()).text();
  const limited = await login();
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(limited.headers.get("x-ratelimit-limit"), "10");
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(Number(limited.headers.get("x-ratelimit-reset")) > 0, "x-ratelimit-reset present");
});
