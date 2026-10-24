// FUZZ-JH — journalEntryHash separator-split collision (HUNT-FUZZ finding 2).
// The hash core is sha256(parts.join("|")) with no escaping or length
// prefixes: an adjacent-field split at a "|" boundary collides.
import { dynImport, fixed, still } from "../lib.mjs";

const { journalEntryHash } = await dynImport("server/bounty-escrow.mjs");
const base = {
  prev_hash: "p", entry_id: "e1", account_id: "a", at: "2026-10-18T00:00:00.000Z",
  kind: "move", bounty_id: "b", lot_id: "", amount: 100, lot_state: "payable",
  memo: "x|", actor_kind: "agent", actor_id: "z",
};
const twin = { ...base, memo: "x", actor_kind: "|agent" };
const h1 = journalEntryHash(base);
const h2 = journalEntryHash(twin);
if (h1 === h2) still(`two distinct journal entries (memo "x|" + actor_kind "agent" vs memo "x" + actor_kind "|agent") hash-identical: ${h1.slice(0, 16)}… — the join("|") core is unchanged`);
else fixed(`the filed collision pair now hashes differently (${h1.slice(0, 12)}… vs ${h2.slice(0, 12)}…) — unambiguous core encoding in tree`);
