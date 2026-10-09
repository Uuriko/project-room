// F14: malformed room states into buildRoomContext — RangeError or clean, never hang.
import assert from "node:assert/strict";
import { buildRoomContext } from "../../server/room-context.mjs";
import { fuzz, throwsBounded } from "./lib.mjs";

const baseState = () => ({
  room: { id: "r", ownerId: "o", policy: {} },
  members: { o: { id: "o", displayName: "O", kind: "human", active: true, permissions: [] } },
  workItems: {},
});
const good = { state: baseState(), sequence: 5, viewerId: "o", caughtUp: 5, now: 1_700_000_000_000 };
fuzz("F14-context-malformed", async () => {
  // baseline works
  const c0 = buildRoomContext(good);
  assert.ok(typeof c0.context_version === "string" && c0.context_version.length === 64);

  const badShapes = {
    "null state": { ...good, state: null },
    "null room": { ...good, state: { ...baseState(), room: null } },
    "negative sequence": { ...good, sequence: -1 },
    "non-integer sequence": { ...good, sequence: 1.5 },
    "negative caughtUp": { ...good, caughtUp: -1 },
    "non-string viewer": { ...good, viewerId: 42 },
    "members null": { ...good, state: { ...baseState(), members: null } },
    "members array": { ...good, state: { ...baseState(), members: [] } },
    "member garbage": { ...good, state: { ...baseState(), members: { o: 42, p: null, q: "x" } } },
    "workItems null": { ...good, state: { ...baseState(), workItems: null } },
    "workItem garbage": { ...good, state: { ...baseState(), workItems: { w: null, v: 42, u: { id: 7 } } } },
    "now NaN": { ...good, now: NaN },
    "huge sequence": { ...good, sequence: Number.MAX_SAFE_INTEGER },
  };
  for (const [name, args] of Object.entries(badShapes)) {
    const t0 = Date.now();
    let threw = false, ok = false;
    try {
      const c = buildRoomContext(args);
      ok = typeof c.context_version === "string";
    } catch (e) {
      threw = e instanceof RangeError || e instanceof TypeError;
      assert.ok(threw, `${name}: unexpected error type ${e?.constructor?.name}: ${e?.message}`);
    }
    const dt = Date.now() - t0;
    assert.ok(threw || ok, `${name}: neither threw nor returned a context`);
    assert.ok(dt < 5000, `${name}: took ${dt}ms (hang?)`);
    console.log(`  ${name}: ${threw ? "clean RangeError/TypeError" : "tolerated"} (${dt}ms)`);
  }
});
