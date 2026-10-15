// Rollback qualification fixture builder — CANDIDATE code phase.
// Packet: ~/workspace/strategy-2026-10/deploy-packet-2026-10-15.md §3.2.
//
// Boots the exact candidate source (this checkout) against a fresh isolated
// store using the repo's own test/store machinery, exercises representative
// candidate writes, and exports the candidate-written store as NDJSON.
// Secrets produced along the way (identity secret, session slot token) are
// written ONLY to a scratch sidecar named by QUAL_SECRETS (never committed).
//
// Usage: QUAL_SCRATCH=<dir> QUAL_SECRETS=<file> node build-fixture.mjs
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RoomStore } from "../../../server/store.mjs";
import { initialRoom } from "../../../server/bootstrap.mjs";
import { PublicWorkClaims, publicWorkClaimsSchema, PUBLIC_WORK_STARTER_SEED_IDS } from "../../../server/public-work-claims.mjs";
import { publicWorkClaimFenceSchema } from "../../../server/public-work-claim-fence.mjs";
import { exportNdjsonText } from "../../../server/room-export.mjs";
import { createWork } from "../../../server/work-claims.mjs";
import { BountyEscrow } from "../../../server/bounty-escrow.mjs";
import { SOURCE_REVISION } from "../../../server/version.mjs";
import { EVENT_TYPES as T } from "../../../src/events.js";

// SOURCE_REVISION in a source checkout is the literal "unstamped" — the
// deploy bundle stamps it. The authoritative candidate identity is the git
// SHA of this checkout, passed by the runner.
const CANDIDATE_SHA = process.env.QUAL_CANDIDATE_SHA ?? "unknown";

const scratch = process.env.QUAL_SCRATCH;
const secretsPath = process.env.QUAL_SECRETS;
if (!scratch || !secretsPath) throw new Error("QUAL_SCRATCH and QUAL_SECRETS are required");
mkdirSync(scratch, { recursive: true });

const sha256 = text => createHash("sha256").update(text).digest("hex");
const writes = [];
const note = (id, detail) => writes.push({ id, detail });

// The operator's original starter terms, mirrored from the repo's own reseed
// test fixture (tests/public-work-reseed.test.js), which mirrors the live board.
const SEED_TERMS = {
  'pw-garden-firsttask-probe-20261005': { title: 'Newcomer-safe: llms.txt public-work golden path probe', files: ['deploy/agent-discovery.mjs'],
    acceptanceCriteria: ['Artifact walks each golden-path step with the exact command used and the outcome', 'Every discrepancy quotes the llms.txt line and the actual behavior', 'Probe uses a fresh QA- identity; no room membership required'] },
  'pw-garden-glossary-20261005': { title: 'Newcomer glossary: agent-room jargon', files: ['docs/GLOSSARY.md'],
    acceptanceCriteria: ['Artifact defines all eight terms in plain language with one example each', 'Total length 300-600 words', 'Tone suitable for a first-day stranger; no internal codenames'] },
  'pw-garden-linkcheck-20261005': { title: 'Docs link sweep: SWARM-PLUG-IN.md', files: ['docs/SWARM-PLUG-IN.md'],
    acceptanceCriteria: ['Artifact lists every link checked with OK/BROKEN/STALE verdict and line number', 'Broken or stale entries include a concrete suggested replacement', 'Artifact is valid UTF-8 text under 64 KiB'] },
  'pw-garden-mcp-paths-20261005': { title: 'MCP endpoint path consistency audit', files: ['docs/JOIN-ANY-AGENT.md'],
    acceptanceCriteria: ['Artifact catalogs every MCP path mention found with file, line, and quoted context', 'Inconsistencies are grouped by concept with a recommended canonical path', 'No file edits required; read-only audit'] },
};

const dbPath = join(scratch, "fixture-src.sqlite");
const store = new RoomStore(dbPath, { now: () => Date.now() });
const candidateBoot = store.coldStart ?? null;
note("W0", `candidate RoomStore cold start on empty store (candidate git ${CANDIDATE_SHA})`);

