// T3: spend reaper-vs-settle serialization (two connections, one file).
// Proves exactly-one-wins: a reaper voiding an expired reservation and an
// owner settling it race; the conditional UPDATEs (status='reserved') make
// the outcome exactly one of {voided, settled} — never double, never lost.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WT = dirname(dirname(fileURLToPath(import.meta.url)));
const spend = await import(join(WT, "server/spend-grants.mjs"));

const f = join(mkdtempSync(join(tmpdir(), "g20-spend-")), "s.db");
const setup = new DatabaseSync(f);
setup.exec(spend.SPEND_GRANTS_SCHEMA);
setup.close();

let pass = 0, fail = 0;
const ok = (c, n) => { console.log((c ? "PASS" : "FAIL") + ": " + n); c ? pass++ : fail++; };

// Case A: reaper runs first (lease expired), then owner settles -> settle loses.
{
  const a = new DatabaseSync(f), b = new DatabaseSync(f);
  const now = Date.now(), nonce = "n-reaper-first";
  a.prepare("INSERT INTO spend_authorizations(room_id,agent_id,nonce,tool_name,price_cents,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("r", "ag", nonce, "t", "10", "reserved", now - 20 * 60 * 1000, now - 10 * 60 * 1000);
  a.prepare("INSERT INTO spend_room_reservations(room_id,agent_id,nonce,amount_cents,status,created_at) VALUES(?,?,?,?,?,?)")
    .run("r", "ag", nonce, "10", "active", now - 20 * 60 * 1000);
  const reaped = spend.reapExpiredSpendAuthorizations(a, { roomId: "r", nowMs: now });
  const settled = spend.settleSpend(b, { roomId: "r", agentId: "ag", nonce });
  const row = a.prepare("SELECT status FROM spend_authorizations WHERE nonce=?").get(nonce);
  const res = a.prepare("SELECT status FROM spend_room_reservations WHERE nonce=?").get(nonce);
  ok(reaped === 1, "reaper voids the expired reservation");
  ok(settled === false, "late settle on voided row loses (no double-settle)");
  ok(row.status === "voided" && res.status === "released", "final state voided + room reservation released");
  a.close(); b.close();
}

// Case B: owner settles first, then reaper runs -> reaper finds nothing.
{
  const a = new DatabaseSync(f), b = new DatabaseSync(f);
  const now = Date.now(), nonce = "n-settle-first";
  a.prepare("INSERT INTO spend_authorizations(room_id,agent_id,nonce,tool_name,price_cents,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("r", "ag", nonce, "t", "10", "reserved", now - 20 * 60 * 1000, now - 10 * 60 * 1000);
  a.prepare("INSERT INTO spend_room_reservations(room_id,agent_id,nonce,amount_cents,status,created_at) VALUES(?,?,?,?,?,?)")
    .run("r", "ag", nonce, "10", "active", now - 20 * 60 * 1000);
  const settled = spend.settleSpend(b, { roomId: "r", agentId: "ag", nonce });
  const reaped = spend.reapExpiredSpendAuthorizations(a, { roomId: "r", nowMs: now });
  const row = a.prepare("SELECT status FROM spend_authorizations WHERE nonce=?").get(nonce);
  ok(settled === true, "owner settle wins when first");
  ok(reaped === 0, "reaper does not touch a settled row");
  ok(row.status === "settled", "final state settled (charge recorded)");
  a.close(); b.close();
}

// Case C: unexpired reservation is never reaped.
{
  const a = new DatabaseSync(f);
  const now = Date.now(), nonce = "n-fresh";
  a.prepare("INSERT INTO spend_authorizations(room_id,agent_id,nonce,tool_name,price_cents,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("r", "ag", nonce, "t", "10", "reserved", now, now + 10 * 60 * 1000);
  const reaped = spend.reapExpiredSpendAuthorizations(a, { roomId: "r", nowMs: now });
  ok(reaped === 0, "reaper leaves unexpired reservations alone");
  a.close();
}

console.log(`DONE t3-spend-reaper (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
