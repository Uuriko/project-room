import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { verifyRestoreControl, RESTORE_CONTROL_GUARDS } from "../server/restore-admission.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  verifyRestoreControl(store.db);
  return store;
}

test("restore admission rechecks exact definitions after VACUUM relocates schema entries", t => {
  const store = fixture(t);
  const before = store.db.prepare("SELECT rowid,name,sql FROM sqlite_master WHERE name LIKE 'current_restore_%' ORDER BY name").all();
  store.db.exec("VACUUM");
  const after = store.db.prepare("SELECT rowid,name,sql FROM sqlite_master WHERE name LIKE 'current_restore_%' ORDER BY name").all();
  assert.deepEqual(after.map(({ name, sql }) => ({ name, sql })), before.map(({ name, sql }) => ({ name, sql })));
  assert.notDeepEqual(after.map(r => r.rowid), before.map(r => r.rowid), "fixture must actually relocate catalog entries");
  assert.doesNotThrow(() => verifyRestoreControl(store.db));
  assert.doesNotThrow(() => verifyRestoreControl(store.db), "new cache remains usable");
});

for (const mutation of ["missing", "changed", "substituted"]) {
  test(`restore admission still refuses ${mutation} guard after catalog relocation`, t => {
    const store = fixture(t);
    const [name, sql] = RESTORE_CONTROL_GUARDS[0];
    store.db.exec("DROP TRIGGER " + name);
    if (mutation === "changed") store.db.exec(sql.replace("unsupported restore admission mutation", "altered admission mutation"));
    if (mutation === "substituted") store.db.exec(sql.replace(name, "unrelated_restore_guard"));
    store.db.exec("VACUUM");
    assert.throws(() => verifyRestoreControl(store.db), /schema requires reconciliation/);
    assert.throws(() => verifyRestoreControl(store.db), /schema requires reconciliation/, "cold lookup also refuses");
  });
}
