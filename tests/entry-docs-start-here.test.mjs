// Gap G1: five overlapping "start here" docs; primary opened with contributor content.
// Acceptance: a new agent with only the repo URL can find the single doc that
// gets to a first claimed task in under 10 minutes. This test pins that:
//  1. docs/AGENT-START-HERE.md exists with ordered steps to a first claimed task.
//  2. README.md links it.
//  3. The generated /llms.txt ("Start here" list) links it and no longer crowns
//     SWARM-PLUG-IN.md as the one enrollment doc.
//  4. The generated /llms-full.txt links it too (G2 superset guard parity).
//  5. The five specialized docs are kept (not deleted) and carry a pointer to
//     the primary doc at the top.
//  6. The primary doc labels each specialized path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const PRIMARY = "docs/AGENT-START-HERE.md";
const SPECIALIZED = [
  "docs/SWARM-PLUG-IN.md",
  "docs/AGENT-QUICKSTART.md",
  "docs/COLD-AGENT-WALKTHROUGH.md",
  "docs/JOINING.md",
  "docs/JOIN-ANY-AGENT.md",
];

test("primary start-here doc exists with ordered steps to a first claimed task", () => {
  assert.ok(existsSync(join(ROOT, PRIMARY)), `${PRIMARY} is missing`);
  const doc = read(PRIMARY);
  const steps = [...doc.matchAll(/^##\s+Step\s+(\d+)/gim)].map((m) => Number(m[1]));
  assert.ok(steps.length >= 5, `expected at least 5 ordered "## Step N" sections, got ${steps.length}`);
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), "steps are not in order");
  for (const need of ["agent-identities", "public-work/match", "claim", "finish", "receipt"]) {
    assert.ok(
      doc.toLowerCase().includes(need),
      `primary doc never mentions "${need}" — the ordered path to a first claim is broken`,
    );
  }
});

test("README points cold agents at the primary start-here doc", () => {
  const readme = read("README.md");
  assert.ok(
    readme.includes("docs/AGENT-START-HERE.md"),
    "README.md does not link docs/AGENT-START-HERE.md",
  );
});

test("generated /llms.txt Start here links the primary doc, not SWARM-PLUG-IN as the one enrollment doc", async () => {
  const { llmsTxt } = await import("../deploy/agent-discovery.mjs");
  const txt = llmsTxt();
  const startHere = txt.slice(txt.indexOf("## Start here"));
  assert.ok(
    startHere.includes("docs/AGENT-START-HERE.md"),
    "/llms.txt ## Start here does not link docs/AGENT-START-HERE.md",
  );
  assert.ok(
    !startHere.includes("the one enrollment doc"),
    "/llms.txt still crowns SWARM-PLUG-IN.md as the one enrollment doc",
  );
});

test("generated /llms-full.txt links the primary doc too (G2 superset parity)", async () => {
  const { llmsFullTxt } = await import("../deploy/agent-discovery.mjs");
  const txt = llmsFullTxt();
  assert.ok(
    txt.includes("docs/AGENT-START-HERE.md"),
    "/llms-full.txt does not link docs/AGENT-START-HERE.md",
  );
});

test("specialized entry docs are kept (not deleted) and point at the primary doc", () => {
  for (const file of SPECIALIZED) {
    assert.ok(existsSync(join(ROOT, file)), `${file} was deleted — demote with a pointer, never delete`);
    const head = read(file).split("\n").slice(0, 15).join("\n");
    assert.ok(
      head.includes("AGENT-START-HERE.md"),
      `${file} has no pointer to the primary doc in its first 15 lines`,
    );
  }
});

test("primary doc teaches per-code 409 recovery (review: not every 409 is a taken task)", () => {
  const doc = read(PRIMARY).toLowerCase();
  for (const code of [
    "public_work_claim_conflict",
    "stale_public_work",
    "public_work_path_conflict",
    "public_work_already_submitted",
    "stale_public_claim",
  ]) {
    assert.ok(doc.includes(code), `primary doc never teaches the ${code} recovery`);
  }
  assert.ok(
    doc.includes("error.code") || doc.includes("error code"),
    "primary doc does not tell agents to read the 409 error code",
  );
  assert.ok(
    doc.includes("uncertain"),
    "primary doc does not distinguish uncertain-response retry from known-conflict recovery",
  );
});

test("primary doc labels each specialized path", () => {
  const doc = read(PRIMARY);
  for (const file of SPECIALIZED) {
    const name = file.replace("docs/", "");
    assert.ok(doc.includes(name), `primary doc does not label the specialized path ${name}`);
  }
});
