// CI gate: the store schema number has exactly one source,
// STORE_SCHEMA_VERSION in server/writer-fence.mjs. Everything else that
// states the number (the README status line, the docs/CURRENT-ROOM.md map,
// the docs/SERVICE.md status sentence and storage bullet,
// the writer function name, the fenced version list) must agree with it.
// The map once said 26 while the store was on 27; this fails that drift.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { STORE_SCHEMA_VERSION, WRITER_FUNCTION, writerVersions } from "../server/writer-fence.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = path => readFileSync(join(root, path), "utf8");
const failures = [];
const expect = (what, actual) => {
  if (actual !== STORE_SCHEMA_VERSION) failures.push(`${what} says ${actual ?? "nothing"}, STORE_SCHEMA_VERSION is ${STORE_SCHEMA_VERSION}`);
};
const stated = (path, pattern) => {
  const match = pattern.exec(read(path));
  return match ? Number(match[1]) : undefined;
};

expect("README.md status line (\"Schema N.\")", stated("README.md", /^Live app: .*\bSchema (\d+)\.$/m));
expect("docs/CURRENT-ROOM.md map row (\"| Schema | N |\")", stated("docs/CURRENT-ROOM.md", /^\| Schema \| (\d+) \|$/m));
expect("docs/SERVICE.md status sentence (\"Current schema is N\")", stated("docs/SERVICE.md", /\bCurrent schema is (\d+)\b/));
expect("docs/SERVICE.md storage bullet (\"schema version N\")", stated("docs/SERVICE.md", /^- SQLite WAL, .*\bschema version (\d+)\b/m));
expect("server/writer-fence.mjs WRITER_FUNCTION suffix", Number(/_v(\d+)$/.exec(WRITER_FUNCTION)?.[1]));
expect("server/writer-fence.mjs writerVersions last entry", writerVersions.at(-1));

// The number must not be redefined anywhere else in the service.
for (const path of ["server/store.mjs", "server/recovery.mjs", "cloudflare/storage.mjs"]) {
  const redefined = /\bSTORE_SCHEMA_VERSION\s*=\s*\d+/.exec(read(path));
  if (redefined) failures.push(`${path} redefines STORE_SCHEMA_VERSION (${redefined[0]}); import it from server/writer-fence.mjs instead`);
}

if (failures.length) {
  console.error("Schema version drift:\n" + failures.map(f => `  ${f}`).join("\n"));
  process.exit(1);
}
console.log(`Schema version ${STORE_SCHEMA_VERSION} is stated consistently.`);
