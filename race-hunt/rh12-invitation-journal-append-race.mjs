// RH-12: invitation-journal append race — two processes append a journal entry
// for the SAME invitation at the SAME sequence concurrently. The PK
// (invitation_id, sequence) admits exactly one; the no-update/no-delete
// triggers armor history. Expectation: exactly one winner, loser gets a
// constraint error, the surviving row's checksum validates via
// replayInvitationJournal.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { invitationJournalSchema, invitationJournalEntry, replayInvitationJournal } =
  await import(REPO + "/server/invitation-journal.mjs");

const ROUNDS = Number(process.env.ITERS || 60);
const dir = mkdtempSync(join(tmpdir(), "rh12-"));
const dbPath = join(dir, "inv.db");
{
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; PRAGMA foreign_keys=OFF;");
  db.exec(invitationJournalSchema);
  db.close();
}
// Minimal record/audits shapes are validated by replayInvitationJournal; for
// the race we only need the PK/trigger behavior, so insert raw entries.
const driver = `
import { DatabaseSync } from "node:sqlite";
const REPO = ${JSON.stringify(REPO)};
const { invitationJournalEntry } = await import(REPO + "/server/invitation-journal.mjs");
const [invId, seqStr, tag] = [process.argv[1], process.argv[2], process.argv[3]];
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout=8000; PRAGMA foreign_keys=OFF;");
const record = { id: invId };
const audits = [];
const entry = invitationJournalEntry(record, audits, "race-" + tag, Date.now(), null);
entry.sequence = Number(seqStr);
try {
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO membership_invitation_journal(invitation_id,sequence,body,checksum) VALUES(?,?,?,?)")
    .run(entry.invitation_id, entry.sequence, entry.body, entry.checksum);
  db.exec("COMMIT");
  console.log("WON");
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.log("LOST " + String(e.message ?? e).slice(0, 100));
}
db.close();
`;
const runChild = (invId, seq, tag) => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver, invId, String(seq), tag],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("close", () => resolve(out.trim()));
  child.on("error", e => resolve("SPAWN_ERROR " + e.message));
});
let bad = 0, doubleWin = 0, noWin = 0;
try {
  for (let i = 0; i < ROUNDS; i++) {
    const invId = `inv-${i}`;
    const [r1, r2] = await Promise.all([runChild(invId, 1, "a"), runChild(invId, 1, "b")]);
    const w1 = r1 === "WON", w2 = r2 === "WON";
    if (w1 && w2) { doubleWin++; bad++; }
    else if (!w1 && !w2) { noWin++; bad++; console.log(`round ${i}: both lost [${r1}] [${r2}]`); }
    if (i === 0) console.log(`sample: [${r1}] [${r2}]`);
  }
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT COUNT(*) n FROM membership_invitation_journal").get().n;
  const dupes = db.prepare("SELECT invitation_id,sequence,COUNT(*) c FROM membership_invitation_journal GROUP BY 1,2 HAVING c>1").all().length;
  db.close();
  if (rows !== ROUNDS || dupes !== 0) { bad++; console.log(`rows=${rows} expected=${ROUNDS} dupes=${dupes}`); }
  console.log(`RH-12: ${ROUNDS} rounds, double-win=${doubleWin}, no-win=${noWin}, rows=${rows}`);
  console.log(bad === 0 ? "RH-12 RESULT: PASS — journal append admits exactly one writer per sequence"
    : `RH-12 RESULT: FAIL — ${bad} anomalies`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(bad === 0 ? 0 : 2);
