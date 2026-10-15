#!/usr/bin/env node
// room-receipt-verify — CLI wrapper for the standalone receipt verifier
// (Receipt Standard v0.1 §4.1).
//
//   room-receipt-verify verify <receipt.json>
//     [--key <pubkey-hex>]            pin the trusted Ed25519 public key
//     [--jwks <url-or-file>]          resolve trusted keys from a JWKS
//                                     document (URL fetch is the ONLY
//                                     network call this tool ever makes)
//     [--family <name>]               bounty | vetting | signed-evidence |
//                                     public-work (default: auto-detect)
//     [--seen-file <path>]            JSON array file of already-verified
//                                     receiptIds (replay guard; updated on
//                                     success)
//     [--journal <file>]              bounty journal: JSON map of journal
//                                     entry id -> entry hash
//     [--registry <file>]             signed-evidence key registry: JSON
//                                     { identityId: [key rows] } or [rows]
//     [--artifact <file>]             public-work artifact bytes to check
//                                     against artifact.sha256 / bytes
//     [--expected-room <id>]          bounty context binding
//     [--expected-candidate <id>]     vetting context binding
//     [--expected-task <id>]          vetting context binding
//     [--now <iso-or-ms>]             reference time (vetting freshness)
//     [--integrity-only]              accept any signer / enable hash-only
//                                     mode; always labelled in the verdict
//
// Prints a JSON verdict to stdout. Exit codes: 0 = verified, 1 = rejected
// (reason code in the verdict), 2 = usage / IO error.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { verifyReceipt } from "./receipt-verifier.mjs";

const USAGE = `usage: room-receipt-verify verify <receipt.json> [--key <pubkey-hex>] [--jwks <url-or-file>] [--family <name>] [--seen-file <path>] [--journal <file>] [--registry <file>] [--artifact <file>] [--expected-room <id>] [--expected-candidate <id>] [--expected-task <id>] [--now <iso-or-ms>] [--integrity-only]`;

const fatal = (code, message) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code, reason: `${code}: ${message}` })}\n`);
  process.exit(2);
};

const readJsonFile = (path, label) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fatal("io_error", `cannot read ${label} ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fatal("io_error", `${label} ${path} is not valid JSON: ${error.message}`);
  }
};

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command !== "verify") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  let receiptPath = null;
  const options = {};
  let seenFile = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) fatal("usage_error", `${arg} requires a value`);
      return rest[++i];
    };
    switch (arg) {
      case "--key": options.expectedPubkey = value(); break;
      case "--family": options.family = value(); break;
      case "--seen-file": seenFile = value(); break;
      case "--expected-room": options.expectedRoomId = value(); break;
      case "--expected-candidate": options.expectedCandidateId = value(); break;
      case "--expected-task": options.expectedTrialTaskId = value(); break;
      case "--integrity-only": options.integrityOnly = true; break;
      case "--journal": options.journal = readJsonFile(value(), "journal file"); break;
      case "--registry": options.registry = readJsonFile(value(), "registry file"); break;
      case "--artifact": {
        const path = value();
        try {
          options.artifactBytes = readFileSync(path);
        } catch (error) {
          fatal("io_error", `cannot read artifact ${path}: ${error.message}`);
        }
        break;
      }
      case "--jwks": {
        const source = value();
        if (/^https?:\/\//.test(source)) {
          let response;
          try {
            response = await fetch(source, { signal: AbortSignal.timeout(15000) });
          } catch (error) {
            fatal("io_error", `JWKS fetch failed for ${source}: ${error.message}`);
          }
          if (!response.ok) fatal("io_error", `JWKS fetch failed for ${source}: HTTP ${response.status}`);
          try {
            options.jwks = await response.json();
          } catch (error) {
            fatal("io_error", `JWKS at ${source} is not valid JSON: ${error.message}`);
          }
          process.stderr.write(
            `warning: trusted keys fetched from ${source} (discovery) — pin a key with --key for production trust\n`);
        } else {
          options.jwks = readJsonFile(source, "JWKS file");
        }
        break;
      }
      case "--now": {
        const raw = value();
        const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
        if (!Number.isFinite(ms)) fatal("usage_error", `--now must be an ISO timestamp or millisecond epoch, got ${JSON.stringify(raw)}`);
        options.now = ms;
        break;
      }
      default:
        if (arg.startsWith("--")) fatal("usage_error", `unknown flag ${arg}`);
        if (receiptPath !== null) fatal("usage_error", `unexpected extra argument ${arg}`);
        receiptPath = arg;
    }
  }
  if (receiptPath === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (options.expectedPubkey !== undefined && !/^[0-9a-f]{64}$/.test(options.expectedPubkey))
    fatal("usage_error", "--key must be 64 lowercase hex characters (an Ed25519 public key)");

  let receiptText;
  try {
    receiptText = readFileSync(receiptPath, "utf8");
  } catch (error) {
    fatal("io_error", `cannot read receipt ${receiptPath}: ${error.message}`);
  }

  // Replay guard: the seen-file is a JSON array of verified receiptIds. It
  // is only ever extended by a successful verification.
  let seenSet = null;
  if (seenFile !== null) {
    let initial = [];
    if (existsSync(seenFile)) {
      const parsed = readJsonFile(seenFile, "seen file");
      if (!Array.isArray(parsed) || !parsed.every(v => typeof v === "string"))
        fatal("io_error", `seen file ${seenFile} must be a JSON array of receiptId strings`);
      initial = parsed;
    }
    seenSet = new Set(initial);
    options.seen = seenSet;
  }

  const verdict = verifyReceipt(receiptText, options);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);

  if (verdict.ok && seenSet && verdict.receiptId) {
    // verifyReceipt already added the id to the Set on success; persist it.
    try {
      writeFileSync(seenFile, `${JSON.stringify([...seenSet], null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`warning: verdict is verified but the seen file could not be updated: ${error.message}\n`);
    }
  }
  return verdict.ok ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
