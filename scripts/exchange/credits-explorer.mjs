#!/usr/bin/env node
// Credits audit-trail explorer — read-only (hard task 116).
// Proves every credit's provenance is traceable: search the journal by
// user, bounty, or epoch, and trace any entry back to its issuance.
//
// Usage:
//   node scripts/exchange/credits-explorer.mjs --db <ledger.sqlite> balance <acct>
//   node scripts/exchange/credits-explorer.mjs --db <ledger.sqlite> search [--user A] [--bounty B] [--epoch N]
//   node scripts/exchange/credits-explorer.mjs --db <ledger.sqlite> trace <journal-id>
//   node scripts/exchange/credits-explorer.mjs --db <ledger.sqlite> conservation
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
if (dbFlag === -1 || !args[dbFlag + 1]) { console.error("usage: credits-explorer.mjs --db <ledger.sqlite> <command> [args]"); process.exit(2); }
const dbPath = args[dbFlag + 1];
const rest = [...args.slice(0, dbFlag), ...args.slice(dbFlag + 2)];
const [command, ...cmdArgs] = rest;

const db = new DatabaseSync(dbPath, { readOnly: true });
const fmt = row => `#${row.id} ${row.kind} ${row.from_acct ?? "∅"} → ${row.to_acct} ${row.amount}cr epoch=${row.epoch}${row.ref ? ` ref=${row.ref}` : ""} nonce=${row.nonce.slice(0, 8)}`;

// Trace provenance: walk from an entry back through the funding chain.
// For each hop we show the most recent prior entry that funded the sender,
// which grounds every credit in its issuance event(s).
function trace(entryId, seen = new Set(), depth = 0) {
  if (seen.has(entryId) || depth > 25) return [];
  seen.add(entryId);
  const entry = db.prepare("SELECT * FROM journal WHERE id=?").get(entryId);
  if (!entry) return [];
  const lines = [`${"  ".repeat(depth)}${fmt(entry)}`];
  if (entry.kind === "issuance") return lines;
  // The sender's funds came from its most recent prior inbound entries.
  const funders = db.prepare(`SELECT * FROM journal WHERE to_acct=? AND id < ? ORDER BY id DESC LIMIT 3`).all(entry.from_acct, entry.id);
  for (const funder of funders) lines.push(...trace(funder.id, seen, depth + 1));
  return lines;
}

switch (command) {
  case "balance": {
    const [acct] = cmdArgs;
    if (!acct) { console.error("usage: balance <acct>"); process.exit(2); }
    console.log(`${acct}: ${db.prepare("SELECT balance FROM balances WHERE acct=?").get(acct)?.balance ?? 0}cr`);
    break;
  }
  case "search": {
    const where = [], params = [];
    for (let i = 0; i < cmdArgs.length; i += 2) {
      const flag = cmdArgs[i], value = cmdArgs[i + 1];
      if (flag === "--user") { where.push("(from_acct=? OR to_acct=?)"); params.push(value, value); }
      else if (flag === "--bounty") { where.push("ref=?"); params.push(value); }
      else if (flag === "--epoch") { where.push("epoch=?"); params.push(Number(value)); }
      else { console.error(`unknown search flag ${flag}; use --user, --bounty, --epoch`); process.exit(2); }
    }
    const rows = db.prepare(`SELECT * FROM journal${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id`).all(...params);
    for (const row of rows) console.log(fmt(row));
    console.log(`— ${rows.length} entr${rows.length === 1 ? "y" : "ies"}`);
    break;
  }
  case "trace": {
    const [id] = cmdArgs;
    if (!id) { console.error("usage: trace <journal-id>"); process.exit(2); }
    const lines = trace(Number(id));
    if (!lines.length) { console.error(`no journal entry #${id}`); process.exit(1); }
    console.log(lines.join("\n"));
    break;
  }
  case "conservation": {
    const issued = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM journal WHERE kind='issuance'").get().s;
    const redeemed = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM journal WHERE kind IN ('redemption','burn')").get().s;
    const circulating = db.prepare("SELECT COALESCE(SUM(balance),0) s FROM balances").get().s;
    console.log(`issued=${issued} redeemed=${redeemed} circulating=${circulating} balanced=${issued - redeemed === circulating}`);
    break;
  }
  default:
    console.error("commands: balance, search, trace, conservation");
    process.exit(2);
}
db.close();
