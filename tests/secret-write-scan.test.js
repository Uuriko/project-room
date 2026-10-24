// W10 scan-on-write (B2): a credential-shaped string pasted into a delivery
// or a room message is REFUSED at the shared persistence layer with the
// named error code "secret_detected", and the content is NOT persisted —
// no event row, no delivery on the claim item, no public-work receipt.
// Redaction is not an acceptable substitute: the write does not happen.
//
// Detection reuses the existing detector (server/secret-scan.mjs PATTERNS,
// the same set the CI tree/diff scans run) restricted to its high-confidence
// shapes. Credential samples below are assembled at runtime from fragments
// so this file itself contains no literal secret for the CI tree scan to
// flag (the same convention as tests/secret-scan.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore, validateCommand } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { claimWork, updateWork, ClaimError } from "../server/work-claims.mjs";
import { findSecretWriteFinding, findSecretInFields, SECRET_WRITE_PATTERN_IDS } from "../server/secret-write-scan.mjs";
import { PATTERNS } from "../server/secret-scan.mjs";
import { PublicWorkClaims, publicWorkClaimsSchema } from "../server/public-work-claims.mjs";
import { publicWorkClaimFenceSchema } from "../server/public-work-claim-fence.mjs";

const AWS_KEY = "AKIA" + "Z7".repeat(8); // AKIA + 16 chars: the aws-access-key shape
const SECRETS = [
  ["aws-access-key", `deploy used ${AWS_KEY} from the console`],
  ["aws-secret-key", "aws_secret_access_key = " + "xY9/".repeat(10)],
  ["github-token", "token " + "ghp_" + "a1".repeat(18) + " was in the log"],
  ["private-key", ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ")],
  ["slack-token", "hook " + "xoxb-" + "123456789012-" + "Ab".repeat(10)],
  ["stripe-key", "paid with " + "sk_" + "live_" + "c1".repeat(12)],
  ["room-credential", "my saved identity secret is " + "pri_" + "d".repeat(43)],
  ["telegram-bot-token", "bot " + "123456789" + ":" + "E".repeat(34)],
  ["wallet-seed", 'seed_phrase: "legal winner thank year wave sausage worth useful legal winner thank yellow"'],
];

// Legitimate delivery/message-shaped content that must pass through
// untouched. Each entry is a false-positive probe; several are shapes the
// FULL detector would flag (generic assignments, bearer tokens, high
// entropy) — they are exactly why the write scan uses the high-confidence
// subset only.
export const FP_PROBES = [
  "Delivered: refactored the parser. Tests 214/214 pass. PR https://github.com/Uuriko/project-room/pull/4100",
  "const key = process.env.AWS_ACCESS_KEY_ID; const secret = process.env.AWS_SECRET_ACCESS_KEY; // read from env, never committed",
  "api_key = os.environ['SERVICE_API_KEY']  # env lookup in the delivered fix",
  "artifact sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08, commit e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "request id 550e8400-e29b-41d4-a716-446655440000; session 6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "Authorization: Bearer $TOKEN_FROM_ENV — export it in your shell before running the checks",
  "payload sample: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw",
  "password: 'correct-horse-battery-staple-test-fixture' // test fixture in the delivered suite, not a real credential",
  "fixture token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-fixture-signature' in the auth tests",
  "npm config set //registry.npmjs.org/:_authToken=${NPM_TOKEN}",
  "-----BEGIN CERTIFICATE----- (the delivered runbook shows a public cert, not a key)",
  "Deploy key fingerprint: SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8 (public fingerprint)",
  "Followed the AWS docs, whose example key is AKIAIOSFODNN7EXAMPLE — docs example only",
  "checks: unit pass (a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4), lint pass; coverage 98.6%",
  "bundle hash 1f2e3d4c5b6a79880102030405060708aabbccddeeff00112233445566778899aabbccdd and SRI sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8w=",
  "Ran: AKIA is the prefix every AWS access key id starts with; rotate yours in the console if it leaked",
];

const isSecretRefusal = secret => error => {
  assert.equal(error.status ?? 422, 422);
  assert.equal(error.code, "secret_detected");
  assert.match(error.message, /credential/);
  assert.equal(error.message.includes(secret), false, "refusal copy must not echo the secret");
  return true;
};

test("room message carrying a credential is refused and never persisted", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const eventsBefore = f.store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id='commons'").get().n;
  const body = `here is the key from my console: ${AWS_KEY}`;
  assert.throws(
    () => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "w10-secret-msg", body } }),
    isSecretRefusal(AWS_KEY));
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id='commons'").get().n, eventsBefore,
    "no event row may be written for a refused message");
  assert.equal(f.store.room("commons").state.messages.some(m => m.id === "w10-secret-msg" || (m.body ?? "").includes(AWS_KEY)), false,
    "the refused body must not reach the room projection");
  // The same door still accepts a clean message afterwards.
  const ok = f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "w10-clean-msg", body: "clean delivery note" } });
  assert.ok(ok.sequence > 0);
});

test("validateCommand refuses credential shapes in message, edit, DM and room delivery fields", () => {
  for (const [rule, text] of SECRETS) {
    assert.throws(() => validateCommand({ id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: text } }),
      isSecretRefusal(text), `message.posted must refuse ${rule}`);
    assert.throws(() => validateCommand({ id: randomUUID(), type: T.MESSAGE_EDITED, data: { messageId: "m1", body: text } }),
      isSecretRefusal(text), `message.edited must refuse ${rule}`);
    assert.throws(() => validateCommand({ id: randomUUID(), type: T.DM_POSTED, data: { to: "someone", body: text } }),
      isSecretRefusal(text), `dm.posted must refuse ${rule}`);
    assert.throws(() => validateCommand({ id: randomUUID(), type: T.WORK_COMPLETED, data: { workItemId: "w1", summary: text } }),
      isSecretRefusal(text), `work.completed summary must refuse ${rule}`);
  }
});

