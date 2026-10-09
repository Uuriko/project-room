// RH-03: public-work-claim-fence permit discipline (in-process).
// (a) sequential entries leave the permit closed at rest; (b) nested entry
// is refused; (c) a throwing fn still closes the permit; (d) the SQL trigger
// fence blocks unpermitted writes to protected namespaces and allows
// permitted ones.
import { DatabaseSync } from "node:sqlite";
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const {
  publicWorkClaimFenceSchema, withPublicWorkClaimWriter, verifyPublicWorkClaimFence,
} = await import(REPO + "/server/public-work-claim-fence.mjs");

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE work_claims(room_id TEXT, claim_id TEXT)");
db.exec("CREATE TABLE work_claim_config(room_id TEXT)");
db.exec("CREATE TABLE public_work_tasks(namespace_key TEXT)");
db.exec(publicWorkClaimFenceSchema);
db.exec("INSERT INTO public_work_tasks(namespace_key) VALUES('room-pub')");

const store = {
  db,
  now: () => Date.now(),
  transaction(fn) {
    // match production store.transaction nesting: a nested call runs inside
    // the parent transaction (no SAVEPOINT for the non-isolated path)
    if (db.isTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  },
};
const permit = () => db.prepare("SELECT enabled FROM public_work_claim_writer_permit WHERE singleton=1").get().enabled;
let failures = 0;
const check = (name, cond) => { console.log(`${cond ? "ok" : "FAIL"} - ${name}`); if (!cond) failures++; };

// (a) sequential
check("sequential entry returns value", withPublicWorkClaimWriter(store, () => 42) === 42);
check("permit closed at rest after sequential", permit() === 0);
check("fence verifies at rest", verifyPublicWorkClaimFence(db) === true);
// (b) nested refused
let nestedErr = null;
withPublicWorkClaimWriter(store, () => {
  try { withPublicWorkClaimWriter(store, () => {}); } catch (e) { nestedErr = e; }
});
check("nested entry refused", /must be closed before entry/.test(nestedErr?.message ?? ""));
check("permit closed after nested attempt", permit() === 0);
// (c) throwing fn resets permit
let threw = null;
try { withPublicWorkClaimWriter(store, () => { throw new Error("boom"); }); } catch (e) { threw = e; }
check("throwing fn propagates", threw?.message === "boom");
check("permit closed after throw", permit() === 0);
// (d) trigger fence: unpermitted write to a protected namespace aborts
let fenceErr = null;
try { db.prepare("INSERT INTO work_claims(room_id,claim_id) VALUES('room-pub','c1')").run(); }
catch (e) { fenceErr = e; }
check("unpermitted protected write aborts", /unsupported public claim writer/.test(fenceErr?.message ?? ""));
// unprotected namespace passes without permit
db.prepare("INSERT INTO work_claims(room_id,claim_id) VALUES('room-priv','c9')").run();
check("unprotected write passes without permit", true);
// permitted write passes
withPublicWorkClaimWriter(store, () => {
  db.prepare("INSERT INTO work_claims(room_id,claim_id) VALUES('room-pub','c2')").run();
});
check("permitted protected write passes", db.prepare("SELECT COUNT(*) n FROM work_claims WHERE claim_id='c2'").get().n === 1);
check("permit closed at end", permit() === 0 && verifyPublicWorkClaimFence(db) === true);

console.log(failures === 0 ? "RH-03 RESULT: PASS" : `RH-03 RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 2);
