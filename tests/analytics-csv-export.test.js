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
test("escapeField neutralizes leading spreadsheet formula characters", () => {
  // CSV formula injection: a leading =, +, - or @ makes spreadsheet apps
  // execute the cell as a formula when the export is opened. Prefixing a
  // single quote forces the cell to be treated as text.
  assert.equal(escapeField("=2+5"), "'=2+5");
  assert.equal(escapeField("+2+5"), "'+2+5");
  assert.equal(escapeField("-2+5"), "'-2+5");
  assert.equal(escapeField("@SUM(1+1)"), "'@SUM(1+1)");
  // Formula characters after leading whitespace/tab are still live.
  assert.equal(escapeField(" =2+5"), "' =2+5");
  assert.equal(escapeField("\t@SUM(1+1)"), "'\t@SUM(1+1)");
  // Neutralization happens before RFC 4180 quoting, so a formula that also
  // contains a comma is both prefixed and quoted.
  assert.equal(escapeField("=SUM(1,2)"), "\"'=SUM(1,2)\"");
  // Genuine numbers are not text fields and are left untouched.
  assert.equal(escapeField(-42), "-42");
  // A formula character that is not at the start is harmless.
  assert.equal(escapeField("a=b"), "a=b");
});
test("toCsv neutralizes formula injection in user-controlled fields", () => {
  const csv = toCsv({ columns: [{ key: "to", header: "To" }, { key: "subject", header: "Subject" }],
    rows: [{ to: "@SUM(1+1)", subject: "=2+5" }, { to: "ada@example.test", subject: "hello" }] });
  assert.equal(csv, "To,Subject\r\n'@SUM(1+1),'=2+5\r\nada@example.test,hello\r\n");
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
