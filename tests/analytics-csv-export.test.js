// G011: analytics CSV export. Pure exporter tests.
import test from "node:test";
import assert from "node:assert/strict";
import { escapeField, toCsv, ExportError } from "../server/csv-export.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ExportError && error.code === code);

test("escapeField quotes per RFC 4180", () => {
  assert.equal(escapeField("plain"), "plain");
  assert.equal(escapeField("a,b"), '"a,b"');
  assert.equal(escapeField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeField("line1\nline2"), '"line1\nline2"');
  assert.equal(escapeField(null), "");
  assert.equal(escapeField(42), "42");
});
test("toCsv exports header and rows", () => {
  const csv = toCsv({ columns: [{ key: "name", header: "Name" }, { key: "count", header: "Count" }],
    rows: [{ name: "Ada", count: 3 }, { name: "Bob, Jr.", count: 1 }] });
  assert.equal(csv, 'Name,Count\r\nAda,3\r\n"Bob, Jr.",1\r\n');
});
test("malformed inputs are refused", () => {
  throwsCode(() => toCsv({ columns: [], rows: [] }), "invalid_export");
  throwsCode(() => toCsv({ columns: [{ key: "", header: "H" }], rows: [] }), "invalid_export");
  throwsCode(() => toCsv({ columns: [{ key: "k", header: "H" }], rows: [null] }), "invalid_export");
});
