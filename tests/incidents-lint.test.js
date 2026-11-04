// Incident catalog gate. Every dated write-up under docs/incidents/ must
// name a regression test that exists, and docs/incidents/index.json must
// list those write-ups so an agent can read them without scraping markdown.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HEADINGS = [
  "## Timeline",
  "### Detect",
  "### Start",
  "### Mitigate",
  "### Resolve",
  "## Cause",
  "## Why detection took this long",
  "## What users and agents saw",
  "## Regression test",
  "## Follow-ups",
];
const INCIDENT_FILE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9-]+\.md$/;
const TEST_LINE = /^Regression test: `(tests\/incidents\/[a-z0-9-]+\.test\.js)`$/m;

export function lintIncidents(root) {
  const problems = [];
  const docsDir = join(root, "docs", "incidents");
  let names;
  try { names = readdirSync(docsDir); }
  catch { return ["docs/incidents/ is missing"]; }

  const templatePath = join(docsDir, "TEMPLATE.md");
  let template = "";
  try { template = readFileSync(templatePath, "utf8"); }
  catch { problems.push("docs/incidents/TEMPLATE.md is missing"); }
  for (const heading of HEADINGS) {
    if (template && !template.includes(heading)) problems.push(`docs/incidents/TEMPLATE.md lacks ${heading}`);
  }

  const incidents = names.filter(name => INCIDENT_FILE.test(name)).sort();
  for (const name of names) {
    if (!name.endsWith(".md") || name === "TEMPLATE.md") continue;
    if (!INCIDENT_FILE.test(name)) problems.push(`docs/incidents/${name} is not a dated incident file`);
  }

  const linked = new Map();
  for (const name of incidents) {
    const rel = `docs/incidents/${name}`;
    const text = readFileSync(join(docsDir, name), "utf8");
    for (const heading of HEADINGS) {
      if (!text.includes(heading)) problems.push(`${rel} lacks ${heading}`);
    }
    const timeline = text.split("## Cause")[0] ?? "";
    if (!timeline.includes("PT")) problems.push(`${rel} timeline does not label times PT`);
    const match = text.match(TEST_LINE);
    if (!match) {
      problems.push(`${rel} has no regression test linking an existing tests/incidents file`);
      continue;
    }
    const testRel = match[1];
    const id = name.slice(0, -3);
    if (testRel !== `tests/incidents/${id}.test.js`) {
      problems.push(`${rel} regression test ${testRel} is not named after the incident`);
    }
    try { readFileSync(join(root, testRel)); }
    catch { problems.push(`${rel} links ${testRel}, which is not in the tree`); }
    linked.set(id, testRel);
  }

  const indexRel = "docs/incidents/index.json";
  let index;
  try { index = JSON.parse(readFileSync(join(root, indexRel), "utf8")); }
  catch (error) {
    problems.push(error instanceof SyntaxError ? `${indexRel} is not JSON` : `${indexRel} is missing`);
    return problems;
  }
  if (index?.schema !== "room.incidents/1" || !Array.isArray(index.incidents)) {
    problems.push(`${indexRel} must be { schema: "room.incidents/1", incidents: [] }`);
    return problems;
  }
  const seen = new Set();
  for (const entry of index.incidents) {
    const id = entry && typeof entry.id === "string" ? entry.id : "";
    if (!id || seen.has(id)) {
      problems.push(`${indexRel} has a missing or duplicate id`);
      continue;
    }
    seen.add(id);
    const expectedTest = linked.get(id);
    if (!expectedTest) problems.push(`${indexRel} lists ${id}, which has no incident doc`);
    if (entry.date !== id.slice(0, 10)) problems.push(`${indexRel} entry ${id} date does not match its id`);
    if (entry.doc !== `docs/incidents/${id}.md`) problems.push(`${indexRel} entry ${id} doc path is wrong`);
    if (typeof entry.title !== "string" || entry.title.length === 0) problems.push(`${indexRel} entry ${id} needs a title`);
    if (typeof entry.status !== "string" || entry.status.length === 0) problems.push(`${indexRel} entry ${id} needs a status`);
    if (entry.test !== expectedTest) problems.push(`${indexRel} entry ${id} test does not match the doc`);
  }
  for (const id of linked.keys()) {
    if (!seen.has(id)) problems.push(`${indexRel} omits ${id}`);
  }
  return problems;
}

function writeIncident(dir, name, { testLine = true } = {}) {
  const id = name.slice(0, -3);
  const test = testLine ? `Regression test: \`tests/incidents/${id}.test.js\`\n` : "No test yet.\n";
  writeFileSync(join(dir, "docs", "incidents", name), [
    `# ${id}`,
    "",
    "## Timeline",
    "",
    "### Detect",
    "",
    "Not recorded (PT).",
    "",
    "### Start",
    "",
    "Not recorded (PT).",
    "",
    "### Mitigate",
    "",
    "Not recorded (PT).",
    "",
    "### Resolve",
    "",
    "Not recorded (PT).",
    "",
    "## Cause",
    "",
    "Cause.",
    "",
    "## Why detection took this long",
    "",
    "Detection.",
    "",
    "## What users and agents saw",
    "",
    "Impact.",
    "",
    "## Regression test",
    "",
    test,
    "## Follow-ups",
    "",
    "None.",
    "",
  ].join("\n"));
}

test("an incident doc with no linked test file is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "incidents-lint-"));
  const docs = join(root, "docs", "incidents");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "TEMPLATE.md"), HEADINGS.join("\n") + "\n");
  writeIncident(root, "2026-01-01-orphan.md", { testLine: false });
  writeFileSync(join(root, "docs", "incidents", "index.json"), JSON.stringify({
    schema: "room.incidents/1",
    incidents: [],
  }));
  try {
    const problems = lintIncidents(root);
    assert.ok(problems.some(problem => problem.includes("2026-01-01-orphan.md") && problem.includes("no regression test")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a linked test file that is not in the tree is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "incidents-lint-"));
  mkdirSync(join(root, "docs", "incidents"), { recursive: true });
  writeFileSync(join(root, "docs", "incidents", "TEMPLATE.md"), HEADINGS.join("\n") + "\n");
  writeIncident(root, "2026-01-02-missing.md");
  writeFileSync(join(root, "docs", "incidents", "index.json"), JSON.stringify({
    schema: "room.incidents/1",
    incidents: [{
      id: "2026-01-02-missing",
      date: "2026-01-02",
      title: "Missing",
      doc: "docs/incidents/2026-01-02-missing.md",
      test: "tests/incidents/2026-01-02-missing.test.js",
      status: "open",
    }],
  }));
  try {
    const problems = lintIncidents(root);
    assert.ok(problems.some(problem => problem.includes("2026-01-02-missing.test.js") && problem.includes("not in the tree")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo incident docs each link an existing test and match the index", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.deepEqual(lintIncidents(root), []);
});
