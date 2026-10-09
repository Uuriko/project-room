// T2: writer-fence + public-work-claim-fence verification (node:sqlite).
// 1. installWriterFence blocks a writer connection that never registered the
//    writer function (simulates an older/stale service connection).
// 2. verifyWriterFence detects a tampered trigger (fence bypass attempt).
// 3. unfenced additive tables stay writable without the writer function (by design).
// 4. public-work-claim-fence: direct public-namespace write blocked without the
//    permit; allowed inside withPublicWorkClaimWriter; permit left open at rest
//    fails verification; async fn is refused.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WT = dirname(dirname(fileURLToPath(import.meta.url)));
const fence = await import(join(WT, "server/writer-fence.mjs"));
const pub = await import(join(WT, "server/public-work-claim-fence.mjs"));

let pass = 0, fail = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + ": " + name); cond ? pass++ : fail++; };

// --- writer fence ---
const f = join(mkdtempSync(join(tmpdir(), "g20-fence-")), "f.db");
const db = new DatabaseSync(f);
// create every table the current-version fence covers (triggers need them)
const tables = new Set(fence.fenceDefinitions(fence.STORE_SCHEMA_VERSION)
  .map(d => d.name.replace(/^writer_v\d+_/, "").replace(/_(insert|update|delete)$/, "")));
for (const t of tables) db.exec(`CREATE TABLE "${t}" (id TEXT PRIMARY KEY)`);
db.exec("CREATE TABLE public_work_tasks (namespace_key TEXT PRIMARY KEY)");
db.exec("CREATE TABLE work_claims (room_id TEXT, claim_id TEXT, PRIMARY KEY(room_id, claim_id))");
db.exec("CREATE TABLE work_claim_config (room_id TEXT PRIMARY KEY)");
fence.registerWriter(db);
db.exec("BEGIN IMMEDIATE");
fence.installWriterFence(db);
db.exec("COMMIT");
ok(true, "fence installed");

// stale writer: fresh connection, no registerWriter
const stale = new DatabaseSync(f);
let blocked = false;
try { stale.prepare("INSERT INTO rooms(id) VALUES('r1')").run(); }
catch (e) { blocked = /unsupported database writer|no such function/i.test(e.message); }
ok(blocked, "stale writer INSERT into fenced table blocked by trigger");
db.close(); stale.close();

// tamper: drop one trigger on a copy -> verifyWriterFence must throw
const f2 = f + ".2";
const { copyFileSync } = await import("node:fs");
copyFileSync(f, f2);
const db2 = new DatabaseSync(f2);
fence.registerWriter(db2);
try { fence.verifyWriterFence(db2); ok(true, "verifyWriterFence passes on intact fence"); }
catch (e) { ok(false, "verifyWriterFence passes on intact fence (" + e.message + ")"); }
db2.exec("DROP TRIGGER writer_v38_rooms_insert");
let tamperCaught = false;
try { fence.verifyWriterFence(db2); } catch (e) { tamperCaught = /reconciliation/.test(e.message); }
ok(tamperCaught, "verifyWriterFence detects tampered (dropped) trigger");

// unfenced additive table: writable without writer registration (by design)
// note: public_work_tasks is in unfencedAdditiveTables; the writer fence has no triggers for it
const db4 = new DatabaseSync(f2);
let additiveWritable = false;
try { db4.prepare("INSERT INTO public_work_tasks(namespace_key) VALUES('pub1')").run(); additiveWritable = true; }
catch (e) { console.log("  additive write error:", e.message.slice(0, 80)); }
ok(additiveWritable, "unfenced additive table writable by unregistered writer (by design)");
db2.close(); db4.close();

// --- public work-claim fence ---
const pf = join(mkdtempSync(join(tmpdir(), "g20-pubfence-")), "p.db");
const pdb = new DatabaseSync(pf);
pdb.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY); CREATE TABLE work_claims (room_id TEXT, claim_id TEXT, PRIMARY KEY(room_id, claim_id)); CREATE TABLE work_claim_config (room_id TEXT PRIMARY KEY);");
pdb.exec("CREATE TABLE public_work_tasks (namespace_key TEXT PRIMARY KEY);");
pdb.prepare("INSERT INTO public_work_tasks(namespace_key) VALUES('roomA')").run();
pdb.exec(pub.publicWorkClaimFenceSchema);
const store = { db: pdb, transaction(fn) { pdb.exec("BEGIN IMMEDIATE"); try { const r = fn(); pdb.exec("COMMIT"); return r; } catch (e) { try { pdb.exec("ROLLBACK"); } catch {} throw e; } } };

let directBlocked = false;
try { pdb.prepare("INSERT INTO work_claims(room_id, claim_id) VALUES('roomA','c1')").run(); }
catch (e) { directBlocked = /unsupported public claim writer/.test(e.message); }
ok(directBlocked, "public-namespace claim write blocked without permit");

let insideOk = false;
try {
  pub.withPublicWorkClaimWriter(store, () => {
    pdb.prepare("INSERT INTO work_claims(room_id, claim_id) VALUES('roomA','c1')").run();
    insideOk = true;
  });
} catch (e) { console.log("  withPublicWorkClaimWriter error:", e.message.slice(0, 100)); }
ok(insideOk, "public-namespace claim write allowed inside withPublicWorkClaimWriter");

// permit must be closed at rest
let restOk = false;
try { restOk = pub.verifyPublicWorkClaimFence(pdb) === true; } catch (e) { console.log("  verify error:", e.message.slice(0, 100)); }
ok(restOk, "permit closed at rest after withPublicWorkClaimWriter");

// permit left open -> verification fails
pdb.prepare("UPDATE public_work_claim_writer_permit SET enabled=1 WHERE singleton=1").run();
let openCaught = false;
try { pub.verifyPublicWorkClaimFence(pdb); } catch (e) { openCaught = /closed at rest/.test(e.message); }
ok(openCaught, "verifyPublicWorkClaimFence fails when permit left open");
pdb.prepare("UPDATE public_work_claim_writer_permit SET enabled=0 WHERE singleton=1").run();

// async fn refused
let asyncRefused = false;
try { pub.withPublicWorkClaimWriter(store, async () => {}); } catch (e) { asyncRefused = /synchronous/.test(e.message); }
ok(asyncRefused, "async fn inside withPublicWorkClaimWriter is refused");

// entry guard: permit already open -> refuse
pdb.prepare("UPDATE public_work_claim_writer_permit SET enabled=1 WHERE singleton=1").run();
let entryRefused = false;
try { pub.withPublicWorkClaimWriter(store, () => {}); } catch (e) { entryRefused = /closed before entry/.test(e.message); }
ok(entryRefused, "withPublicWorkClaimWriter refuses entry when permit already open");
pdb.prepare("UPDATE public_work_claim_writer_permit SET enabled=0 WHERE singleton=1").run();
pdb.close();

console.log(`DONE t2-fences (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