test("work-claim delivery carrying a credential is refused and the claim keeps no delivery", () => {
  const started = updateWork(claimWork({ id: "w10-a" }, "quill"), "quill", { state: "in_progress" });
  const delivery = {
    artifact: { kind: "text", ref: "result bundle", sha256: "a".repeat(64) },
    checks: [{ name: "deploy", result: "pass", command: `AWS_ACCESS_KEY_ID=${AWS_KEY} ./ship.sh` }],
    criteria: [],
  };
  assert.throws(() => updateWork(started, "quill", { state: "delivered", delivery }),
    error => error instanceof ClaimError && isSecretRefusal(AWS_KEY)(error));
  // A refused finish also fires via the finish note (history text).
  assert.throws(() => updateWork(started, "quill", { state: "delivered", note: `key is ${AWS_KEY}` }),
    error => error instanceof ClaimError && error.code === "secret_detected");
  // Clean delivery still lands.
  const clean = updateWork(started, "quill", { state: "delivered",
    delivery: { artifact: { kind: "text", ref: "result bundle", sha256: "a".repeat(64) }, checks: [{ name: "unit", result: "pass", command: "npm test" }], criteria: [] } });
  assert.equal(clean.state, "delivered");
  assert.ok(clean.delivery);
});

test("public-work finish artifact carrying a credential is refused; no receipt row is written", t => {
  const dir = mkdtempSync(join(tmpdir(), "w10-public-work-")), file = join(dir, "room.sqlite");
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const service = new PublicWorkClaims(store);
  const worker = store.identities.create("W10 worker");
  store.projectOffers.create("commons", "owner", { requestId: "w10-create", offerId: "w10:task", reviewerMemberIds: ["owner"],
    terms: { kind: "task", title: "w10:task", summary: "Public result", acceptanceCriteria: ["Deliver the declared change"],
      repositoryUrl: "https://github.com/Example/Project", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", "w10:task", "publish", { requestId: "w10-publish", expectedRevision: 1 });
  service.enable("commons", "owner", "w10:task", { requestId: "w10-enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["docs/x.md"] });
  service.act("w10:task", worker.secret, "claim", { requestId: "w10-claim", expectedTermsVersion: 1 });
  const artifactText = `result attached; staging key ${AWS_KEY} used while testing`;
  assert.throws(() => service.act("w10:task", worker.secret, "finish",
    { requestId: "w10-finish", expectedTermsVersion: 1, generation: 1, artifactText, checksReported: ["unit: pass"] }),
    isSecretRefusal(AWS_KEY));
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM public_work_receipts").get().n, 0,
    "a refused artifact must not reach public_work_receipts");
  // The claim survives the refusal: a clean re-submit on the same generation lands.
  const done = service.act("w10:task", worker.secret, "finish",
    { requestId: "w10-finish-clean", expectedTermsVersion: 1, generation: 1, artifactText: "result attached, all checks green", checksReported: ["unit: pass"] });
  assert.equal(done.receipt.state, "submitted");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM public_work_receipts").get().n, 1);
});

test("write-scan subset is derived from the CI detector's PATTERNS, with named exclusions", () => {
  const all = PATTERNS.map(pattern => pattern.id);
  for (const id of SECRET_WRITE_PATTERN_IDS) assert.ok(all.includes(id), `${id} must come from secret-scan PATTERNS`);
  // Excluded on purpose (FP rationale in server/secret-write-scan.mjs):
  for (const excluded of ["generic-api-key", "generic-secret", "bearer-token"])
    assert.equal(SECRET_WRITE_PATTERN_IDS.includes(excluded), false, `${excluded} stays CI-only`);
  for (const [rule, text] of SECRETS) {
    const hit = findSecretWriteFinding(text);
    assert.equal(hit?.rule, rule, `expected ${rule}`);
    assert.deepEqual(Object.keys(hit).sort(), ["label", "rule"], "findings carry no preview and no secret material");
    assert.equal(JSON.stringify(hit).includes(text), false);
  }
  // The excluded shapes and the entropy rule produce no write finding:
  assert.equal(findSecretWriteFinding("password = 'a-very-plausible-real-looking-value-123456'"), null);
  assert.equal(findSecretWriteFinding("api_key: 'abcdef0123456789abcdef0123456789'"), null);
  assert.equal(findSecretWriteFinding("Authorization: Bearer abcdef0123456789abcdef0123456789abcdef01"), null);
  assert.equal(findSecretWriteFinding("digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), null);
  const nested = findSecretInFields({ delivery: { checks: [{ command: `ship ${AWS_KEY}` }] } });
  assert.equal(nested?.field, "delivery");
  assert.equal(nested?.rule, "aws-access-key");
});

test("false-positive probes pass through every scanned door untouched", () => {
  for (const probe of FP_PROBES) {
    assert.doesNotThrow(() => validateCommand({ id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: probe } }),
      `probe must pass message.posted: ${probe.slice(0, 60)}`);
    assert.doesNotThrow(() => validateCommand({ id: randomUUID(), type: T.WORK_COMPLETED, data: { workItemId: "w1", summary: probe } }),
      `probe must pass work.completed: ${probe.slice(0, 60)}`);
  }
});
