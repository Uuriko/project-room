import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { frozenRecoveryFixture, v8ConnectionBaseline } from "../scripts/frozen-runtime-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { AgentConnections } from "../server/agent-connections.mjs";
import { auditRecovery } from "../server/recovery.mjs";

test("genuine v8 data upgrades atomically; cached and reopened old writers cannot write v9", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-agent-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v8");
  createRuntimePackage({ repository, commit: v8ConnectionBaseline, destination });
  const createFixture = await frozenRecoveryFixture(repository, destination), f = createFixture(join(root, "room.sqlite"));
  t.after(() => f.store.close());
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const { auditRecovery: oldAudit } = await import(pathToFileURL(join(destination, "server/recovery.mjs")));
  const before = oldAudit(f.store), catalog = () => f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  const oldCatalog = catalog(), cached = f.store.db.prepare("UPDATE accounts SET revision=revision WHERE id=?");
  assert.equal(cached.run(f.owner.session.account.id).changes, 1);
  const verify = AgentConnections.prototype.verifyHistory;
  AgentConnections.prototype.verifyHistory = () => { throw new Error("synthetic final failure"); };
  try { assert.throws(() => new RoomStore(f.filename), { code: "connection_integrity_error" }); }
  finally { AgentConnections.prototype.verifyHistory = verify; }
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 8);
  assert.deepEqual(catalog(), oldCatalog); assert.deepEqual(oldAudit(f.store), before);
  assert.equal(cached.run(f.owner.session.account.id).changes, 1);
  const current = new RoomStore(f.filename, { now: f.now }); t.after(() => current.close());
  assert.deepEqual(auditRecovery(current).tables.filter(row => !row.table.startsWith("agent_connection")), before.tables);
  assert.equal(current.authenticate(f.keys.agent).member.id, "agent");
  assert.throws(() => cached.run(f.owner.session.account.id), /project_room_writer_v9|unsupported database writer/);
  assert.throws(() => new OldStore(f.filename), /newer than this service/);
  current.createAccount("after-v9-upgrade");
  assert.equal(current.account("after-v9-upgrade").active, true);
  assert.equal(auditRecovery(current).schemaVersion, 9);
});
