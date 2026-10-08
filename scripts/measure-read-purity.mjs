// Measures room-event + write cost of the work-claims read path.
// Usage: node scripts/measure-read-purity.mjs
// Counts: registry writes, lease-expiry releases, and swept ids across N
// consecutive GET list reads with lapsed leases present.
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const N_READS = 50;

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const makeStore = (writes) => ({
  roomAuthority: () => ({ members: {
    agent1: { id: "agent1", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
  } }),
  room: () => ({ sequence: 42, state: { messages: [] } }),
  now: () => Date.now(),
});

const call = (registry, store, route, id, body, method) => handleWorkClaims({
  req: { method: method ?? (["list", "read", "status"].includes(route) ? "GET" : "POST"), body }, res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store, roomId: "room1",
  auth: { member: { id: "agent1", kind: "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});

const registry = createWorkClaimRegistry();
let writes = 0;
const origSet = registry.set.bind(registry);
registry.set = (roomId, item) => { writes++; return origSet(roomId, item); };
const store = makeStore();

await call(registry, "create", null, { id: "c1", files: ["src/a.mjs"] });
await call(registry, "create", null, { id: "c2", files: ["src/b.mjs"] });
await call(registry, "claim", "c1", { leaseHours: 1 });
await call(registry, "claim", "c2", { leaseHours: 1 });
// Lapse both leases behind the registry's back.
for (const id of ["c1", "c2"]) {
  registry.set("room1", { ...registry.get("room1", id), leaseExpiresAt: "2020-01-01T00:00:00.000Z" });
}
writes = 0; // reset: only count the read path below

let totalSwept = 0;
for (let i = 0; i < N_READS; i++) {
  const res = await call(registry, "list");
  totalSwept += (res.value.swept ?? []).length;
}

const states = ["c1", "c2"].map(id => registry.get("room1", id).state);
console.log(JSON.stringify({
  reads: N_READS,
  registryWritesOnReadPath: writes,
  totalSweptReported: totalSwept,
  finalStates: states,
}, null, 2));
