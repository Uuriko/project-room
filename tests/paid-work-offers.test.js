import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PAID_WORK_OFFERS, preparePaidWork } from "../src/paid-work-offers.js";
import { validateCommand } from "../server/store.mjs";
import { applyEvent, emptyRoomState, event, EVENT_TYPES as T } from "../src/events.js";

const brief = (overrides = {}) => ({ requestId: "offer-request", workItemId: "offer-work", accountableMemberId: "producer", humanDecisionMakerId: "owner", verifierMemberId: "reviewer", offerId: "research-brief", outcome: "Compare inventory reconciliation options", acceptanceCriteria: ["Compare three approaches using primary sources", "Deliver a recommendation with limitations"], currency: "USD", amountMinor: "10000", costsMinor: { labor: "5000", tools: "500", other: "0" }, platformFeeBps: 200, ...overrides });

test("offers generate valid proposals accepted by the actual reducer with independent review and owner decision", () => {
  let state = emptyRoomState(), sequence = 0;
  const send = (type, actorId, data) => { state = applyEvent(state, event({ type, actorId, data, roomId: "room", at: "2026-09-28T08:00:00Z", id: `event-${++sequence}`, idempotencyKey: `key-${sequence}` })); };
  send(T.ROOM_CREATED, "owner", { roomId: "room", ownerId: "owner", title: "Commercial pilot", purpose: "Prepare useful offers" });
  for (const [memberId, kind, permissions] of [["owner", "human", ["manage_members", "steer", "decide", "accept_work"]], ["producer", "agent", ["accept_work", "complete_work"]], ["reviewer", "agent", ["verify"]]]) send(T.MEMBER_ADDED, "owner", { memberId, displayName: memberId, kind, permissions });
  for (const offer of PAID_WORK_OFFERS) {
    const prepared = preparePaidWork(brief({ offerId: offer.id, workItemId: offer.id }));
    validateCommand(prepared.command);
    send(T.WORK_PROPOSED, "owner", prepared.command.data);
    const work = state.workItems[offer.id];
    assert.equal(work.state, "proposed");
    assert.equal(work.independentVerificationRequired, true);
    assert.equal(work.ownerDecisionRequired, true);
    assert.match(work.definitionOfDone, /No funds received or reserved/);
    assert.equal(prepared.paymentStatus, "not_configured");
  }
});

test("money is exact, with included fee and distinct USD/USDC decimal conventions", () => {
  const usd = preparePaidWork(brief());
  assert.equal(usd.quote.feeMinor, "200");
  assert.equal(usd.privateEstimate.contributionMinor, "4300");
  assert.match(usd.quote.text, /100\.00 USD/);
  const usdc = preparePaidWork(brief({ currency: "USDC", amountMinor: "100000001", costsMinor: { labor: "0", tools: "0", other: "0" } }));
  assert.equal(usdc.quote.feeMinor, "2000000");
  assert.equal(usdc.quote.providerProceedsMinor, "98000001");
  assert.match(usdc.quote.text, /100\.000001 USDC/);
  assert.equal(preparePaidWork(brief({ amountMinor: "1" })).quote.feeMinor, "0");
  assert.equal(preparePaidWork(brief({ platformFeeBps: 0 })).quote.feeMinor, "0");
  const loss = preparePaidWork(brief({ amountMinor: "1000" }));
  assert.equal(loss.privateEstimate.profitable, false);
  assert.equal(loss.privateEstimate.contributionMinor, "-4520");
});

test("private costs do not affect or enter the publishable command; retries retain exact input IDs", () => {
  const a = preparePaidWork(brief());
  const b = preparePaidWork(brief({ costsMinor: { labor: "876543", tools: "123456", other: "0" } }));
  assert.deepEqual(a.command, b.command);
  assert.doesNotMatch(JSON.stringify(b.command), /876543|123456|privateEstimate|contributionMinor/);
  assert.deepEqual(a, preparePaidWork(brief()));
});

test("malformed money, unsupported credits, ambiguous inputs and self-review are rejected", () => {
  for (const amountMinor of [0, 10.5, "0", "1.25", "-1", "01", "1e6", "1000000000000000000"]) assert.throws(() => preparePaidWork(brief({ amountMinor })));
  for (const platformFeeBps of [-1, 10001, 0.5, "200"]) assert.throws(() => preparePaidWork(brief({ platformFeeBps })));
  for (const change of [{ currency: "credits" }, { verifierMemberId: "producer" }, { acceptanceCriteria: [] }, { outcome: "hello\nforged status" }, { paymentStatus: "paid" }, { costsMinor: { labor: "1", tools: "2" } }]) assert.throws(() => preparePaidWork(brief(change)));
});

test("large estimates remain exact and overlong quotes fail before Room submission", () => {
  const max = "999999999999999999";
  const huge = preparePaidWork(brief({ amountMinor: "1", costsMinor: { labor: max, tools: max, other: max } }));
  assert.equal(huge.privateEstimate.contributionBps, ((1n - 3n * BigInt(max)) * 10000n).toString());
  assert.throws(() => preparePaidWork(brief({ acceptanceCriteria: Array(8).fill("a".repeat(300)), exclusions: Array(8).fill("b".repeat(300)) })), /4096-character/);
});

test("CLI emits only public command when requested, and does not echo invalid JSON", t => {
  const dir = mkdtempSync(join(tmpdir(), "paid-work-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "brief.json");
  writeFileSync(file, JSON.stringify(brief()));
  const run = mode => spawnSync(process.execPath, ["scripts/paid-work.mjs", mode, file], { encoding: "utf8" });
  const result = run("command");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), preparePaidWork(brief()).command);
  writeFileSync(file, '{"confidential-business-notes": malformed}');
  const invalid = run("prepare");
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /confidential-business-notes/);
});
