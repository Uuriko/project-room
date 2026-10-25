// receipt-keygen.mjs — operator tool that generates ONE bounty-receipt
// signing keypair per run and prints it exactly once to stdout.
//
//   node scripts/receipt-keygen.mjs --generate [--role <role>] [--ref <ref>]
//   node scripts/receipt-keygen.mjs --help        (also: bare invocation)
//
// Custody model: John alone runs this, on his own machine, in a
// non-logged terminal session; no agent runs it or sees its output.
// The tool never writes any file, accepts no seed as input, and
// refuses to run when stdout is a regular file (see below).
// Conformance note: the Receipt Standard §5 Step 2 says "never print
// it" while naming no capture mechanism; this tool adopts the
// satisfiable form of that intent — print exactly once, to a TTY or
// a pipe, never to a file — and this note records the conflict.
//
// GENESIS STATEMENT CONSTRUCTION (pinned here, byte-precise, so the
// S5 key-history reader can implement the identical construction):
//   Let entry be the genesis key-history entry being constructed,
//   with fields keyId, validFrom, and statement {kind, at} where
//   validFrom === statement.at === the generation instant (one UTC
//   ISO string, Date#toISOString form) and kind === "genesis".
//   1. statementNoSig = the object {kind: statement.kind,
//      at: statement.at} — exactly these two keys, no others.
//   2. canonical = canonicalJson(statementNoSig) imported from
//      server/bounty-receipts.mjs (a Buffer of UTF-8 bytes; keys
//      are sorted by canonicalJson itself, so the byte form is
//      {"at":"<at>","kind":"genesis"}).
//   3. tail = utf8(keyId) ++ utf8(validFrom) ++ (rotation only)
//      utf8(predecessor keyId). Genesis has no predecessor, so
//      its tail is exactly the first two segments and no more.
//   4. message = canonical ++ tail: plain byte concatenation,
//      with NO separator, NO length prefix, and NO trailing
//      newline or terminator of any kind.
//   5. statement.signature = signBytes(message, seedHex) imported
//      from server/bounty-receipts.mjs (Ed25519, 128 lowercase
//      hex). For genesis the signing key is the generated key
//      itself, so the signature verifies under the entry's own
//      pubkey; it proves consistency only — the genesis root is
//      established by the ceremony commit, the serving domain,
//      and the verifier's out-of-band pin.
//   A verifier re-implements exactly steps 1–4 from the published
//   entry (taking keyId and validFrom from the entry, kind and at
//   from its statement, and no predecessor for genesis) and checks
//   the Ed25519 signature over the resulting bytes under the
//   entry's pubkey.
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { fstatSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  canonicalJson,
  createReceiptSigner,
  generateReceiptKeyPair,
  signBytes,
} from "../server/bounty-receipts.mjs";

const ROLES = ["escrow-keeper", "record", "public-index"];
const REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HELP = `node scripts/receipt-keygen.mjs --generate [--role <role>] [--ref <ref>]

Generates one bounty-receipt signing keypair and prints it once as
one JSON object on stdout. The seed in that object is production
key material: custody it in your own secret store immediately.

Options:
  --generate       Generate one keypair (required to generate).
  --role <role>    One of: escrow-keeper (default), record,
                   public-index. Exactly one role per run.
  --ref <ref>      Key reference; defaults to the role. Must match
                   [a-z0-9][a-z0-9-]{0,63}.
  --help           Show this help and generate nothing.
`;
const CUSTODY_WARNING =
  "The seed is shown once and stored nowhere by this tool. It is production key material: custody it in your own secret store now, and never paste it into a chat, a repo, or a log. The public key, fingerprint, and key-history entry below the seed are safe to record and publish.\n";
// Fixed self-check probe message (in-memory only, never printed).
const PROBE = Buffer.from("receipt-keygen-self-check-v1", "utf8");
// RFC 8410 SPKI prefix for a raw 32-byte Ed25519 public key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const failUsage = message => {
  process.stderr.write(`receipt-keygen: ${message}\n`);
  process.exit(2);
};

let values;
try {
  ({ values } = parseArgs({
    allowPositionals: false,
    strict: true,
    options: {
      generate: { type: "boolean" },
      role: { type: "string" },
      ref: { type: "string" },
      help: { type: "boolean" },
    },
  }));
} catch (error) {
  failUsage(error.message);
}

