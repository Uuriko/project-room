// WAVE-400 stmt-cache bench: measure the per-call db.prepare() share of the
// claim-write hot path on a real RoomStore.
// Bundle per "claim create": registry upsert (claim write) + one
// work_claim.updated room event (event insert + rooms update) — the two
// write legs of the claim-create commit path.
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { emitWorkClaimEvent } from "../server/work-claim-events.mjs";

const ITER = Number(process.env.ITER ?? 1000);

const store = new RoomStore(":memory:");
store.initialize(initialRoom("commons"));
const actorId = "owner";

const mkItem = i => ({
  id: `bench-claim-${i}`, title: `Bench claim ${i}`, state: "unclaimed",
  owner: null, history: [{ agentId: actorId, at: store.now(), action: "created" }],
  claimedAt: store.now(), tags: [], files: [], dependsOn: [],
});

// Instrument db.prepare: count + cumulative compile time.
let prepares = 0;
let prepareNs = 0n;
const origPrepare = store.db.prepare.bind(store.db);
store.db.prepare = sql => {
  prepares++;
  const t0 = process.hrtime.bigint();
  const stmt = origPrepare(sql);
  prepareNs += process.hrtime.bigint() - t0;
  return stmt;
};
const reset = () => { prepares = 0; prepareNs = 0n; };

// Warmup (JIT, projection cache, schema already applied).
for (let i = 0; i < 100; i++) {
  const item = mkItem(i);
  store.workClaims.set("commons", item);
  emitWorkClaimEvent(store, "commons", { actorId, item, action: "created", atMs: store.now() });
}
reset();

const t0 = process.hrtime.bigint();
for (let i = 100; i < 100 + ITER; i++) {
  const item = mkItem(i);
  store.workClaims.set("commons", item);
  emitWorkClaimEvent(store, "commons", { actorId, item, action: "created", atMs: store.now() });
}
const totalNs = process.hrtime.bigint() - t0;

const totalMs = Number(totalNs) / 1e6;
const prepMs = Number(prepareNs) / 1e6;
console.log(JSON.stringify({
  iterations: ITER,
  totalMs: +totalMs.toFixed(1),
  perIterMs: +(totalMs / ITER).toFixed(3),
  prepares,
  preparesPerIter: +(prepares / ITER).toFixed(1),
  prepareMs: +prepMs.toFixed(1),
  prepareSharePct: +(100 * prepMs / totalMs).toFixed(1),
}, null, 2));
store.close();
