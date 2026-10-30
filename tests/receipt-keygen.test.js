// Tests for scripts/receipt-keygen.mjs (A5 §3.7). Every key
// generated here is a throwaway TEST key: subprocess output is
// captured in memory only, never written to disk, never placed in
// an assertion message; assertions report booleans/counts only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  createReceiptSigner,
  issueBountyReceipt,
  verifyBountyReceipt,
  verifyBytes,
} from "../server/bounty-receipts.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/receipt-keygen.mjs", import.meta.url));
const HEX64 = /[0-9a-f]{64}/;

function runKeygen(args, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    ...extra,
  });
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function snapshotTree(root, prefix = "") {
  const entries = [];
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(full);
    if (stat.isDirectory()) entries.push(...snapshotTree(full, rel));
    else entries.push(`${rel}:${stat.size}`);
  }
  return entries;
}

// Verifier side of the genesis statement construction, re-implemented
// here from the description pinned in the keygen header:
// message = canonicalJson({kind, at}) ++ utf8(keyId) ++ utf8(validFrom).
function genesisVerifies(entry) {
  const message = Buffer.concat([
    canonicalJson({ kind: entry.statement.kind, at: entry.statement.at }),
    Buffer.from(entry.keyId, "utf8"),
    Buffer.from(entry.validFrom, "utf8"),
  ]);
  return verifyBytes(message, entry.statement.signature, entry.pubkey);
}

test("generate: contract, round-trip, and genesis signature (A5 §3.7.1-3)", () => {
  const run = runKeygen(["--generate", "--role", "escrow-keeper"]);
  assert.equal(run.status, 0, "generate exits 0");
  const parsed = JSON.parse(run.stdout);
  // Contract shape.
  assert.match(parsed.seedHex, /^[0-9a-f]{64}$/, "seed is 64 lowercase hex");
  assert.match(parsed.pubkeyHex, /^[0-9a-f]{64}$/, "pubkey is 64 lowercase hex");
  assert.equal(parsed.ref, "escrow-keeper", "ref defaults to the role");
  assert.equal(parsed.role, "escrow-keeper");
  assert.equal(parsed.setWith, "wrangler secret put ROOM_RECEIPT_SIGNER_SEED");
  const expectedFingerprint =
    "sha256:" +
    createHash("sha256").update(Buffer.from(parsed.pubkeyHex, "hex")).digest("hex");
  assert.equal(parsed.fingerprint, expectedFingerprint, "fingerprint recomputes");
  assert.equal(parsed.keyId, `${parsed.ref}:${parsed.fingerprint}`, "keyId shape");
  // Seed occurs exactly once across combined output.
  assert.equal(
    countOccurrences(run.stdout + run.stderr, parsed.seedHex),
    1,
    "seed occurs exactly once in combined output",
  );
  // Genesis entry field set and signature.
  const entry = parsed.keyHistoryEntry;
  assert.equal(entry.keyId, parsed.keyId);
  assert.equal(entry.ref, parsed.ref);
  assert.equal(entry.role, "escrow-keeper");
  assert.equal(entry.pubkey, parsed.pubkeyHex);
  assert.equal(entry.fingerprint, parsed.fingerprint);
  assert.equal(entry.status, "active");
  assert.equal(entry.successor, null);
  assert.equal(entry.statement.kind, "genesis");
  assert.equal(entry.statement.at, entry.validFrom, "statement.at equals validFrom");
  assert.match(entry.statement.signature, /^[0-9a-f]{128}$/);
  assert.equal(genesisVerifies(entry), true, "genesis signature verifies");
  // Round-trip: the printed seed drives a signer that issues a
  // fixture receipt which then verifies.
  const signer = createReceiptSigner({ seedHex: parsed.seedHex, ref: parsed.ref });
  assert.equal(signer.pubkeyHex, parsed.pubkeyHex, "signer pubkey matches");
  const receipt = issueBountyReceipt({
    type: "escrow-locked",
    roomId: "room-test",
    bountyId: "TEST-1",
    lotId: "lot_cccccccccccccccc",
    amountMillis: "10000",
    actor: { kind: "agent", id: "id:agent/test" },
    entries: ["ent_aaaaaaaaaaaaaaaa", "ent_bbbbbbbbbbbbbbbb"],
    entryHashes: ["a".repeat(64), "b".repeat(64)],
    payload: { fromAccount: "id:agent/test", fromLotState: "payable" },
    issuer: { pubkey: parsed.pubkeyHex, role: "escrow-keeper", ref: parsed.ref },
    issuedAt: "2026-09-22T12:00:00.000Z",
    seedHex: parsed.seedHex,
  });
  const verdict = verifyBountyReceipt(receipt, { expectedPubkey: parsed.pubkeyHex });
  assert.equal(verdict.ok, true, "issued TEST receipt verifies ok:true");
});

