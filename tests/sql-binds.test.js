import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sqlChunks, sqlPlaceholders } from "../server/sql-binds.mjs";

test("chunked SQL list queries retain tenant filtering and results within the Worker bind budget", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE rows_to_find (room_id TEXT, id TEXT, visible INTEGER)");
  const insert = db.prepare("INSERT INTO rows_to_find VALUES (?, ?, ?)");
  const ids = Array.from({ length: 511 }, (_, i) => `id-${i}' OR 1=1 --`);
  for (let i = 0; i < ids.length; i++) {
    insert.run("wanted", ids[i], i % 2);
    insert.run("other-room", ids[i], 1);
  }
  // The unchunked Node query is the reference; Worker SQL rejects it once
  // the list plus fixed room/visibility binds exceeds 100. User values must
  // remain bound parameters, including quote-containing ids.
  for (const size of [0, 1, 99, 100, 101, 511]) {
    const wanted = ids.slice(0, size).reverse();
    const original = [...wanted];
    const query = values => `SELECT id FROM rows_to_find WHERE room_id=? AND visible=? AND id IN (${sqlPlaceholders(values)})`;
    const expected = db.prepare(query(wanted)).all("wanted", 1, ...wanted).map(row => row.id).sort();
    const actual = [];
    for (const chunk of sqlChunks(wanted)) {
      const binds = ["wanted", 1, ...chunk];
      assert.ok(binds.length <= 100, "fixed arguments and list share the Worker SQL budget");
      actual.push(...db.prepare(query(chunk)).all(...binds).map(row => row.id));
    }
    assert.deepEqual(actual.sort(), expected, `SQL results at list size ${size}`);
    assert.deepEqual(wanted, original, "query planning does not change caller order");
  }
});
