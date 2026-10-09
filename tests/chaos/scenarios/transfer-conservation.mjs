import { ChaosKillError } from "../chaos-kit.mjs";

// transfer-conservation — demo scenario 2.
//
// Balance transfers between accounts under three injected faults:
// a seeded order reversal of the transfer batch, a faulty fsync layer
// midway (PRAGMA synchronous=OFF), and a process kill at a seeded point
// inside one transfer's transaction. The journal rolls the dead
// transaction back on reopen; the invariant is that total funds are
// conserved at every checkpoint and at the end.

export const name = "transfer-conservation";
export const description = "balance transfers under order reversal, faulty fsync, and mid-transaction kill";

export async function run(ctx) {
  ctx.db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL
    );
    CREATE TABLE transfer_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
  `);
  ctx.db.prepare("INSERT INTO accounts(id, balance) VALUES ('a', 100000), ('b', 100000)").run();

  const total = () => ctx.db.prepare("SELECT SUM(balance) AS s FROM accounts").get().s;
  const EXPECTED_TOTAL = 200000;

  // Seeded transfer batch; amounts are seeded draws, not wall-clock data.
  const transfers = [];
  for (let i = 0; i < 50; i++) {
    const from = ctx.pick(["a", "b"]);
    transfers.push({ from, to: from === "a" ? "b" : "a", amount: ctx.int(1, 500) });
  }
  // Order reversal fault: the batch executes in the seeded permutation.
  ctx.shuffleInPlace(transfers);

  // Kill fault: one transfer (seeded) dies at a seeded statement inside its
  // transaction. Each transfer is exactly 3 statements (debit, credit, log),
  // so the kill is armed at a global statement index. ctx.statement() is
  // one-shot: it kills once, then the scenario recovers.
  const victim = ctx.int(10, 40);
  const stmtInVictim = ctx.int(1, 3);
  ctx.armKillAt(victim * 3 + stmtInVictim);

  let killed = false;
  const applyTransfer = (t) => {
    ctx.statement(); // debit — may throw ChaosKillError here
    ctx.db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").run(t.amount, t.from);
    ctx.statement(); // credit — may throw ChaosKillError here
    ctx.db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(t.amount, t.to);
    ctx.statement(); // log — may throw ChaosKillError here
    ctx.db.prepare("INSERT INTO transfer_log(from_id, to_id, amount) VALUES (?, ?, ?)").run(t.from, t.to, t.amount);
  };

  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    await ctx.delay(2);
    if (i === 25) ctx.faultyFsync(); // durability layer fails halfway through
    ctx.db.exec("BEGIN");
    try {
      applyTransfer(t);
      ctx.db.exec("COMMIT");
    } catch (err) {
      if (!(err instanceof ChaosKillError) || i !== victim || killed) throw err;
      killed = true;
      // Crash happened: the connection is dead. Reopen — the journal rolls
      // the half-written transfer back — then check invariants.
      ctx.reopenDb();
      ctx.assertInvariant("kill-rolled-back", total() === EXPECTED_TOTAL, `total=${total()}`);
      const partial = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM transfer_log WHERE from_id = ? AND to_id = ? AND amount = ?")
        .get(t.from, t.to, t.amount).n;
      ctx.assertInvariant("no-partial-transfer", partial === 0, `partial rows=${partial}`);
      // The client retries after the crash; the retry is clean.
      ctx.db.exec("BEGIN");
      ctx.db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").run(t.amount, t.from);
      ctx.db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(t.amount, t.to);
      ctx.db.prepare("INSERT INTO transfer_log(from_id, to_id, amount) VALUES (?, ?, ?)").run(t.from, t.to, t.amount);
      ctx.db.exec("COMMIT");
    }
    if (i % 10 === 9) {
      ctx.assertInvariant("checkpoint-total", total() === EXPECTED_TOTAL, `after ${i + 1} transfers: ${total()}`);
    }
  }

  ctx.assertInvariant("kill-actually-fired", killed, "the armed kill never fired");
  ctx.assertInvariant("final-total", total() === EXPECTED_TOTAL, `total=${total()}`);
  const logged = ctx.db.prepare("SELECT COUNT(*) AS n FROM transfer_log").get().n;
  ctx.assertInvariant("log-complete", logged === transfers.length, `logged=${logged} expected=${transfers.length}`);
  const nonNegative = ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE balance < 0").get().n;
  ctx.assertInvariant("no-negative-balance", nonNegative === 0, `negative=${nonNegative}`);
}
