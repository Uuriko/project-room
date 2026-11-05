import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork, claimWork, delegateWork, requestApproval, updateWork } from "../server/work-claims.mjs";
import { fenceDefinitions, STORE_SCHEMA_VERSION } from "../server/writer-fence.mjs";

import { applyPlanning } from "../server/board-planning.mjs";

const baseline = "2075f27e897c9843048012559f457bf11607d884";
async function oldRegistryModule() {
  let source = execFileSync("git", ["show", `${baseline}:server/work-claim-sqlite.mjs`], { encoding: "utf8" });
  source = source.replaceAll('"./work-claims.mjs"', JSON.stringify(pathToFileURL(resolve("server/work-claims.mjs")).href))
    .replaceAll('"./persisted-row.mjs"', JSON.stringify(pathToFileURL(resolve("server/persisted-row.mjs")).href));
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

test("v45 open claim writer is fenced after upgrade, without losing accounts or claim fields", async t => {
  const directory = mkdtempSync(join(tmpdir(), "claim-writer-upgrade-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "room.sqlite");
  let current = new RoomStore(filename);
  current.initialize(initialRoom("commons"));
  current.createAccount("preserved-account");
  const identity = current.identities.create("Preserved identity");
  let work = claimWork(createWork({ id: "safe", title: "Synthetic" }, { agentId: "owner" }), "owner");
  current.workClaims.set("commons", work);
  // Synthetic prior-version fixture only. Production never downgrades markers.
  for (const { name } of fenceDefinitions(STORE_SCHEMA_VERSION)) current.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  for (const { sql } of fenceDefinitions(45)) current.db.exec(sql);
  current.db.exec("PRAGMA user_version=45; DELETE FROM room_schema_stamp");
  current.close();
  const earlier = new DatabaseSync(filename);
  for (let v = 6; v <= 45; v++) earlier.function(`project_room_writer_v${v}`, () => v);
  const { createDurableWorkClaimRegistry } = await oldRegistryModule();
  const old = createDurableWorkClaimRegistry(earlier);
  old.set("commons", old.get("commons", "safe"));
  current = new RoomStore(filename);
  try {
    work = requestApproval(delegateWork(current.workClaims.get("commons", "safe"), "owner", "worker"), "owner", { approverId: "boss", step: "Synthetic approval" });
    work = applyPlanning(work, { priority: 2, projectId: "kept-project", initiativeId: "kept-initiative" });
    current.workClaims.set("commons", work);
    current.workClaims.set("commons", updateWork(current.workClaims.get("commons", "safe"), "owner", { note: "Compatible ordinary note" }));
    const account = current.account("preserved-account");
    const before = current.db.prepare("SELECT item_json FROM work_claims WHERE claim_id='safe'").get().item_json;
    const stale = old.get("commons", "safe");
    assert.equal(stale.delegate, undefined, "exact prior decoder drops new authority fields");
    assert.throws(() => old.set("commons", stale), /no such function: project_room_writer_v46|unsupported database writer/);
    assert.equal(current.db.prepare("SELECT item_json FROM work_claims WHERE claim_id='safe'").get().item_json, before);
    assert.deepEqual(current.account("preserved-account"), account);
    assert.equal(current.identities.resolveGlobalIdentitySecret(identity.secret).identityId, identity.identityId);
    assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
  } finally { current.close(); earlier.close(); }
  const reopened = new RoomStore(filename);
  try {
    const saved = reopened.workClaims.get("commons", "safe");
    assert.equal(saved.delegate, "worker");
    assert.equal(saved.approvalHold.status, "pending");
    assert.deepEqual(saved.planning, { priority: 2, projectId: "kept-project", initiativeId: "kept-initiative" });
    assert.equal(reopened.account("preserved-account").active, true);
    assert.equal(reopened.identities.resolveGlobalIdentitySecret(identity.secret).identityId, identity.identityId);
  } finally { reopened.close(); }
});
