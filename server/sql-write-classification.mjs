// Over-counting is harmless (an extra alarm re-arm); missing a write is not.
// So the rule is an allowlist of reads: after leading comments, one SELECT, or
// one WITH ... SELECT with no write keyword anywhere. Everything else counts as
// a write: INSERT/UPDATE/DELETE/REPLACE, WITH ... INSERT, PRAGMA, DDL, a write
// behind a leading comment, and any multi-statement exec ("SELECT 1; DELETE").
// A ";" inside a string literal also counts as multi-statement (over-count).
const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const WRITE_WORD = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
function readOnlySql(text) {
  const body = text.replace(LEADING_COMMENTS, "").replace(/[\s;]+$/, "");
  if (body.includes(";")) return false;
  if (/^SELECT\b/i.test(body)) return true;
  return /^WITH\b/i.test(body) && !WRITE_WORD.test(body);
}
const writeSqlCache = new Map();
export function isWriteSql(sql) {
  let hit = writeSqlCache.get(sql);
  if (hit === undefined) {
    hit = !readOnlySql(String(sql));
    if (writeSqlCache.size < 4096) writeSqlCache.set(sql, hit);
  }
  return hit;
}

