// T4: work-claim-sqlite configure() / delete() check-then-act across connections.
// Demonstrates the module-level hazard: configure() reads the config row,
// merges in JS, and upserts — two concurrent connections interleave the
// read-modify-write and one side's keys are silently lost. Same shape in
// delete()'s dependent-waiving loop (read dependents, upsert each, delete).
// NOTE: in the live server every route call is wrapped in store.transaction
// (BEGIN IMMEDIATE), so this needs two store instances on one DB file to
// bite — currently excluded by instance-lock. Ranked as a latent
// defense-in-depth note, not a live bug.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WT = dirname(dirname(fileURLToPath(import.meta.url)));
const { createDurableWorkClaimRegistry, workClaimSchema } = await import(join(WT, "server/work-claim-sqlite.mjs"));

const f = join(mkdtempSync(join(tmpdir(), "g20-reg-")), "r.db");
const mk = () => {
  const db = new DatabaseSync(f);
  db.exec(workClaimSchema);
  // raw (non-transactional) registry, like a second store instance would hold
  return { db, reg: createDurableWorkClaimRegistry(db) };
};
const a = mk(), b = mk();

let pass = 0, fail = 0;
const ok = (c, n) => { console.log((c ? "PASS" : "FAIL") + ": " + n); c ? pass++ : fail++; };

// configure() lost update: A sets {x:1}, B sets {y:2} "concurrently".
// Simulate the interleave the code permits: both read first, then both write.
a.reg.configure("room1", { maxOpenClaims: 50 });
const readA = a.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id=?").get("room1").config_json;
const readB = b.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id=?").get("room1").config_json;
// emulate A's JS-merge + upsert
a.db.prepare("INSERT INTO work_claim_config(room_id,config_json,updated_at) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at")
  .run("room1", JSON.stringify({ ...JSON.parse(readA), maxMemberOpenClaims: 7 }), Date.now());
// emulate B's JS-merge + upsert on its stale read
b.db.prepare("INSERT INTO work_claim_config(room_id,config_json,updated_at) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at")
  .run("room1", JSON.stringify({ ...JSON.parse(readB), defaultLeaseHours: 12 }), Date.now());
const final = JSON.parse(a.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id=?").get("room1").config_json);
const lost = !("maxMemberOpenClaims" in final) || !("defaultLeaseHours" in final);
ok(lost, `configure() read-modify-write loses a concurrent key (final=${JSON.stringify(final)}) — latent hazard, needs 2 store instances`);

// delete() dependent-waiving lost update: D depends on X and Y; two
// connections delete X and Y "concurrently" -> one waiver is lost.
const item = (id, dependsOn) => ({ id, title: id, state: "unclaimed", owner: null, history: [], dependsOn });
a.reg.set("room2", item("X", []));
a.reg.set("room2", item("Y", []));
a.reg.set("room2", item("D", ["X", "Y"]));
// connection A deletes X: reads D(dependsOn [X,Y]) ... connection B deletes Y: reads D([X,Y])
const dForA = a.reg.get("room2", "D");
const dForB = b.reg.get("room2", "D");
// A waives X -> upserts D([Y]); B waives Y on its stale read -> upserts D([X])
a.db.prepare("UPDATE work_claims SET item_json=? WHERE room_id=? AND claim_id=?")
  .run(JSON.stringify({ ...dForA, dependsOn: ["Y"] }), "room2", "D");
b.db.prepare("UPDATE work_claims SET item_json=? WHERE room_id=? AND claim_id=?")
  .run(JSON.stringify({ ...dForB, dependsOn: ["X"] }), "room2", "D");
a.db.prepare("DELETE FROM work_claims WHERE room_id=? AND claim_id=?").run("room2", "X");
b.db.prepare("DELETE FROM work_claims WHERE room_id=? AND claim_id=?").run("room2", "Y");
const dFinal = a.reg.get("room2", "D");
const stranded = dFinal && dFinal.dependsOn.some(d => d === "X" || d === "Y");
ok(!!stranded, `delete() dependent-waiving loses a concurrent waiver (D.dependsOn=${JSON.stringify(dFinal?.dependsOn)}) — latent hazard, needs 2 store instances`);
a.db.close(); b.db.close();

console.log(`DONE t4-registry-rmw (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
