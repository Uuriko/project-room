// True when sqlite_master has a table with this name. The name is bound,
// so a value that looks like SQL cannot change the query. A closed or
// broken database handle throws; callers that must treat that as "missing"
// catch it themselves.
export function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
