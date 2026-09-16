// Schema migration framework (H001). A pure, ordered migration runner:
// migrations are { version, name, checksum, up, down }. The runner verifies
// ordering (strictly increasing versions), verifies checksums against a
// journal of applied migrations (tamper detection), applies pending ups in
// order, and records each application in the journal. Rollback runs the
// down of the latest applied migration. The journal is caller-supplied (an
// array the caller persists); the runner itself performs no store writes.
// Pure, dependency-free, deterministic; frozen outputs. Wiring the journal
// to the real store is a later slice.
import { createHash } from "node:crypto";
class MigrationError extends Error { constructor(code, message) { super(message); this.name = "MigrationError"; this.code = code; } }
const fail = (code, message) => { throw new MigrationError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_migration", message); };

export const checksumOf = source => createHash("sha256").update(source, "utf8").digest("hex");
const migrationOf = (value, index) => {
  check(value !== null && typeof value === "object", `migration ${index} must be an object`);
  check(Number.isInteger(value.version) && value.version > 0, `migration ${index} needs a positive integer version`);
  check(typeof value.name === "string" && value.name.length > 0, `migration ${index} needs a name`);
  check(typeof value.checksum === "string" && value.checksum.length === 64, `migration ${index} needs a sha256 checksum`);
  check(typeof value.up === "function", `migration ${index} needs an up function`);
  if (value.down !== undefined) check(typeof value.down === "function", `migration ${index} down must be a function`);
  return value;
};
// Verify ordering and checksum integrity. Returns the sorted list.
export function verifyMigrations(migrations, journal) {
  check(Array.isArray(migrations), "migrations must be a list");
  const sorted = migrations.map(migrationOf).sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    check(sorted[i].version > sorted[i - 1].version, `duplicate or out-of-order version ${sorted[i].version}`);
  }
  const applied = new Map((journal ?? []).map(entry => [entry.version, entry]));
  for (const migration of sorted) {
    const entry = applied.get(migration.version);
    if (entry) {
      check(entry.checksum === migration.checksum,
        `checksum mismatch for applied migration v${migration.version} "${migration.name}": journal may have been tampered with or the migration edited after apply`);
    }
  }
  return Object.freeze(sorted);
}
// Apply pending migrations in order. journal is a caller-owned array that
// the caller persists; state is a caller-supplied object passed to up().
export function migrate(migrations, journal, state) {
  check(Array.isArray(journal), "journal must be a caller-owned array");
  const sorted = verifyMigrations(migrations, journal);
  const appliedVersions = new Set(journal.map(entry => entry.version));
  const appliedNow = [];
  for (const migration of sorted) {
    if (appliedVersions.has(migration.version)) continue;
    migration.up(state ?? {});
    const entry = Object.freeze({ version: migration.version, name: migration.name,
      checksum: migration.checksum, appliedAt: new Date().toISOString() });
    journal.push(entry);
    appliedNow.push(entry);
  }
  return Object.freeze({ applied: Object.freeze(appliedNow),
    journal: Object.freeze(journal.map(entry => Object.freeze({ ...entry }))) });
}
// Roll back the latest applied migration (runs its down).
export function rollback(migrations, journal, state) {
  check(Array.isArray(journal) && journal.length > 0, "nothing to roll back");
  const sorted = verifyMigrations(migrations, journal);
  const latest = journal[journal.length - 1];
  const migration = sorted.find(m => m.version === latest.version);
  check(migration, `journal references unknown migration v${latest.version}`);
  check(typeof migration.down === "function", `migration v${migration.version} "${migration.name}" has no down step`);
  migration.down(state ?? {});
  journal.pop();
  return Object.freeze({ rolledBack: latest.version, name: migration.name });
}
export { MigrationError };
