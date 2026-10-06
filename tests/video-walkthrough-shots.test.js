// O011 video walkthrough script — groundability gate.
// Every shot the script promises must cite a real product surface:
// a file that exists in this repo and a literal fragment inside it.
// If a shot cites something that does not exist, this test fails and
// the SCRIPT (not the product) gets fixed. See
// docs/video-walkthrough-script.md § Grounding register.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "docs", "video-walkthrough-script.md");

function scriptText() {
  assert.ok(existsSync(SCRIPT), `script doc missing: ${SCRIPT}`);
  return readFileSync(SCRIPT, "utf8");
}

// "> ground: <repo-relative path> :: <literal fragment>"
const GROUND_RE = /^>\s*ground:\s*(\S+)\s*::\s*(.+?)\s*$/;

function grounds(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = GROUND_RE.exec(line);
    if (m) out.push({ path: m[1], fragment: m[2] });
  }
  return out;
}

const FORBIDDEN = new Set([
  "server/claim-coordination.mjs",
  "docs/SIGNED-AGENT-CARDS.md",
  "server/agent-directory.mjs",
  "server/needs-me.mjs",
  "server/updates.mjs",
  "server/mcp-http.mjs",
  "server/mcp-arg-errors.mjs",
  "server/store.mjs",
  "server/bonds.mjs",
  "src/app.js",
  "src/room-mcp-join.js",
  "server/mcp-room-profile.mjs",
  "docs/openapi.yaml",
]);

test("script exists and declares at least one ground citation per shot", () => {
  const text = scriptText();
  const list = grounds(text);
  assert.ok(list.length >= 20, `expected >=20 ground citations, got ${list.length}`);
});

test("no ground citation points at a forbidden file", () => {
  const text = scriptText();
  for (const g of grounds(text)) {
    assert.ok(!FORBIDDEN.has(g.path), `ground cites forbidden file: ${g.path}`);
  }
});

test("every ground citation resolves: file exists, fragment present", () => {
  const text = scriptText();
  const failures = [];
  for (const g of grounds(text)) {
    const abs = path.join(ROOT, g.path);
    if (!existsSync(abs)) {
      failures.push(`${g.path}: file does not exist`);
      continue;
    }
    const body = readFileSync(abs, "utf8");
    if (!body.includes(g.fragment)) {
      failures.push(`${g.path}: fragment not found: ${JSON.stringify(g.fragment)}`);
    }
  }
  assert.deepEqual(failures, [], `unresolvable ground citations:\n${failures.join("\n")}`);
});

const REQUIRED_BEATS = ["hook", "the room", "claims", "inbox", "connect", "close"];

test("script covers every required beat section", () => {
  const text = scriptText().toLowerCase();
  for (const beat of REQUIRED_BEATS) {
    assert.ok(
      text.includes(`## ${beat}`),
      `script missing beat section: ## ${beat}`
    );
  }
});

function parseTimecode(s) {
  const m = /^(\d+):([0-5]\d)$/.exec(s.trim());
  assert.ok(m, `bad timecode: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

test("timeline table exists and total runtime is 3:00–5:00", () => {
  const text = scriptText();
  const m = text.match(/^>\s*runtime-total:\s*(\d+:\d+)\s*$/m);
  assert.ok(m, "script missing `> runtime-total: M:SS` marker");
  const total = parseTimecode(m[1]);
  assert.ok(
    total >= 180 && total <= 300,
    `runtime-total ${m[1]} outside 3:00–5:00 window`
  );
});

test("each beat section has narration and at least one shot", () => {
  const text = scriptText();
  const sections = text.split(/^## /m).slice(1);
  for (const sec of sections) {
    const name = sec.split("\n")[0].trim().toLowerCase();
    if (!REQUIRED_BEATS.some(b => name.startsWith(b))) continue;
    assert.ok(/narration/i.test(sec), `beat "${name}" has no narration`);
    assert.ok(/shot/i.test(sec), `beat "${name}" has no shots`);
  }
});
