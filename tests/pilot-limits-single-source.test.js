// G11 guard (John's Tab, 2026-10-06): one source for room capacity.
// The event cap (10000) and the projection cap (4 MiB) were copied as literals
// beside PILOT_LIMITS into access requests, referrals, share links, guest and
// agent invites, so raising PILOT_LIMITS left those paths refusing at the old
// numbers. This walks every module under server/ and cloudflare/ (recursively)
// and fails if a cap is hard-coded again.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PILOT_LIMITS } from "../server/store.mjs";
import { DurableDatabase, isTooBig } from "../cloudflare/storage.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  if (name === "node_modules") return [];
  return statSync(path).isDirectory() ? walk(path) : /\.(mjs|js)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
});
const modules = [...walk(join(root, "server")), ...walk(join(root, "cloudflare"))];
const scan = predicate => modules.flatMap(path => readFileSync(path, "utf8").split("\n")
  .map((line, i) => predicate(line) ? `${path.slice(root.length)}:${i + 1}` : null).filter(Boolean));

test("the walk covers the write paths it guards", () => {
  for (const name of ["store.mjs", "access-requests.mjs", "referrals.mjs", "share-links.mjs", "guest-invites.mjs", "agent-invites.mjs", "referral-invites.mjs", "storage.mjs"]) {
    assert.ok(modules.some(path => path.endsWith(`/${name}`)), name);
  }
});

test("no module hard-codes the room event cap", () => {
  assert.deepEqual(scan(line => /sequence\s*(\+\s*1\s*)?>=?\s*\d{4,}/.test(line) || /MAX_ROOM_EVENTS\s*=\s*\d/.test(line)), []);
});

test("no module hard-codes the room projection cap", () => {
  const literal = /(\d+\s*\*\s*1024\s*\*\s*1024|\b\d{7,}\b|\d+\s*<<\s*20)/;
  assert.deepEqual(scan(line =>
    /MAX_PROJECTION_BYTES\s*=/.test(line)
    || (/byteLength\(\s*projection/.test(line) && />\s*/.test(line) && !/PILOT_LIMITS\.projectionBytes/.test(line))
    || (/projection(?!\s*\()/i.test(line) && literal.test(line) && !/CACHE|PILOT_LIMITS\s*=|^\s*\/\//.test(line))), []);
});

test("the raised limits hold: events 1,000,000 and projection 4 MiB (64 MiB reverted 2026-10-07 per the owner brief: the platform row ceiling sits below it, so the app guard stays at 4 MiB and ROOM_BODIES_AT_REST=1 is the headroom path)", () => {
  assert.equal(PILOT_LIMITS.eventsPerRoom, 1_000_000);
  assert.equal(PILOT_LIMITS.projectionBytes, 4 * 1024 * 1024);
});

test("a platform SQLITE_TOOBIG refusal surfaces as a typed 409, not a 500", () => {
  const storage = { sql: { exec() { throw new Error("string or blob too big: SQLITE_TOOBIG"); } } };
  const db = new DurableDatabase(storage);
  db.isTransaction = true; // already inside the room's write transaction
  assert.throws(() => db.prepare("UPDATE rooms SET projection=? WHERE id=?").run("x", "r"), { status: 409, code: "pilot_limit" });
  assert.throws(() => db.exec("SELECT 1"), { status: 409, code: "pilot_limit" });
  const other = new DurableDatabase({ sql: { exec() { throw new Error("no such table: rooms"); } } });
  other.isTransaction = true;
  assert.throws(() => other.prepare("SELECT 1").all(), /no such table/);
  assert.equal(isTooBig(new Error("disk I/O error")), false);
});
