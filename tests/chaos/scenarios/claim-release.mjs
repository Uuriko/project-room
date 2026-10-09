// claim-release — demo scenario 1.
//
// Claim-then-release on a work-claim style table under injected faults:
// seeded delays between operations and an order-reversed batch of claims.
// Invariants: every claim has at most one winner; release succeeds only for
// the current owner; all claims are released at the end; the version chain
// is intact (one increment per successful write).
//
// Fail-first history: the first draft used a read-then-write claim
// (SELECT owner …; yield; UPDATE …). With two agents racing the same item
// the harness flagged a lost-update violation on invariant
// "single-winner-per-claim" — the exact seed-dependent race QA-200 found.
// The scenario now claims atomically (UPDATE … WHERE owner IS NULL), and
// passes deterministically.

export const name = "claim-release";
export const description = "claim-then-release under seeded delays and order reversal";

const ITEMS = ["work-1", "work-2", "work-3"];
const AGENTS = ["alice", "bob"];

export async function run(ctx) {
  ctx.db.exec(`
    CREATE TABLE claims (
      id TEXT PRIMARY KEY,
      owner TEXT,
      state TEXT NOT NULL DEFAULT 'open',
      version INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = ctx.db.prepare("INSERT INTO claims(id) VALUES (?)");
  for (const id of ITEMS) insert.run(id);

  // Atomic compare-and-set claim: succeeds only when the item is unowned.
  // (The first draft did read-then-write here; the harness caught the
  // lost-update race, so this is the hardened form.)
  const claimStmt = () =>
    ctx.db.prepare(
      "UPDATE claims SET owner = ?, state = 'claimed', version = version + 1 WHERE id = ? AND owner IS NULL",
    );

  const claim = async (id, agent) => {
    await ctx.delay(3); // seeded delay between operations
    await ctx.yieldPoint(`claim:${id}:${agent}`);
    const res = claimStmt().run(agent, id);
    return res.changes === 1 ? { ok: true, agent } : { ok: false, reason: "taken", agent };
  };

  // Two agents race every item; interleaving points are seeded, so the
  // schedule is reproducible and the CAS makes the winner deterministic.
  const attempts = [];
  for (const id of ITEMS) for (const agent of AGENTS) attempts.push([id, agent]);
  ctx.shuffleInPlace(attempts);

  const results = await Promise.all(attempts.map(([id, agent]) => claim(id, agent)));

  // Invariant: exactly one winner per item, and the winner owns it in the DB.
  for (const id of ITEMS) {
    const winners = results.filter((r) => r.ok && attempts[results.indexOf(r)][0] === id);
    ctx.assertInvariant(
      "single-winner-per-claim",
      winners.length === 1,
      `item ${id}: winners=${winners.length}`,
    );
    const row = ctx.db.prepare("SELECT owner FROM claims WHERE id = ?").get(id);
    ctx.assertInvariant(
      "winner-is-owner",
      row.owner === winners[0].agent,
      `item ${id}: owner=${row.owner} winner=${winners[0].agent}`,
    );
  }

  // Release phase: only the current owner may release; order reversed.
  const releases = results.filter((r) => r.ok).map((r, i) => ({
    id: attempts[results.indexOf(r)][0],
    agent: r.agent,
    order: i,
  }));
  ctx.shuffleInPlace(releases);

  for (const { id, agent } of releases) {
    await ctx.delay(3);
    const res = ctx.db
      .prepare("UPDATE claims SET owner = NULL, state = 'released', version = version + 1 WHERE id = ? AND owner = ?")
      .run(id, agent);
    ctx.assertInvariant("release-only-by-owner", res.changes === 1, `release ${id} by ${agent}`);
  }

  // A release by a non-owner must be a no-op.
  const noOp = ctx.db
    .prepare("UPDATE claims SET owner = NULL WHERE id = ? AND owner = 'mallory'")
    .run("work-1");
  ctx.assertInvariant("stranger-release-noop", noOp.changes === 0, `changes=${noOp.changes}`);

  // Final: everything released, version chain intact
  // (1 insert is version 0; each item saw exactly 1 claim + 1 release).
  const rows = ctx.db.prepare("SELECT id, owner, state, version FROM claims ORDER BY id").all();
  for (const row of rows) {
    ctx.assertInvariant("final-clean", row.owner === null && row.state === "released", JSON.stringify(row));
    ctx.assertInvariant("version-chain", row.version === 2, `${row.id}: version=${row.version}`);
  }
}
