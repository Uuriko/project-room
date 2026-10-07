#!/usr/bin/env node
// dasha-verify-receipt — standalone settlement receipt verifier (200-hard-tasks #4).
// Anyone can run this to check a provider's signed settlement receipt:
// signature, amount, job id, chain, and timestamp freshness, plus optional
// replay protection via a nonce journal file.
//
// Usage:
//   node scripts/dasha-verify-receipt.mjs --pubkey <hex64> [--job <id>]
//       [--amount <raw>] [--chain <id>] [--max-age-ms <n>] [--seen <journal.json>]
//       <receipt.json | ->
//
// Exit codes: 0 = VALID, 1 = INVALID, 2 = usage error.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { verifySettlementReceipt, parseStrict } from "../server/settlement-receipt.mjs";

function usage() {
  console.error(`usage: dasha-verify-receipt.mjs --pubkey <hex64> [--job <id>] [--amount <raw>] [--chain <id>]
       [--max-age-ms <n>] [--seen <journal.json>] <receipt.json | ->`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = {};
let file = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--pubkey") opts.pubkey = args[++i];
  else if (a === "--job") opts.jobId = args[++i];
  else if (a === "--amount") opts.amountRaw = args[++i];
  else if (a === "--chain") opts.chainId = args[++i];
  else if (a === "--max-age-ms") opts.maxAgeMs = Number(args[++i]);
  else if (a === "--seen") opts.seenFile = args[++i];
  else if (a === "-h" || a === "--help") usage();
  else if (!a.startsWith("--") && file === null) file = a;
  else usage();
}
if (!opts.pubkey || !file) usage();

let text;
if (file === "-") {
  text = readFileSync(0, "utf8");
} else {
  if (!existsSync(file)) {
    console.error(`receipt file not found: ${file}`);
    process.exit(2);
  }
  text = readFileSync(file, "utf8");
}

let receipt;
try {
  receipt = parseStrict(text);
} catch (e) {
  console.log(`INVALID: receipt is not strict JSON (${e.message})`);
  process.exit(1);
}

let seen = null;
if (opts.seenFile) {
  let journal = [];
  if (existsSync(opts.seenFile)) {
    try {
      journal = JSON.parse(readFileSync(opts.seenFile, "utf8"));
    } catch {
      console.error(`seen journal is not valid JSON: ${opts.seenFile}`);
      process.exit(2);
    }
  }
  seen = new Set(journal);
}

const result = verifySettlementReceipt(receipt, {
  expectedPubkey: opts.pubkey,
  jobId: opts.jobId ?? null,
  amountRaw: opts.amountRaw ?? null,
  chainId: opts.chainId ?? null,
  maxAgeMs: opts.maxAgeMs || undefined,
  seen,
});

if (!result.ok) {
  console.log(`INVALID: ${result.reason} [${result.code}]`);
  process.exit(1);
}

if (opts.seenFile) {
  writeFileSync(opts.seenFile, JSON.stringify([...seen], null, 1) + "\n");
}
const b = result.body;
console.log(`VALID: job ${b.jobId} amount ${b.amountRaw} on ${b.chainId}, signed by provider ${b.providerId}, issued ${b.issuedAtIso}`);
process.exit(0);