store.initialize(initialRoom());
note("W1", "initialize(initialRoom()) — room 'commons' bootstrap events");
store.db.exec(publicWorkClaimsSchema);
store.db.exec(publicWorkClaimFenceSchema);

const ownerKey = store.issueAccessKey("commons", "owner");
note("W2", "issueAccessKey('commons','owner') — credentials row");

store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
  data: { memberId: "qual-agent", displayName: "Rollback qual agent", kind: "agent", permissions: ["accept_work"] } });
note("W3", "MEMBER_ADDED qual-agent via store.command");
const agentKey = store.issueAccessKey("commons", "qual-agent");
store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
  data: { messageId: randomUUID(), body: "Rollback qualification fixture: owner message." } });
store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
  data: { messageId: randomUUID(), body: "Rollback qualification fixture: agent reply." } });
note("W4", "MESSAGE_POSTED x2 (owner + agent) — event/message writes");

const accountId = "acct-rollback-qual";
store.createAccount(accountId, "rollback-qual-fixture");
note("W5", `createAccount('${accountId}') — accounts + terms rows`);
store.accountLogins.issueEmailVerifyCode({ accountId, email: "qual@example.invalid" });
note("W6", "accountLogins.issueEmailVerifyCode — account_magic_codes row (auth-mail persisted state; code value not recorded)");

const slot = store.createAccountSessionSlot();
const login = store.loginAccountSessionWithMethod(slot.token, accountId, slot.session.sessionRevision,
  { method: { kind: "magic-link", ref: "qual@example.invalid" } });
note("W7", "createAccountSessionSlot + loginAccountSessionWithMethod — live account session on candidate data");
const oauthStateHash = sha256("rollback-qual-github-state");
store.oauthPendingStateCreate({ provider: "github", stateHash: oauthStateHash, slotToken: slot.token,
  expectedRevision: login.sessionRevision ?? slot.session.sessionRevision, verifier: "rollback-qual-verifier",
  expiresAt: Date.now() + 600000, link: false });
note("W8", "oauthPendingStateCreate(provider='github') — #3533 OAuth pending-state row");

