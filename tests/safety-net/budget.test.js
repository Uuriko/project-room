// Room-page byte budget and full-snapshot time budget.
// Baseline measured from index.html plus the static and dynamic relative
// import closure of src/entry.js: 1702823 bytes. The limit is 10% above that.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { initialRoom } from "../../server/bootstrap.mjs";
import { startSafetyNet } from "./harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOM_PAGE_BASELINE_BYTES = 1702823;
const ROOM_PAGE_BYTE_LIMIT = 1873106;
const API_BUDGET_MS = 1000;
const SEEDED_MESSAGES = 1000;

const IMPORT_RE = /(?:import\s+(?:[^"']*?\s+from\s+)?|export\s+(?:[^"']*?\s+from\s+)?|import\s*\(\s*)(["'])(\.[^"']+)\1/g;

function relativeSpecs(source) {
  const specs = [];
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) specs.push(match[2]);
  return specs;
}

export function roomPageBytes(root = ROOT) {
  const seen = new Set();
  const queue = ["src/entry.js"];
  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    seen.add(rel);
    const source = readFileSync(abs, "utf8");
    const dir = dirname(rel);
    for (const spec of relativeSpecs(source)) {
      let resolved = normalize(join(dir, spec)).split(sep).join("/");
      if (!/\.(?:mjs|js|cjs)$/.test(resolved)) {
        if (existsSync(join(root, `${resolved}.js`))) resolved = `${resolved}.js`;
        else continue;
      }
      if (resolved === ".." || resolved.startsWith("../")) continue;
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  let bytes = statSync(join(root, "index.html")).size;
  for (const rel of seen) bytes += statSync(join(root, rel)).size;
  return { bytes, files: seen.size + 1 };
}

test("room page shipped JS and HTML stay within 10% of the measured baseline", t => {
  assert.equal(ROOM_PAGE_BYTE_LIMIT, Math.ceil(ROOM_PAGE_BASELINE_BYTES * 1.1));
  const measured = roomPageBytes();
  t.diagnostic(`room page JS+HTML ${measured.bytes} bytes across ${measured.files} files; baseline ${ROOM_PAGE_BASELINE_BYTES}; limit ${ROOM_PAGE_BYTE_LIMIT}`);
  assert.equal(measured.files > 1, true);
  assert.ok(measured.bytes <= ROOM_PAGE_BYTE_LIMIT, `room page JS+HTML is ${measured.bytes} bytes; limit is ${ROOM_PAGE_BYTE_LIMIT}`);
});

test("a seeded room full snapshot answers within 1s", async t => {
  const { store, origin } = await startSafetyNet(t);
  store.initialize(initialRoom("safety-load"));
  const key = store.issueAccessKey("safety-load", "owner");
  const body = `${"x".repeat(120)} load`;
  let at = store.now();
  store.now = () => at;
  for (let i = 0; i < SEEDED_MESSAGES; i++) {
    at += 2000;
    store.command(key, "safety-load", {
      id: `safety-load-${i}`,
      type: "message.posted",
      data: { messageId: `safety-load-m-${i}`, body: `${body} ${i}` }
    });
  }
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    const response = await fetch(`${origin}/api/rooms/safety-load`, {
      headers: { Authorization: `Bearer ${key}`, Origin: origin, "User-Agent": "project-room-agent" }
    });
    const text = await response.text();
    samples.push(performance.now() - started);
    assert.equal(response.status, 200, `snapshot status ${response.status}`);
    assert.equal(text.includes("safety-load-m-0"), true);
    assert.equal(text.includes(`"messages":"recent"`), false);
  }
  const ordered = [...samples].sort((a, b) => a - b);
  const median = ordered[1];
  t.diagnostic(`full snapshot of ${SEEDED_MESSAGES} messages: ${samples.map(sample => Math.round(sample)).join(", ")} ms; median ${Math.round(median)} ms; limit ${API_BUDGET_MS} ms`);
  assert.ok(median <= API_BUDGET_MS, `full snapshot median ${Math.round(median)} ms exceeds ${API_BUDGET_MS} ms`);
});