if (values.help || !values.generate) {
  process.stdout.write(HELP);
  process.exit(0);
}

const role = values.role ?? "escrow-keeper";
if (!ROLES.includes(role)) {
  failUsage(`--role must be one of: ${ROLES.join(", ")}`);
}
const ref = values.ref ?? role;
if (!REF_PATTERN.test(ref)) {
  failUsage("--ref must match [a-z0-9][a-z0-9-]{0,63}");
}

// Stdout custody check, before anything is generated: a regular
// file would be an uncontrolled plaintext seed file, so refuse.
// A TTY (operator reads and custodies the seed) and a pipe (a
// secret-store tool captures it directly) are both allowed.
let stdoutKind;
try {
  const stat = fstatSync(1);
  if (stat.isFile()) {
    process.stderr.write(
      "receipt-keygen: refusing to generate: stdout is a regular file. " +
        "Run in a terminal or pipe stdout directly to your secret-store tooling.\n",
    );
    process.exit(2);
  }
  stdoutKind = stat.isCharacterDevice() ? "TTY" : "pipe";
} catch (error) {
  if (error && error.code === "EBADF") failUsage("stdout is not available");
  throw error;
}

// All stderr warnings are written before generation, so a captured
// stderr log can never contain key material even by ordering.
process.stderr.write(CUSTODY_WARNING);
process.stderr.write(
  stdoutKind === "TTY"
    ? "receipt-keygen: stdout is a TTY; the seed will be displayed once in this terminal.\n"
    : "receipt-keygen: stdout is a pipe; the seed goes only to the receiving process, which must not log it.\n",
);
if (role === "escrow-keeper") {
  process.stderr.write(
    "receipt-keygen: a genesis self-signature proves consistency only; the root is established by the ceremony commit, the serving domain, and an out-of-band pin.\n",
  );
} else {
  process.stderr.write(
    `receipt-keygen: no consumer exists for role "${role}" yet; setWith is null and no wiring is implied.\n`,
  );
}

const { seedHex, pubkeyHex } = generateReceiptKeyPair();

// Self-check, completed before any print: signer round-trip plus a
// sign/verify probe over a fixed in-memory message. Any failure
// exits non-zero with no key material in any stream.
try {
  const signer = createReceiptSigner({ seedHex, ref });
  if (signer.pubkeyHex !== pubkeyHex) throw new Error("signer pubkey mismatch");
  const probeSignature = signBytes(PROBE, seedHex);
  const probeKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  const probeOk = verifySignature(
    null,
    PROBE,
    probeKey,
    Buffer.from(probeSignature, "hex"),
  );
  if (!probeOk) throw new Error("sign/verify probe failed");
} catch {
  process.stderr.write("receipt-keygen: self-check failed; no key material printed.\n");
  process.exit(1);
}

const validFrom = new Date().toISOString();
const fingerprint =
  "sha256:" + createHash("sha256").update(Buffer.from(pubkeyHex, "hex")).digest("hex");
const keyId = `${ref}:${fingerprint}`;
// Genesis statement signature, per the pinned construction in the
// header: canonicalJson({kind, at}) ++ utf8(keyId) ++
// utf8(validFrom), signed by the generated key itself.
const genesisMessage = Buffer.concat([
  canonicalJson({ kind: "genesis", at: validFrom }),
  Buffer.from(keyId, "utf8"),
  Buffer.from(validFrom, "utf8"),
]);
const keyHistoryEntry = {
  keyId,
  ref,
  role,
  pubkey: pubkeyHex,
  fingerprint,
  status: "active",
  validFrom,
  successor: null,
  statement: {
    kind: "genesis",
    at: validFrom,
    signature: signBytes(genesisMessage, seedHex),
  },
};

const output = {
  seedHex,
  pubkeyHex,
  ref,
  role,
  fingerprint,
  keyId,
  keyHistoryEntry,
  setWith: role === "escrow-keeper" ? "wrangler secret put ROOM_RECEIPT_SIGNER_SEED" : null,
};
process.stdout.write(`${JSON.stringify(output)}\n`);
