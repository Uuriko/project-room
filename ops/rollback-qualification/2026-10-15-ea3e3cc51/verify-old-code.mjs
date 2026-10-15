// Rollback qualification — OLD CODE phase (packet §3.3 oldCodeNewData).
// Restores the candidate-written fixture, boots the exact rollback source
// (c0e5aefbf…) against it, exercises old-code reads and representative
// writes, and diffs per-table counts before/after with attribution.
//
// Usage: OLD_ROOT=<checkout of c0e5aefbf> QUAL_SCRATCH=<dir> QUAL_SECRETS=<file> \
//        node verify-old-code.mjs
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OLD_ROOT = process.env.OLD_ROOT;
const scratch = process.env.QUAL_SCRATCH;
const secretsPath = process.env.QUAL_SECRETS;
if (!OLD_ROOT || !scratch || !secretsPath) throw new Error("OLD_ROOT, QUAL_SCRATCH, QUAL_SECRETS are required");
mkdirSync(scratch, { recursive: true });

const imp = rel => import(pathToFileURL(join(OLD_ROOT, rel)).href);
const fixtureDir = process.cwd();
const fixtureText = readFileSync(join(fixtureDir, "fixture.ndjson"), "utf8");
const manifest = JSON.parse(readFileSync(join(fixtureDir, "fixture-manifest.json"), "utf8"));
const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
const sha256 = text => createHash("sha256").update(text).digest("hex");

const run = { kind: "rollback-qualification-old-code-run", oldSourceRevision: "c0e5aefbf89e6870b2fbec9f44df81363ed22a14",
  candidateSourceRevision: manifest.candidateSourceRevision, startedAt: new Date().toISOString(), steps: [] };
const step = (id, fn) => Promise.resolve().then(fn)
  .then(detail => run.steps.push({ id, ok: true, detail }))
  .catch(error => run.steps.push({ id, ok: false, error: String(error?.message ?? error) }));

function inventory(text) {
  const perTable = {};
  let trailer = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.kind === "trailer") { trailer = record; continue; }
    if (record.table) perTable[record.table] = (perTable[record.table] ?? 0) + 1;
  }
  return { perTable, trailer };
}

// ---- R1: restore the candidate-written fixture with OLD replay machinery.
const { replayNdjson } = await imp("server/room-export.mjs");
const restoredPath = join(scratch, "restored.sqlite");
let replayResult = null, replayError = null;
try { replayResult = await replayNdjson(fixtureText, restoredPath); }
catch (error) { replayError = String(error?.message ?? error); }
run.replayWithOldCode = { result: replayResult, error: replayError };

// Fallback (recorded, not hidden): if old replay refuses the candidate's
// trailer-v2 export, restore with the candidate replay code, then still boot
// OLD code on the restored store. The Worker rollback itself never replays
// NDJSON — the DO store persists in place — so boot compat is the question
// this fallback isolates.
let restoredBy = replayError ? null : "old-code replayNdjson";
if (replayError) {
  const candRoot = process.env.CAND_ROOT;
  if (!candRoot) throw new Error("old replay failed and CAND_ROOT not provided for the documented fallback");
  const cand = await import(pathToFileURL(join(candRoot, "server/room-export.mjs")).href);
  const result = await cand.replayNdjson(fixtureText, restoredPath);
  run.replayFallbackWithCandidateCode = { result };
  restoredBy = "candidate-code replayNdjson (old replay refused the fixture export; see replayWithOldCode.error)";
}
run.restoredBy = restoredBy;

// ---- R2: boot the exact rollback source against the restored store.
const { RoomStore } = await imp("server/store.mjs");
const { PublicWorkClaims } = await imp("server/public-work-claims.mjs");
const { exportNdjsonText } = await imp("server/room-export.mjs");
const { syncClaimPullRequests } = await imp("server/claim-pr-sync.mjs");
const { EVENT_TYPES: T } = await imp("src/events.js");
const { randomUUID } = await import("node:crypto");

const store = new RoomStore(restoredPath, { now: () => Date.now() });
run.oldBoot = { coldStart: store.coldStart ?? null, threw: false };

