import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { emitWorkClaimEvent } from "../server/work-claim-events.mjs";
const store = new RoomStore(":memory:");
store.initialize(initialRoom("commons"));
const actorId = "owner";
const counts = new Map();
const origPrepare = store.db.prepare.bind(store.db);
store.db.prepare = sql => { counts.set(sql, (counts.get(sql) ?? 0) + 1); return origPrepare(sql); };
for (let i = 0; i < 110; i++) {
  const item = { id: `b-${i}`, title: `B ${i}`, state: "unclaimed", owner: null,
    history: [{ agentId: actorId, at: store.now(), action: "created" }], claimedAt: store.now(), tags: [], files: [], dependsOn: [] };
  if (i === 100) counts.clear();
  store.workClaims.set("commons", item);
  emitWorkClaimEvent(store, "commons", { actorId, item, action: "created", atMs: store.now() });
}
for (const [sql, n] of [...counts.entries()].sort((a,b)=>b[1]-a[1]))
  console.log(n, sql.replace(/\s+/g," ").slice(0,140));
