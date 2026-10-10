import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Linter } from "eslint";
import roomRules, { isTransactionSql } from "../scripts/eslint-rules/no-raw-transaction.mjs";
import { RAW_TRANSACTION_EXEMPT } from "../eslint.config.mjs";

const config = [{ files: ["**/*.mjs"], languageOptions: { ecmaVersion: "latest", sourceType: "module" }, plugins: { room: roomRules }, rules: { "room/no-raw-transaction": "error" } }];
const lint = code => new Linter().verify(code, config, { filename: "server/x.mjs" }).map(m => m.ruleId === "room/no-raw-transaction" ? m.line : m.message);

test("flags hand-written transaction control statements", () => {
  assert.deepEqual(lint('db.exec("BEGIN");'), [1]);
  assert.deepEqual(lint("db.exec('BEGIN IMMEDIATE');\nsql.exec(`COMMIT`);"), [1, 2]);
  assert.deepEqual(lint('this.db.prepare("ROLLBACK").run();'), [1]);
  assert.deepEqual(lint('db.exec("SAVEPOINT s1"); db.exec("RELEASE s1"); db.exec("ROLLBACK TO s1");'), [1, 1, 1]);
  assert.deepEqual(lint('db.exec("  begin exclusive transaction; ");'), [1]);
});

test("does not flag triggers, other SQL, dynamic SQL or the helper", () => {
  assert.deepEqual(lint('db.exec("CREATE TRIGGER t BEFORE UPDATE ON x BEGIN SELECT RAISE(ABORT,\'no\'); END");'), []);
  assert.deepEqual(lint('db.exec("PRAGMA foreign_keys=ON"); db.prepare("SELECT 1").get();'), []);
  assert.deepEqual(lint("db.exec(`BEGIN ${mode}`); db.exec(sql);"), []);
  assert.deepEqual(lint("store.transaction(() => db.prepare(\"INSERT INTO t VALUES (1)\").run());"), []);
  assert.equal(isTransactionSql("BEGIN SELECT 1; END"), false);
  assert.equal(isTransactionSql("END TRANSACTION"), true);
});

test("every exempt file still needs its exemption", () => {
  // A stale entry would hide new raw transactions. Remove it when the file moves to store.transaction(fn).
  assert.ok(RAW_TRANSACTION_EXEMPT.length <= 2, "do not grow the exemption list; use store.transaction(fn)");
  for (const file of RAW_TRANSACTION_EXEMPT) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const hits = new Linter().verify(src, config, { filename: file }).filter(m => m.ruleId === "room/no-raw-transaction");
    assert.ok(hits.length > 0, `${file} no longer has raw transactions; remove it from RAW_TRANSACTION_EXEMPT`);
  }
});
