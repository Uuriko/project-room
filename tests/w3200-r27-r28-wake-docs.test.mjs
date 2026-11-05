// W3200 R-27/R-28 — the served wake-poll contract must state the truth the
// code implements, so an agent following only the packet/SKILL.md/OpenAPI
// can poll and retry correctly.
//
// Code truth at 7e54844d (re-derived, file:line):
// - hostId derivation: server/agent-plugin-routes.mjs:1018-1019 — an omitted
//   hostId is derived when the identity has exactly one registered host;
//   422 invalid_wake_poll only when several hosts make it ambiguous; no
//   host at all answers 404 agent_not_registered via notePoll.
// - cursor/nextCursor: poll accepts `cursor` (agent-plugin-routes.mjs:1039),
//   answers `nextCursor` (:1094); a scope-mismatched cursor is 422
//   invalid_wake_cursor (server/agent-heartbeats.mjs:1136). roomId narrows
//   the poll; order is oldest (default) or newest (newest needs a room).
// - poll rate: rate(`agent-wake-poll:${identityId}`, 30)
//   (agent-plugin-routes.mjs:973) over the fixed 60 s window in
//   server/http.mjs:922; the 429 for this family alone carries a true
//   Retry-After (server/http.mjs:932).
// - retry contract: client/wake-retry.mjs:14-33 — transient 429/5xx/status-0/
//   timeout retried with 1 s -> 30 s exponential backoff, a server
//   Retry-After taken as a floor capped at 5 minutes; 401/403 are fatal.
// - events `after`: server/store.mjs:6712 selects `sequence>?`, so the page
//   holds events strictly AFTER `after` — never strictly before it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { skillMd, llmsFullTxt } from "../server/agent-discovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(join(root, rel), "utf8");

// Every served packet surface that carries the wake-poll instruction:
// SKILL.md (skillMd) and the full packet (llmsFullTxt) both interpolate the
// one WAKE_POLL_INSTRUCTION constant and the step-5 guide.
const packet = `${skillMd()}\n${llmsFullTxt()}`;
const pollFragment = read("server/openapi/fragments/0270-api-agent-wakes-poll.yaml");
const eventsFragment = read("server/openapi/fragments/0030-api-rooms-roomId-events.yaml");
const openapi = read("docs/openapi.yaml");

test("R-27: no served surface claims polling without hostId flatly returns 422", () => {
  assert.ok(!packet.includes("Polling without `hostId` returns 422"),
    "packet still claims a flat 422 for an omitted hostId");
  assert.ok(!/hostId is required/.test(pollFragment.replace(/Required when/, "")),
    "OpenAPI poll fragment still presents hostId as flatly required");
});

test("R-27: packet states hostId derivation (exactly one registered host)", () => {
  assert.match(packet, /exactly one registered host/);
  assert.match(packet, /derived/);
  assert.match(packet, /several registered hosts|more than one|ambiguous/);
});

test("R-27: packet states poll cursor/nextCursor, roomId and order", () => {
  assert.match(packet, /nextCursor/);
  assert.match(packet, /[?&]cursor=|pass .*nextCursor.* as .*cursor/i);
  assert.match(packet, /roomId/);
  assert.match(packet, /order=newest|order is `?oldest`?/);
});

test("R-27: packet states the 30-per-minute fixed-window poll rate and its 429 Retry-After", () => {
  assert.match(packet, /30 (requests )?per (identity per )?minute|30\/min/);
  assert.match(packet, /fixed (60-second |60s )?window/);
  assert.match(packet, /Retry-After/);
});

test("R-27: OpenAPI events `after` is not inverted (page is strictly after `after`)", () => {
  for (const [name, text] of [["fragment", eventsFragment], ["docs/openapi.yaml", openapi]]) {
    assert.ok(!text.includes("Sequence strictly before the page"),
      `${name} still describes events after as strictly before the page`);
  }
  assert.match(eventsFragment, /strictly after/);
});

test("R-27: OpenAPI poll 429 names the Retry-After the server sends for this family", () => {
  assert.match(pollFragment, /Retry-After/);
  assert.match(pollFragment, /fixed/);
});

test("R-28: packet states the wake-poll retry contract (transient vs fatal)", () => {
  assert.match(packet, /429/);
  assert.match(packet, /5xx|500/);
  assert.match(packet, /timeout/i);
  assert.match(packet, /backoff/);
  assert.match(packet, /1 ?s.*30 ?s|1 second.*30 seconds/);
  assert.match(packet, /5 minutes|5-minute|300 ?s/);
  assert.match(packet, /401\/403|401 or 403/);
  assert.match(packet, /fatal|stop|do not retry/i);
});
