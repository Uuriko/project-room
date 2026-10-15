// W2 route contract gate: the served surface and the inventories that
// describe it cannot silently drift apart again.
//
// The served set is DERIVED from the router sources (scripts/
// route-contract-census.mjs: legacy extraction + the declarative route
// table), never hand-listed — the same discipline as the route-auth
// table. Every served template must be classified exactly one way:
//
//   - an operation in docs/openapi.yaml, or
//   - an entry in the served spec (server/discoverability.mjs), or
//   - an exemption in scripts/route-contract-exemptions.json carrying a
//     class and a reason (deliberately internal / door / document /
//     extractor artifact …).
//
// Mutating operations (POST/PUT/PATCH/DELETE) must additionally be
// classified at (method, template) level. HEAD inherits its template's
// GET classification (the repo convention for public reads). Inventory
// phantoms — operations an inventory describes but the server does not
// serve — fail in both inventories. Stale exemptions fail too, so the
// classification cannot rot into a second silent inventory.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCensus } from "../scripts/route-contract-census.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const census = buildCensus(root);
const exemptions = JSON.parse(readFileSync(new URL("../scripts/route-contract-exemptions.json", import.meta.url), "utf8"));

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TEMPLATE_CLASSES = new Set(["edge-door", "protocol", "discovery-doc", "web-ui", "web-asset", "human-auth", "ops"]);
const METHOD_CLASSES = new Set(["extractor-artifact", "action-family"]);
// Door/protocol templates carry their methods as part of the classified
// surface (an MCP door's POST is the protocol, not a REST operation).
const PASS_THROUGH = new Set(["edge-door", "protocol", "human-auth", "ops"]);

const templateExempt = new Map(exemptions.templates.map(e => [e.template, e]));
const methodExempt = new Map(exemptions.methods.map(e => [`${e.method} ${e.template}`, e]));
const byTemplate = new Map();
for (const r of census.records) {
  if (!byTemplate.has(r.templateKey)) byTemplate.set(r.templateKey, []);
  byTemplate.get(r.templateKey).push(r);
}
const servedKeys = new Set(census.records.map(r => r.key));

test("census sanity floors (a derivation failure must not pass as an empty surface)", () => {
  assert.ok(census.counts.servedTemplates >= 500, `served templates ${census.counts.servedTemplates} < 500`);
  assert.ok(census.records.filter(r => r.inDocs).length >= 500, "documented operations floor");
  assert.ok(new Set(census.records.filter(r => r.inSpec).map(r => r.templateKey)).size >= 60, "served-spec paths floor");
  assert.equal(templateExempt.size, exemptions.templates.length, "duplicate template exemption entries");
  assert.equal(methodExempt.size, exemptions.methods.length, "duplicate method exemption entries");
});

test("no phantom operations: every inventory operation is served", () => {
  assert.deepEqual(census.phantoms.docs, [],
    "docs/openapi.yaml describes operations the server does not serve; serve them, remove them, or teach scripts/routes-inventory.mjs the dispatch shape");
  assert.deepEqual(census.phantoms.spec, [],
    "the served spec (server/discoverability.mjs) describes operations the server does not serve; serve them or remove them");
});

test("every served template is documented or classified", () => {
  const unclassified = [];
  for (const [template, rows] of byTemplate) {
    if (rows.some(r => r.inDocs || r.inSpec)) continue;
    if (!templateExempt.has(template)) unclassified.push(template);
  }
  assert.deepEqual(unclassified.sort(), [],
    "served templates in no inventory and not classified; document them (docs/openapi.yaml or server/discoverability.mjs) or add a templates entry with a class and reason to scripts/route-contract-exemptions.json");
});

test("every served mutating operation is documented or classified", () => {
  const unclassified = [];
  for (const r of census.records) {
    if (!MUTATING.has(r.method) || r.coverage !== "neither") continue;
    if (methodExempt.has(r.key)) continue;
    const t = templateExempt.get(r.templateKey);
    if (t && PASS_THROUGH.has(t.class)) continue;
    unclassified.push(r.key);
  }
  assert.deepEqual(unclassified.sort(), [],
    "served mutating operations in no inventory and not classified; document them or add a methods entry with a class and reason to scripts/route-contract-exemptions.json");
});

test("exemptions are current and substantive (no stale or empty classification)", () => {
  const stale = [];
  for (const e of exemptions.templates) {
    assert.ok(TEMPLATE_CLASSES.has(e.class), `unknown template class ${e.class} for ${e.template}`);
    assert.ok(typeof e.reason === "string" && e.reason.length >= 40, `template exemption ${e.template} needs a substantive reason`);
    const rows = byTemplate.get(e.template);
    if (!rows) stale.push(`${e.template} (no longer served)`);
    else if (rows.some(r => r.inDocs || r.inSpec)) stale.push(`${e.template} (now in an inventory; remove the exemption)`);
  }
  for (const e of exemptions.methods) {
    assert.ok(METHOD_CLASSES.has(e.class), `unknown method class ${e.class} for ${e.method} ${e.template}`);
    assert.ok(typeof e.reason === "string" && e.reason.length >= 40, `method exemption ${e.method} ${e.template} needs a substantive reason`);
    const key = `${e.method} ${e.template}`;
    if (!servedKeys.has(key)) stale.push(`${key} (no longer served)`);
    else if (census.records.find(r => r.key === key)?.coverage !== "neither") stale.push(`${key} (now documented; remove the exemption)`);
  }
  assert.deepEqual(stale.sort(), [], "stale route-contract exemptions");
});