const service = () => new PublicWorkClaims(store);
for (const id of PUBLIC_WORK_STARTER_SEED_IDS) {
  const terms = SEED_TERMS[id];
  store.projectOffers.create("commons", "owner", { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ["owner"],
    terms: { kind: "task", title: terms.title, summary: "Public starter task for new agents.", acceptanceCriteria: terms.acceptanceCriteria,
      repositoryUrl: "https://github.com/uuriko/project-room", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", id, "publish", { requestId: `publish-${id}`, expectedRevision: 1 });
  service().enable("commons", "owner", id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: terms.files });
}
note("W9", "starter seeds x4 anchored (projectOffers create/publish + public-work enable)");

const worker = store.identities.create("Rollback qual worker");
let seq = 0;
const finishResults = {};
for (const id of PUBLIC_WORK_STARTER_SEED_IDS) {
  const stamp = `w-${++seq}`;
  service().act(id, worker.secret, "claim", { requestId: `${stamp}-claim`, expectedTermsVersion: 1 });
  finishResults[id] = service().act(id, worker.secret, "finish",
    { requestId: `${stamp}-finish`, expectedTermsVersion: 1, generation: 1, artifactText: `Done ${id}`, checksReported: [] });
}
note("W10", "public-work claim lifecycle x4 (claim -> finish) by a fresh identity — board drained to claimable 0");

const reseed = service().reseedStarterPool();
note("W11", `reseedStarterPool() -> seeded=${reseed.seeded} (candidate #3540 replenishment write path)`);

store.workClaims.set("commons", createWork(
  { id: "qual-claim-pr-1", title: "Qual claim linked to a pull request", repo: "Uuriko/project-room",
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/3536" } },
  { now: Date.now(), agentId: "owner" }));
note("W12", "workClaims.set room claim with PR link (claim-prs source data)");

// Stored-data authoring, labeled as such: production carries residual
// malformed work_claims.repo rows that claim-prs must skip (packet §2.7).
// work_claims rows are wrapped ({v, kind, data}); the claim item — and its
// repo — lives under .data. Clone the valid row with an unparseable
// data.repo (a first cut malformed only the wrapper and the row stayed
// valid; that authoring error was caught by the old-code read-back and is
// recorded in evidence.md).
{
  const row = store.db.prepare("SELECT item_json FROM work_claims WHERE room_id='commons' AND claim_id='qual-claim-pr-1'").get();
  const item = JSON.parse(row.item_json);
  item.data.id = "qual-claim-malformed-repo";
  item.data.repo = "not a repo!!";
  store.db.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES ('commons', ?, ?, ?)")
    .run("qual-claim-malformed-repo", JSON.stringify(item), Date.now());
  const readBack = store.workClaims.get("commons", "qual-claim-malformed-repo");
  if (readBack?.repo !== "not a repo!!") throw new Error("malformed row authoring failed: read-back repo is " + readBack?.repo);
}
note("W13", "malformed work_claims row inserted via SQL clone (production-residue shape for claim-prs skip behavior)");

const escrow = new BountyEscrow(store, { now: () => Date.now(), allowLegacyStringLanes: true });
escrow.ensureGenesis("commons");
const { bounty } = escrow.postBounty("commons", { poster: "qual-agent", title: "Rollback qual bounty",
  criteria: "Fixture money state", amount: 10, deadline: new Date(Date.now() + 3600000).toISOString() });
escrow.fundBounty("commons", bounty.bountyId, { funder: "qual-agent" });
note("W14", `BountyEscrow postBounty + fundBounty (${bounty.bountyId}) — bounty_records + bounty_journal money state`);

// Receipt identity for one finished starter task, for the old-code phase.
const finishedRead = service().read(PUBLIC_WORK_STARTER_SEED_IDS[0]);
const receiptIds = service().list({ limit: 100 }).tasks
  .filter(task => task.claim?.state === "submitted")
  .map(task => ({ taskId: task.taskId, claim: task.claim }));

// Export the candidate-written store and inventory it.
const text = exportNdjsonText(store.db);
const lines = text.split("\n").filter(line => line.trim() !== "");
const perTable = {};
let trailer = null, header = null;
for (const line of lines) {
  const record = JSON.parse(line);
  if (record.kind === "trailer") { trailer = record; continue; }
  if (record.kind === "header") { header = record; continue; }
  if (record.table) perTable[record.table] = (perTable[record.table] ?? 0) + 1;
}
const dbCounts = {};
for (const { name } of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
  dbCounts[name] = store.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n;
}
store.close();

const fixturePath = join(process.cwd(), "fixture.ndjson");
writeFileSync(fixturePath, text);
writeFileSync(secretsPath, JSON.stringify({ workerSecret: worker.secret, workerId: worker.id ?? null,
  slotToken: slot.token, accountId, oauthStateHash }, null, 2), { mode: 0o600 });

const manifest = {
  kind: "rollback-qualification-fixture",
  candidateSourceRevision: CANDIDATE_SHA,
  moduleStampInCheckout: SOURCE_REVISION,
  builtAt: new Date().toISOString(),
  candidateBoot,
  writes,
  reseedOutcome: { seeded: reseed.seeded, rounds: reseed.rounds, errors: reseed.errors },
  bountyId: bounty.bountyId,
  submittedClaims: receiptIds,
  fixture: {
    file: "fixture.ndjson",
    bytes: statSync(fixturePath).size,
    sha256: sha256(text),
    header,
    trailer,
    eventCount: trailer?.events ?? null,
    perTableCounts: perTable,
    dbTableCounts: dbCounts,
  },
};
writeFileSync(join(process.cwd(), "fixture-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, sourceRevision: CANDIDATE_SHA, bytes: manifest.fixture.bytes,
  sha256: manifest.fixture.sha256, trailerVersion: trailer?.version, events: trailer?.events,
  tables: Object.keys(perTable).length, reseedSeeded: reseed.seeded }, null, 2));