test("non-keeper role: setWith is null (A5 §3.4)", () => {
  const run = runKeygen(["--generate", "--role", "record"]);
  assert.equal(run.status, 0);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.role, "record");
  assert.equal(parsed.setWith, null, "no consumer is invented for record");
  assert.equal(genesisVerifies(parsed.keyHistoryEntry), true);
});

test("two successive runs produce different keypairs (A5 §3.7.6)", () => {
  const first = JSON.parse(runKeygen(["--generate"]).stdout);
  const second = JSON.parse(runKeygen(["--generate"]).stdout);
  assert.notEqual(first.seedHex, second.seedHex, "seeds differ");
  assert.notEqual(first.pubkeyHex, second.pubkeyHex, "pubkeys differ");
});

test("no file writes: tree snapshot and source scan (A5 §3.7.4)", () => {
  const root = mkdtempSync(join(tmpdir(), "receipt-keygen-test-"));
  const before = snapshotTree(root);
  const run = runKeygen(["--generate"], {
    cwd: root,
    env: { ...process.env, HOME: root, TMPDIR: root },
  });
  assert.equal(run.status, 0);
  assert.deepEqual(snapshotTree(root), before, "zero new or modified files");
  const source = readFileSync(SCRIPT, "utf8");
  for (const banned of ["write" + "File", "append" + "File", "create" + "WriteStream"]) {
    assert.equal(source.includes(banned), false, `source has no ${banned} API`);
  }
});

test("regular-file stdout is refused with exit 2 and an empty file (A5 §3.7.5a)", () => {
  const root = mkdtempSync(join(tmpdir(), "receipt-keygen-test-"));
  const outPath = join(root, "captured.txt");
  const fd = openSync(outPath, "w");
  let run;
  try {
    run = spawnSync(process.execPath, [SCRIPT, "--generate"], {
      encoding: "utf8",
      stdio: ["ignore", fd, "pipe"],
    });
  } finally {
    closeSync(fd);
  }
  assert.equal(run.status, 2, "regular-file stdout exits 2");
  const captured = readFileSync(outPath, "utf8");
  assert.equal(captured.length, 0, "refused file stays empty");
  assert.equal(HEX64.test(captured), false, "file contains no 64-hex string");
});

test("bare invocation and --help exit 0 and generate nothing (A5 §3.7.5b)", () => {
  for (const args of [[], ["--help"]]) {
    const run = runKeygen(args);
    assert.equal(run.status, 0, `args ${JSON.stringify(args)} exit 0`);
    assert.equal(HEX64.test(run.stdout), false, "no hex key material on stdout");
    assert.equal(HEX64.test(run.stderr), false, "no hex key material on stderr");
  }
});

test("bad invocations exit 2 before generation (A5 §3.7.5c)", () => {
  const badArgSets = [
    ["--generate", "--role", "a,b"],
    ["--generate", "--count", "3"],
    ["--generate", "--unknown-flag"],
    ["--generate", "positional"],
    ["--generate", "--role", "keeper"],
    ["--generate", "--ref", "Bad_Ref"],
    ["--generate", "--seed", "a".repeat(64)],
  ];
  for (const args of badArgSets) {
    const run = runKeygen(args);
    assert.equal(run.status, 2, `args ${JSON.stringify(args)} exit 2`);
    assert.equal(HEX64.test(run.stdout), false, "nothing generated on stdout");
    assert.equal(HEX64.test(run.stderr), false, "nothing generated on stderr");
  }
});
