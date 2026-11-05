// Unaddressed room-authority lint (ratchet).
// store.roomAuthority(roomId) with no {memberId} loads the FULL member census
// (record + witness receipt per member) inside the shared 200-record/256KiB
// current read budget, so request paths that call it 409 with
// current_room_context_unavailable once a room has ~20+ members (and refuse
// outright past 100). Use instead:
//   - store.headSequence(roomId)            for the sequence
//   - store.roomOwnerId(roomId)             for the owner id
//   - store.roomAuthority(roomId,{memberId}) for owner + one member
// BASELINE is the per-file count of existing unaddressed calls, captured
// 2026-11-04. It may only shrink: a file above its count fails (new call), a
// file below it fails until the baseline is lowered. Run:
//   node scripts/room-authority-lint.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CALL = /\b(?:roomAuthority\(\s*[\w.$]+\s*\)|currentRoomAuthority\(\s*[\w.$]+\s*,\s*[\w.$]+\s*\))/g;

export function countUnaddressed(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(line => line.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
  return (code.match(CALL) ?? []).length;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

export function scan(serverDir = join(root, "server")) {
  const counts = {};
  for (const file of walk(serverDir)) {
    const n = countUnaddressed(readFileSync(file, "utf8"));
    if (n) counts[relative(serverDir, file).split(sep).join("/")] = n;
  }
  return counts;
}

export const BASELINE = Object.freeze(JSON.parse(readFileSync(join(root, "scripts/room-authority-baseline.json"), "utf8")));

export function problems(counts = scan(), baseline = BASELINE) {
  const out = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (n > allowed) out.push(`${file}: ${n} unaddressed roomAuthority() call(s), baseline ${allowed}. Use headSequence(), roomOwnerId() or roomAuthority(roomId,{memberId}).`);
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const n = counts[file] ?? 0;
    if (n < allowed) out.push(`${file}: baseline ${allowed} but only ${n} call(s) remain; lower scripts/room-authority-baseline.json to ${n || "remove the entry"}.`);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--print")) { console.log(JSON.stringify(scan(), null, 2)); process.exit(0); }
  const found = problems();
  if (found.length) { console.error("Unaddressed room authority (full member census) on request paths:\n  " + found.join("\n  ")); process.exit(1); }
  const total = Object.values(BASELINE).reduce((a, b) => a + b, 0);
  console.log(`ok - no new unaddressed roomAuthority() calls (${total} grandfathered across ${Object.keys(BASELINE).length} files; the list only shrinks)`);
}