const dbCounts = st => {
  const counts = {};
  for (const { name } of st.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
    counts[name] = st.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n;
  return counts;
};

// ---- R3: snapshot before old-code writes; compare with the fixture.
const beforeExport = exportNdjsonText(store.db);
const before = inventory(beforeExport);
const beforeDb = dbCounts(store);
run.beforeOldWrites = { exportTrailer: before.trailer, perTable: before.perTable };
run.fixtureVsRestored = {
  fixturePerTable: manifest.fixture.perTableCounts,
  restoredPerTable: before.perTable,
  permitRowInRestoredDb: store.db.prepare("SELECT * FROM public_work_claim_writer_permit").all()
    .map(row => ({ singleton: row.singleton, enabled: row.enabled })),
};

// ---- R4: old-code exercises.
const service = () => new PublicWorkClaims(store);
const receiptId = manifest.submittedClaims[0]?.claim?.submittedReceiptId;
const round2Id = manifest.reseedOutcome.rounds[0];

await step("E1 room read", () => {
  const room = store.room("commons");
  return { found: Boolean(room), sequence: room?.sequence ?? null };
});
await step("E2 events/messages read", () => {
  const events = store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id='commons'").get().n;
  const messages = store.db.prepare("SELECT count(*) AS n FROM messages").get().n;
  return { events, messages };
});
await step("E3 public board listing", () => {
  const board = service().list({ limit: 100 });
  return { tasks: board.tasks.length, claimableCount: board.claimableCount };
});
await step("E4 receipt read", () => {
  const receipt = service().receipt(receiptId);
  return { receiptId, rendered: Boolean(receipt), keys: receipt ? Object.keys(receipt).slice(0, 12) : [] };
});
await step("E5 account + sessions read", () => {
  const account = store.account(secrets.accountId);
  const sessions = store.listAccountSessions(secrets.accountId);
  return { accountActive: account.active, sessionsListed: sessions.length };
});
await step("E6 candidate session slot read by token", () => {
  const slot = store.accountSessionSlot(secrets.slotToken);
  return { accountId: slot?.accountId ?? null, live: Boolean(slot) };
});
await step("E7 candidate OAuth pending state read", () => {
  const entry = store.oauthPendingStateGet("github", secrets.oauthStateHash);
  return { found: Boolean(entry), provider: "github" };
});
await step("E8 claim-prs sync over candidate claims (stub fetch, 404)", async () => {
  const stubFetch = async () => new Response(JSON.stringify({ message: "Not Found" }),
    { status: 404, headers: { "content-type": "application/json" } });
  const out = await syncClaimPullRequests(store, { env: {}, fetchImpl: stubFetch, nowMs: Date.now(), deadline: Date.now() + 60000 });
  return out;
});
await step("E8b workClaims reads (valid + malformed)", () => {
  const out = {};
  try { out.valid = Boolean(store.workClaims.get("commons", "qual-claim-pr-1")); }
  catch (error) { out.validError = String(error?.message ?? error); }
  try { const bad = store.workClaims.get("commons", "qual-claim-malformed-repo"); out.malformed = bad ? { repo: bad.repo ?? null } : null; }
  catch (error) { out.malformedError = String(error?.message ?? error); }
  return out;
});
await step("E9 old-code public-work claim lifecycle (round-2 task)", () => {
  const worker = store.identities.create("Old-code rollback worker");
  service().act(round2Id, worker.secret, "claim", { requestId: "old-claim", expectedTermsVersion: 1 });
  service().act(round2Id, worker.secret, "finish",
    { requestId: "old-finish", expectedTermsVersion: 1, generation: 1, artifactText: "Finished under old code", checksReported: [] });
  const readBack = service().read(round2Id);
  return { taskId: round2Id, finishedState: readBack?.claim?.state ?? null, claimableAfter: service().list({ limit: 100 }).claimableCount };
});
await step("E10 old-code session write (new slot + login)", () => {
  const slot = store.createAccountSessionSlot();
  const before = store.accountSessionSlot(slot.token);
  const login = store.loginAccountSessionWithMethod(slot.token, secrets.accountId, before.sessionRevision,
    { method: { kind: "magic-link", ref: "qual-old@example.invalid" } });
  return { loggedIn: Boolean(login) };
});
await step("E11 old-code auth-mail state write (verify code)", () => {
  store.accountLogins.issueEmailVerifyCode({ accountId: secrets.accountId, email: "qual-old@example.invalid" });
  return { issued: true };
});
await step("E12 old-code message write", () => {
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "Written by old code on candidate data." } });
  return { posted: true };
});

// ---- R5: after snapshot + attributed diff.
const afterExport = exportNdjsonText(store.db);
const after = inventory(afterExport);
const afterDb = dbCounts(store);
store.close();
run.afterOldWrites = { exportTrailer: after.trailer, perTable: after.perTable };
const allTables = new Set([...Object.keys(before.perTable), ...Object.keys(after.perTable)]);
run.deltas = [...allTables].sort().map(table => ({
  table, before: before.perTable[table] ?? 0, after: after.perTable[table] ?? 0,
  delta: (after.perTable[table] ?? 0) - (before.perTable[table] ?? 0),
})).filter(row => row.delta !== 0);

// ---- R6 (supplementary): boot OLD code directly on the candidate-written
// sqlite file — the closest local analog of a real DO rollback, where the
// store persists in place and only the code reverts.
const directPath = join(scratch, "direct.sqlite");
copyFileSync(join(process.env.QUAL_BUILD_SCRATCH, "fixture-src.sqlite"), directPath);
try {
  const direct = new RoomStore(directPath, { now: () => Date.now() });
  const room = direct.room("commons");
  run.directBootOnCandidateSqlite = { threw: false, coldStart: direct.coldStart ?? null,
    roomFound: Boolean(room), counts: dbCounts(direct) };
  direct.close();
} catch (error) {
  run.directBootOnCandidateSqlite = { threw: true, error: String(error?.message ?? error) };
}

run.finishedAt = new Date().toISOString();
writeFileSync(join(fixtureDir, "old-code-run.json"), JSON.stringify(run, null, 2) + "\n");
console.log(JSON.stringify({ replayError, restoredBy, steps: run.steps.map(s => ({ id: s.id, ok: s.ok })),
  deltas: run.deltas, directBootThrew: run.directBootOnCandidateSqlite?.threw }, null, 2));
