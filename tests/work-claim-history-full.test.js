// Contract guarded: ?history=full on the board list returns each claim's full
// stored history instead of the newest LIST_HISTORY_ENTRIES (3) entries; the
// default keeps the 3-entry summary with the rest counted in historyOmitted.
// (FR-HIST-303: PHOENIX found the 3-entry truncation hides lifecycle entries
// needed to spot double-apply corruption — the full lifecycle is only
// reachable on the single-claim read without this.)
//
// Gate answers: (1) observable contract — list honors ?history=full, default
// stays truncated, unknown values are 422; (2) credible regression — a change
// dropping the param 422s readers or silently truncates again; (3) no
// existing coverage touches list history projection; (4) no production seam:
// buildWorkClaimPage is the real shared projection the list route calls.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims, buildWorkClaimPage } from "../server/work-claim-routes.mjs";

const T0 = Date.parse("2026-10-07T12:00:00.000Z");
const M = 60 * 1000;

// 1 created + 1 claimed + 5 noted = 7 history entries.
const richClaim = now => {
  let item = createWork({ id: "rich" }, { now, agentId: "system" });
  item = claimWork(item, "quill", { now: now + M });
  for (let i = 1; i <= 5; i++) item = updateWork(item, "quill", { note: `progress ${i}`, now: now + (i + 1) * M });
  return item;
};

test("board list defaults to the 3 newest history entries, rest counted in historyOmitted", () => {
  const item = richClaim(T0);
  assert.equal(item.history.length, 7);
  const page = buildWorkClaimPage([item], "room1", "quill", new URLSearchParams(), T0 + 10 * M);
  assert.equal(page.historyLimit, 3);
  const [listed] = page.claims;
  assert.equal(listed.history.length, 3);
  assert.equal(listed.historyOmitted, 4);
  assert.equal(listed.history.at(-1).note, "progress 5"); // newest entries survive
  assert.equal(listed.history[0].note, "progress 3");
});

test("?history=full returns the whole stored history on the board list", () => {
  const item = richClaim(T0);
  const page = buildWorkClaimPage([item], "room1", "quill", new URLSearchParams("history=full"), T0 + 10 * M);
  assert.equal(page.historyLimit, null);
  const [listed] = page.claims;
  assert.equal(listed.history.length, 7);
  assert.equal(listed.history[0].action, "created"); // full lifecycle visible
  assert.equal(listed.history.at(-1).note, "progress 5");
  assert.ok(!("historyOmitted" in listed)); // nothing truncated away
});

test("?history=<anything-else> is 422", () => {
  assert.throws(
    () => buildWorkClaimPage([richClaim(T0)], "room1", "quill", new URLSearchParams("history=all"), T0 + 10 * M),
    error => error.status === 422 && error.code === "invalid_claim_input");
  assert.throws(
    () => buildWorkClaimPage([richClaim(T0)], "room1", "quill", new URLSearchParams("history=full&history=full"), T0 + 10 * M),
    error => error.status === 422 && error.code === "invalid_claim_input");
});

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const callList = (registry, query) => handleWorkClaims({
  req: { method: "GET", body: undefined }, res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: { roomAuthority: () => ({ members: {
    quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  } }) }, roomId: "room1", auth: { member: { id: "quill", kind: "agent", permissions: [] } },
  workClaimRoute: "list", workClaimId: null, helpers, registry,
});

test("the list route accepts ?history=full end to end", async () => {
  const registry = createWorkClaimRegistry();
  const now = Date.now();
  registry.set("room1", richClaim(now));
  const full = await callList(registry, "?history=full");
  assert.equal(full.status, 200);
  assert.equal(full.value.claims[0].history.length, 7);
  assert.equal(full.value.historyLimit, null);
  const def = await callList(registry, "");
  assert.equal(def.value.claims[0].history.length, 3);
  assert.equal(def.value.historyLimit, 3);
});
