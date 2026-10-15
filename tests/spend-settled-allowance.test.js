// tests/spend-settled-allowance.test.js — regression test for issue #3302.
//
// Protects: the room-level spend allowance bounds CUMULATIVE priced-tool
// spend. Settled charges count against the allowance for the rest of the
// allowance period: chargeSpendBeforeCall's committed base must include
// settled spend_authorizations in the period window, not only the
// work-session projection (spendLedger), which never sees tool charges.
//
// Credible regression (the issue's probe, driven through the real wiring):
// allowance 100c, bounty_post at 10c — ten settled charges exhaust the
// allowance and the eleventh is refused (402 payment_required,
// room_allowance_exceeded). On the pre-fix code the room reservation is
// released at settle and nothing records the charge against the
// allowance, so sequential charges settle without bound (the probe
// settled 300c against a 100c allowance); the eleventh charge succeeds
// and this test fails. Controls that already worked and must keep
// working: a single call larger than the allowance is refused, in-flight
// reservations narrow headroom, and charges older than the period window
// stop counting (rolling period, matching spendLedger semantics).
//
// Production seams: none. Real RoomStore, real grant issuance, real
// allowance command, real charge/settle path.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import {
  ensureSpendGrantsSchema, issueSpendGrant, chargeSpendBeforeCall,
} from "../server/spend-grants.mjs";

async function serve(t, { allowanceCents = 100, periodDays = 30 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-settled-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  ensureSpendGrantsSchema(store.db);
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  keys.agent = store.issueAccessKey("commons", "agent");
  issueSpendGrant(store.db, "commons", "agent", {
    grantedBy: "owner", capCents: "100000", perTxCapCents: "100000", nowMs: Date.now(),
  });
  if (allowanceCents !== null) {
    send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents, periodDays });
  }
  const chargeAndSettle = () => {
    const handle = chargeSpendBeforeCall(store, keys.agent, "bounty_post", { roomId: "commons" });
    assert.ok(handle, "a priced call by a granted agent must produce a charge handle");
    handle.settle();
    return handle;
  };
  return { store, keys, send, chargeAndSettle };
}

test("settled tool charges accumulate against the room allowance (#3302)", async t => {
  const f = await serve(t, { allowanceCents: 100 });
  // bounty_post costs 10c: exactly ten settled charges fill a 100c
  // allowance. Every one is sequential (settled before the next begins),
  // so in-flight reservations are zero throughout — only settled-charge
  // accounting can refuse the eleventh.
  for (let i = 0; i < 10; i++) f.chargeAndSettle();
  const settled = f.store.db.prepare(
    "SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)), 0) AS total FROM spend_authorizations WHERE room_id = 'commons' AND status = 'settled'"
  ).get().total;
  assert.equal(Number(settled), 100, "ten settled charges of 10c are on record");
  assert.throws(
    () => chargeSpendBeforeCall(f.store, f.keys.agent, "bounty_post", { roomId: "commons" }),
    (err) => err.code === "payment_required" && err.detail?.reason === "room_allowance_exceeded",
    "the eleventh sequential charge must be refused: the allowance is exhausted by settled charges",
  );
});

test("settled charges older than the allowance period stop counting (#3302 window)", async t => {
  const f = await serve(t, { allowanceCents: 100, periodDays: 30 });
  for (let i = 0; i < 10; i++) f.chargeAndSettle();
  // Age every settled charge beyond the 30-day rolling window: the
  // allowance frees up again, exactly as session spend rolls off in
  // spendLedger. (The per-agent grant cap is all-time and is not the
  // constraint here — it is set far above these amounts.)
  f.store.db.prepare("UPDATE spend_authorizations SET settled_at = settled_at - ? WHERE room_id = 'commons'")
    .run(31 * 24 * 3600 * 1000);
  const handle = chargeSpendBeforeCall(f.store, f.keys.agent, "bounty_post", { roomId: "commons" });
  assert.ok(handle, "a charge after the window rolls must be allowed again");
  handle.settle();
});
