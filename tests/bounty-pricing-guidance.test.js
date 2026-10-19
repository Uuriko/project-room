// #3524: pricing guidance at post time, derived from the room's own settled
// receipt history. Covers the three filed acceptance bullets:
//   1. The posting flow shows a guidance panel (typical paid range for this
//      room; cold-start fallback with no invented numbers).
//   2. Guidance is read-only; it never blocks posting — posting completes
//      identically with the panel present, absent, or failing.
//   3. Numbers are derived from settled receipts only, labelled as such.
// The derivation is room-level by design: no similarity engine, no
// cross-room data (proven below by settling in one room and reading
// another). Amounts are the settled (net) amounts workers received.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { BountyEscrow, derivePricingGuidance } from "../server/bounty-escrow.mjs";
import { ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";
import {
  bountyBoardModel, pricingGuidanceHtml, installBountyBoard,
} from "../src/bounty-board.js";

// --- pure derivation ---------------------------------------------------------

test("derivePricingGuidance: hand-computed range and median from a settled fixture", () => {
  // Settled paid amounts (millis): 10, 20, 30, 40 credits — range 10–40,
  // median (20+30)/2 = 25. Rubric pins: 1, 2, 1, 1 criteria. Modes: 3 human,
  // 1 agent.
  const guidance = derivePricingGuidance([
    { paidMillis: 30000, approvalMode: "human", rubricCriteria: 1 },
    { paidMillis: 10000, approvalMode: "human", rubricCriteria: 1 },
    { paidMillis: 40000, approvalMode: "agent", rubricCriteria: 2 },
    { paidMillis: 20000, approvalMode: "human", rubricCriteria: 1 },
  ]);
  assert.equal(guidance.source, "settled-receipts");
  assert.equal(guidance.coldStart, false);
  assert.equal(guidance.settledCount, 4);
  assert.deepEqual(guidance.paidRangeCredits, { min: 10, max: 40 });
  assert.equal(guidance.medianPaidCredits, 25);
  assert.deepEqual(guidance.approvalModes, { human: 3, agent: 1 });
  assert.deepEqual(guidance.rubricCriteria, { min: 1, max: 2 });
});

test("derivePricingGuidance: odd count takes the middle settled amount", () => {
  const guidance = derivePricingGuidance([
    { paidMillis: 5000, approvalMode: "human", rubricCriteria: 1 },
    { paidMillis: 15000, approvalMode: "human", rubricCriteria: 1 },
    { paidMillis: 10000, approvalMode: "human", rubricCriteria: 1 },
  ]);
  assert.equal(guidance.settledCount, 3);
  assert.deepEqual(guidance.paidRangeCredits, { min: 5, max: 15 });
  assert.equal(guidance.medianPaidCredits, 10);
});

test("derivePricingGuidance: cold start is a shape with no numbers, and zero-paid settlements never enter", () => {
  for (const entries of [[], null, undefined,
    [{ paidMillis: 0, approvalMode: "human", rubricCriteria: 1 }],
    [{ paidMillis: -500, approvalMode: "human", rubricCriteria: 1 }],
  ]) {
    const guidance = derivePricingGuidance(entries);
    assert.equal(guidance.coldStart, true);
    assert.equal(guidance.settledCount, 0);
    assert.equal(guidance.paidRangeCredits, null);
    assert.equal(guidance.medianPaidCredits, null);
    assert.equal(guidance.rubricCriteria, null);
  }
});

// --- escrow-level derivation from real settled lifecycles ---------------------

const ROOM = "room-guidance";
const EMPTY = "room-no-history";
const REJECTED = "room-rejected-only";
const OPEN = "room-open-only";
const JILL = "id:agent/jill";        // poster
const GROK = "id:agent/grokbot";     // worker
const INSTINCT = "id:agent/instinct"; // verifier

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT guidance_test");
    try { const out = fn(); db.exec("RELEASE guidance_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO guidance_test"); db.exec("RELEASE guidance_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

// Post -> fund -> claim -> submit -> accept for one bounty in a room.
function runToAccepted(escrow, room, { amount, rubric = null, approvalMode = "human" } = {}) {
  const { bounty } = escrow.postBounty(room, {
    poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(30 * 24 * 3600_000),
    approvalMode, verifierId: approvalMode === "agent" ? INSTINCT : null, rubric,
  });
  escrow.fundBounty(room, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(room, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(room, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  const criterionIds = rubric ? rubric.map(c => c.criterionId) : ["c1"];
  escrow.acceptWork(room, bounty.bountyId, {
    acceptor: approvalMode === "agent" ? INSTINCT : JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: criterionIds.map(criterionId => ({ criterionId, verdict: "pass" })) },
  });
  return bounty.bountyId;
}

function settleAccepted(escrow, room, bountyId) {
  tick(3 * 24 * 3600_000 + 1); // past the 3-day challenge window
  escrow.finalizeBounty(room, bountyId, { caller: GROK });
  escrow.closeEpoch(room, { caller: JILL });
}

test("pricingGuidance: settled lifecycles give the hand-computed room range; other rooms stay cold", () => {
  const { escrow } = makeEscrow();
  // Four settled bounties in ROOM: posted 10 / 20 / 30 / 40 credits. The
  // sweep pays 99% (1% room-pool fee), so workers received
  // 9.9 / 19.8 / 29.7 / 39.6 — range 9.9–39.6, median (19.8+29.7)/2 = 24.75.
  // One pinned a 2-criterion rubric; the 30-credit one used agent approval.
  settleAccepted(escrow, ROOM, runToAccepted(escrow, ROOM, { amount: 10 }));
  settleAccepted(escrow, ROOM, runToAccepted(escrow, ROOM, { amount: 20,
    rubric: [{ criterionId: "a", description: "A" }, { criterionId: "b", description: "B" }] }));
  settleAccepted(escrow, ROOM, runToAccepted(escrow, ROOM, { amount: 30, approvalMode: "agent" }));
  settleAccepted(escrow, ROOM, runToAccepted(escrow, ROOM, { amount: 40 }));

  const guidance = escrow.pricingGuidance(ROOM);
  assert.equal(guidance.roomId, ROOM);
  assert.equal(guidance.source, "settled-receipts");
  assert.equal(guidance.coldStart, false);
  assert.equal(guidance.settledCount, 4, "from 4 settled bounties in this room");
  assert.deepEqual(guidance.paidRangeCredits, { min: 9.9, max: 39.6 });
  assert.equal(guidance.medianPaidCredits, 24.75);
  assert.deepEqual(guidance.approvalModes, { human: 3, agent: 1 });
  assert.deepEqual(guidance.rubricCriteria, { min: 1, max: 2 });

  // No cross-room leakage: a room with no settled receipts is a cold start
  // even though ROOM has history.
  const cold = escrow.pricingGuidance(EMPTY);
  assert.equal(cold.coldStart, true);
  assert.equal(cold.settledCount, 0);
  assert.equal(cold.paidRangeCredits, null);
  assert.equal(cold.medianPaidCredits, null);
});

test("pricingGuidance: unsettled and zero-paid settlements never count", () => {
  const { escrow } = makeEscrow();
  // A funded-but-unsettled bounty in OPEN contributes nothing.
  const { bounty: openBounty } = escrow.postBounty(OPEN,
    { poster: JILL, title: "T", criteria: "C", amount: 50, deadline: isoFuture(3600_000) });
  escrow.fundBounty(OPEN, openBounty.bountyId, { funder: JILL });
  assert.equal(escrow.pricingGuidance(OPEN).coldStart, true);

  // A rejected bounty settles at zero (worker paid 0): still cold.
  const { bounty } = escrow.postBounty(REJECTED,
    { poster: JILL, title: "T", criteria: "C", amount: 50, deadline: isoFuture(3600_000) });
  escrow.fundBounty(REJECTED, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(REJECTED, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(REJECTED, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/2", summary: "attempt" } });
  escrow.rejectWork(REJECTED, bounty.bountyId, { rejector: JILL, reason: "not the thing" });
  const rejected = escrow.pricingGuidance(REJECTED);
  assert.equal(rejected.coldStart, true);
  assert.equal(rejected.settledCount, 0);
  assert.equal(rejected.paidRangeCredits, null);
});

// --- panel rendering (pure) ----------------------------------------------------

const GUIDANCE = {
  roomId: ROOM, source: "settled-receipts", settledCount: 4, coldStart: false,
  paidRangeCredits: { min: 9.9, max: 39.6 }, medianPaidCredits: 24.75,
  approvalModes: { human: 3, agent: 1 }, rubricCriteria: { min: 1, max: 2 },
};

test("panel: numbers render with the settled-receipts label and the count named", () => {
  const html = pricingGuidanceHtml(bountyBoardModel({ guidance: GUIDANCE }).guidance);
  assert.ok(html.includes("9.9–39.6 credits"), html);
  assert.ok(html.includes("typical 24.75"), html);
  assert.ok(html.includes("from 4 settled bounties in this room"), html);
  assert.ok(html.includes("settled receipts in this room"), html);
  assert.ok(html.includes("not a recommended price"), html);
  assert.ok(html.includes("1–2 criteria"), html);
  assert.ok(!/<button|<input|<select|<form/.test(html), "the panel is read-only: no controls");
});

test("panel: cold start is a sentence and no numbers", () => {
  const html = pricingGuidanceHtml(bountyBoardModel({
    guidance: { source: "settled-receipts", settledCount: 0, coldStart: true,
      paidRangeCredits: null, medianPaidCredits: null, approvalModes: {}, rubricCriteria: null },
  }).guidance);
  assert.ok(html.includes("No settled bounties in this room yet"), html);
  const text = html.replace(/<[^>]+>/g, "").replace("Pricing guidance", "");
  assert.ok(!/\d/.test(text), `cold start shows no numbers in its text: ${text}`);
});

test("panel: absent guidance renders nothing beside the form", () => {
  assert.equal(pricingGuidanceHtml(bountyBoardModel({}).guidance), "");
  assert.equal(pricingGuidanceHtml(null), "");
});

// --- panel wiring: posting is identical with panel present, absent, failing ---

function fakePanelEnv(client) {
  const realDocument = globalThis.document;
  let hostHtml = "";
  const host = { addEventListener() {}, set innerHTML(html) { hostHtml = html; }, get innerHTML() { return hostHtml; } };
  globalThis.document = {
    querySelector: selector => {
      if (selector === "#bounty-panel") return { open: true };
      if (selector === "#bounty-count") return { set textContent(_t) {} };
      if (selector === "#bounty-board-host") return host;
      if (selector === "#bounty-status") return { textContent: "", classList: { toggle() {} } };
      return null;
    },
  };
  return { host: () => hostHtml,
    restore() { if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument; } };
}

const baseClient = overrides => ({
  session: { roomId: "room1", member: { id: "m9" } },
  path(suffix) { return `/api/rooms/room1${suffix}`; },
  async request(path) {
    if (path.endsWith("/bounties")) return { roomId: "room1", bounties: [] };
    if (path.includes("/credits/balances/")) return { roomId: "room1", balances: {} };
    if (path.includes("/credits/history/")) return { roomId: "room1", receipts: [] };
    if (path.endsWith("/bounties/pricing-guidance")) return { roomId: "room1", guidance: GUIDANCE };
    throw new Error(`unexpected path ${path}`);
  },
  ...overrides,
});

test("posting flow: guidance present, absent, and failing all load the post form identically", async () => {
  const variants = {
    present: baseClient(),
    failing: baseClient({ async request(path) {
      if (path.endsWith("/bounties/pricing-guidance")) throw new Error("guidance read exploded");
      return baseClient().request(path);
    } }),
    absent: baseClient({ async request(path) {
      if (path.endsWith("/bounties/pricing-guidance")) return { roomId: "room1", guidance: null };
      return baseClient().request(path);
    } }),
  };
  const forms = {};
  for (const [name, client] of Object.entries(variants)) {
    const env = fakePanelEnv();
    try {
      const panel = installBountyBoard({ client, getSession: () => client.session });
      await panel.sync();
      forms[name] = env.host();
    } finally { env.restore(); }
  }
  for (const [name, html] of Object.entries(forms)) {
    assert.ok(html.includes('id="bounty-post-form"'), `${name}: post form renders`);
    assert.ok(html.includes('id="bounty-amount"'), `${name}: amount field renders`);
  }
  assert.ok(forms.present.includes("from 4 settled bounties in this room"), "present: guidance shows");
  assert.ok(!forms.failing.includes("Pricing guidance"), "failing: no panel, no block");
  assert.ok(!forms.absent.includes("Pricing guidance"), "absent: no panel, no block");
  // The form markup is byte-identical across variants apart from the panel.
  const strip = html => html.slice(0, html.indexOf('<div id="bounty-guidance-host">'))
    + html.slice(html.indexOf('<div id="bounty-balance-host">'));
  assert.equal(strip(forms.present), strip(forms.failing));
  assert.equal(strip(forms.present), strip(forms.absent));
});

// --- HTTP surface ---------------------------------------------------------------

const HTTP_ROOM = "commons";
async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"]) {
      escrow._append({ roomId: HTTP_ROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable",
        memo: "test seeding: 100 credits", actor: { kind: "rule", id: "test" } });
    }
  });
  ensureSpendGrantsSchema(fixture.store.db);
  for (const memberId of ["producer", "reviewer"]) {
    issueSpendGrant(fixture.store.db, HTTP_ROOM, memberId,
      { grantedBy: "owner", capCents: "100000", perTxCapCents: "100000", nowMs: Date.now() });
  }
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, keys: fixture.keys, fixture };
}
const get = (origin, path, secret) => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${secret}` } });
const postJson = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify(body),
});

test("HTTP: guidance is cold before any settlement, then reports the settled bounty; posting is unaffected", async t => {
  const { origin, keys, fixture } = await startServer(t);
  const coldRes = await get(origin, `/api/rooms/${HTTP_ROOM}/bounties/pricing-guidance`, keys.owner);
  assert.equal(coldRes.status, 200);
  const cold = (await coldRes.json()).guidance;
  assert.equal(cold.coldStart, true);
  assert.equal(cold.settledCount, 0);
  assert.equal(cold.paidRangeCredits, null);
  assert.equal(cold.medianPaidCredits, null);

  // Settle one 100-credit bounty end to end over HTTP (the worker receives
  // 99 after the 1% pool fee).
  const body = { title: "Write the migration guide", criteria: "Cover every breaking change.",
    amount: 100, deadline: new Date(Date.now() + 86400000).toISOString() };
  const createRes = await postJson(origin, `/api/rooms/${HTTP_ROOM}/bounties`, body, keys.owner);
  assert.equal(createRes.status, 201, "posting works while guidance is read");
  const bountyId = (await createRes.json()).bounty.bountyId;
  assert.equal((await postJson(origin, `/api/rooms/${HTTP_ROOM}/bounties/${bountyId}/fund`, {}, keys.owner)).status, 200);
  assert.equal((await postJson(origin, `/api/rooms/${HTTP_ROOM}/bounties/${bountyId}/claim`, {}, keys.producer)).status, 200);
  assert.equal((await postJson(origin, `/api/rooms/${HTTP_ROOM}/bounties/${bountyId}/submit`, {
    evidenceUrl: "https://room.example/receipts/1", evidenceKind: "work.completed",
    summary: "Migration guide drafted.", checksClaimed: ["c1"], producerId: "producer",
  }, keys.producer)).status, 200);
  assert.equal((await postJson(origin, `/api/rooms/${HTTP_ROOM}/bounties/${bountyId}/accept`, {
    verifierAttestation: { reviewerId: "owner", checks: ["c1"], outcome: "pass",
      citations: [{ criterionId: "c1", verdict: "pass" }] },
  }, keys.owner)).status, 200);
  fixture.store.db.prepare(
    "UPDATE bounty_records SET challenge_ends_ms = 0 WHERE room_id = ? AND bounty_id = ?"
  ).run(HTTP_ROOM, bountyId);
  assert.equal((await postJson(origin, `/api/rooms/${HTTP_ROOM}/bounties/${bountyId}/finalize`, {}, keys.owner)).status, 200);
  assert.equal((await postJson(origin, `/api/rooms/${HTTP_ROOM}/credits/epoch/close`, {}, keys.owner)).status, 200);

  const res = await get(origin, `/api/rooms/${HTTP_ROOM}/bounties/pricing-guidance`, keys.owner);
  assert.equal(res.status, 200);
  const guidance = (await res.json()).guidance;
  assert.equal(guidance.coldStart, false);
  assert.equal(guidance.settledCount, 1);
  assert.deepEqual(guidance.paidRangeCredits, { min: 99, max: 99 });
  assert.equal(guidance.medianPaidCredits, 99);
  assert.deepEqual(guidance.approvalModes, { human: 1 });
  assert.deepEqual(guidance.rubricCriteria, { min: 1, max: 1 });

  // Posting still completes identically now that guidance has data.
  const again = await postJson(origin, `/api/rooms/${HTTP_ROOM}/bounties`,
    { ...body, title: "Second bounty" }, keys.owner);
  assert.equal(again.status, 201);
});
