// Analytics export (G011). A pure CSV exporter: take rows (objects) and
// column definitions, emit RFC 4180 CSV text with proper quoting. The
// module is pure and dependency-free. Malformed inputs throw ExportError.
// HTTP download wiring is a later slice.
class ExportError extends Error { constructor(code, message) { super(message); this.name = "ExportError"; this.code = code; } }
const fail = (code, message) => { throw new ExportError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_export", message); };
const checkColumns = columns => {
  check(Array.isArray(columns) && columns.length > 0, "columns must be a non-empty array");
  check(columns.every(c => c !== null && typeof c === "object" &&
    typeof c.key === "string" && c.key.length > 0 &&
    typeof c.header === "string" && c.header.length > 0),
    "every column must have a non-empty key and header");
};
// Escape a single CSV field per RFC 4180.
export function escapeField(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
// Export rows to CSV. columns is [{ key, header }]; rows is an array of objects.
export function toCsv({ columns, rows }) {
  checkColumns(columns);
  check(Array.isArray(rows), "rows must be an array");
  const headerLine = columns.map(c => escapeField(c.header)).join(",");
  const lines = rows.map(row => {
    check(row !== null && typeof row === "object", "every row must be an object");
    return columns.map(c => escapeField(row[c.key])).join(",");
  });
  return [headerLine, ...lines].join("\r\n") + "\r\n";
}
// Structured JSON audit export. The same column definitions drive both shapes:
// rows are projected to exactly the column keys (never the raw record), so a
// JSON export carries the same fields as its CSV twin — no more, no less.
export function toJsonExport({ name, generatedAt, columns, rows }) {
  check(typeof name === "string" && name.length > 0, "name must be a non-empty string");
  check(typeof generatedAt === "string" && generatedAt.length > 0, "generatedAt must be a non-empty string");
  checkColumns(columns);
  check(Array.isArray(rows), "rows must be an array");
  const safeRows = rows.map(row => {
    check(row !== null && typeof row === "object", "every row must be an object");
    const projected = {};
    for (const c of columns) projected[c.key] = row[c.key] ?? null;
    return projected;
  });
  return JSON.stringify({
    export: name, generatedAt,
    columns: columns.map(c => ({ key: c.key, header: c.header })),
    count: safeRows.length, rows: safeRows
  }, null, 2) + "\n";
}
export { ExportError };
