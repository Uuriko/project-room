// O015 backlog: docs/GLOSSARY.md must contain no invented terms.
// Failing-first (2026-10-06): every domain term the glossary defines must be
// grounded in code or docs that actually exist — terms are DERIVED FROM THE
// DOC ITSELF (its `## Term` headings and its `Grounding:` citation lines are
// resolved against the tree). An invented term, a citation to a nonexistent
// module/doc, or a money-domain term this lane is forbidden from writing
// (bounty, escrow, $DASHA — out of scope for backlog-o015-glossary) fails.
// Negative pins below are terms reached for during recon that must NOT be
// defined here (squad: unlanded claim; bounty/escrow: forbidden topic).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const doc = read("docs/GLOSSARY.md");
const unique = (arr) => [...new Set(arr)];

// --- derivation: terms and citations named in the doc ---

const terms = unique(
  [...doc.matchAll(/^## ([^\n(]+?)\s*$/gm)].map((m) => m[1].trim())
);

const citations = unique(
  [...doc.matchAll(/Grounding:\s*([^\n]+)/g)].map((m) => m[1])
    .flatMap((line) =>
      [...line.matchAll(/(?:server|src|deploy|scripts|tests)\/[\w./-]+\.(?:mjs|js)|docs\/[\w./-]+\.(?:md|json)/g)].map(
        (m) => m[0]
      )
    )
);

test("glossary defines at least 25 verified terms", () => {
  assert.ok(terms.length >= 25, `only ${terms.length} terms defined`);
});

test("every grounding citation resolves to a real file", () => {
  const missing = citations.filter((c) => !existsSync(join(root, c)));
  assert.deepEqual(missing, [], `citations resolve to nothing: ${missing.join(", ")}`);
});

test("every term carries a grounding citation", () => {
  const sections = doc.split(/^## /m).slice(1);
  const ungrounded = sections
    .map((s) => s.split("\n")[0].trim())
    .filter((name) => {
      const body = sections.find((s) => s.startsWith(name));
      return !/Grounding:/.test(body);
    });
  assert.deepEqual(ungrounded, [], `terms without grounding: ${ungrounded.join(", ")}`);
});

test("no invented or forbidden-scope terms", () => {
  const text = doc.toLowerCase();
  for (const banned of ["## squad", "## bounty", "## escrow", "## $dasha"]) {
    assert.ok(!text.includes(banned), `invented/forbidden term defined: ${banned}`);
  }
});

test("glossary is linked from docs INDEX", () => {
  assert.ok(read("docs/INDEX.md").includes("GLOSSARY.md"), "docs/INDEX.md does not link the glossary");
});
