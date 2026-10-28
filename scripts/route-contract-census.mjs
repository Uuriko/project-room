// W2 contract census: the full implemented route set, derived mechanically
// from the router sources (legacy extraction + declarative route table),
// joined against every inventory that claims to describe it:
//
//   - GET /openapi.json's source table (server/discoverability.mjs)
//   - docs/openapi.yaml (openapiOperations, scripts/open-routes.mjs)
//   - the served-spec prefix exclusions (scripts/openapi-served-exclusions.json)
//   - the set the docs gate itself can see (servedRouteTemplates)
//
// Every served (method, template) lands in exactly one coverage class:
//   spec | docs | both | neither
// and carries drift flags where an inventory contradicts the code.
// Usage: node scripts/route-contract-census.mjs [--json <file>] [--md <file>]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { extractLegacyRoutes, loadRouteSources, templateKey } from "./routes-inventory.mjs";
import { openapiOperations } from "./open-routes.mjs";
import { servedRouteTemplates, routeSources } from "./route-docs-check.mjs";
import { ROUTES } from "../server/routes/table.mjs";
import { DISCOVERABILITY_ROUTES } from "../server/discoverability.mjs";

const key = (method, path) => `${method} ${templateKey(path)}`;

export function buildCensus(root) {
  const legacy = extractLegacyRoutes(loadRouteSources(root));
  const served = new Map();
  const add = (method, path, source, extra = {}) => {
    const k = key(method, path);
    if (!served.has(k)) served.set(k, { method, template: path, key: k, sources: [], ...extra });
    const row = served.get(k);
    if (!row.sources.includes(source)) row.sources.push(source);
    if (extra.tableAuth && !row.tableAuth) row.tableAuth = extra.tableAuth;
    if (extra.tableId && !row.tableId) row.tableId = extra.tableId;
  };
  for (const row of legacy) add(row.method, row.path, "legacy");
  for (const row of ROUTES) add(row.method, row.path, "table", { tableAuth: row.auth, tableId: row.id });

  const docsText = readFileSync(join(root, "docs/openapi.yaml"), "utf8");
  const docOps = new Map();
  for (const op of openapiOperations(docsText)) {
    docOps.set(key(op.method, op.path), { security: op.security, workerOnly: op.workerOnly, path: op.path });
  }
  const docTemplates = new Map();
  for (const op of docOps.values()) {
    const t = templateKey(op.path);
    if (!docTemplates.has(t)) docTemplates.set(t, op.path);
  }

  const specOps = new Map();
  for (const entry of DISCOVERABILITY_ROUTES) {
    for (const method of entry.methods) specOps.set(key(method, entry.path), { auth: entry.auth, path: entry.path });
  }
  const specTemplates = new Set(DISCOVERABILITY_ROUTES.map(e => templateKey(e.path)));

  const exclusions = JSON.parse(readFileSync(join(root, "scripts/openapi-served-exclusions.json"), "utf8")).exclusions
    .map(({ prefix, reason }) => ({ prefix: templateKey(prefix.replace(/\/+$/, "")), reason }));
  const excludedBy = template => exclusions.find(e => template === e.prefix || template.startsWith(e.prefix + "/"));

  const gateVisible = servedRouteTemplates(routeSources(root));

  const records = [];
  for (const row of served.values()) {
    const t = templateKey(row.template);
    const doc = docOps.get(row.key) ?? null;
    const spec = specOps.get(row.key) ?? null;
    const rec = {
      ...row,
      templateKey: t,
      inDocs: Boolean(doc),
      docSecurity: doc ? (doc.security === null ? "inherit" : doc.security.length === 0 ? "open" : doc.security.join("+")) : null,
      docWorkerOnly: doc ? doc.workerOnly : null,
      inSpec: Boolean(spec),
      specAuth: spec ? spec.auth : null,
      excludedPrefix: excludedBy(t)?.prefix ?? null,
      exclusionReason: excludedBy(t)?.reason ?? null,
      gateVisible: gateVisible.has(t),
      coverage: doc && spec ? "both" : doc ? "docs" : spec ? "spec" : "neither",
      drift: [],
    };
    if (row.sources.length > 1) rec.drift.push("double-served: in route table AND legacy extraction");
    if (!rec.gateVisible) rec.drift.push("gate-invisible: servedRouteTemplates (docs gate) cannot see this template");
    if (!doc && docTemplates.has(t) && row.method !== "HEAD") {
      rec.drift.push(`method-not-in-docs: template documented in docs/openapi.yaml, ${row.method} is not`);
    }
    if (!doc && docTemplates.has(t) && row.method === "HEAD" && !docOps.has(key("GET", row.template))) {
      rec.drift.push("head-without-get: HEAD served, template documented, GET not documented");
    }
    if (!spec && specTemplates.has(t) && row.method !== "HEAD") {
      rec.drift.push(`method-not-in-spec: path in served spec, ${row.method} is not`);
    }
    // Auth-story agreement between the two inventories (coarse; flags only).
    if (doc && spec) {
      const specOpen = ["none", "open"].includes(spec.auth);
      const docOpen = rec.docSecurity === "open";
      if (specOpen !== docOpen) rec.drift.push(`auth-story mismatch: spec auth=${spec.auth} but docs security=${rec.docSecurity}`);
      if (spec.auth === "account-session" && rec.docSecurity !== "inherit" && !(rec.docSecurity ?? "").includes("accountSession")) {
        rec.drift.push("auth-story mismatch: spec auth=account-session but docs security does not name accountSession");
      }
    }
    records.push(rec);
  }

  const phantoms = { docs: [], spec: [] };
  for (const [k, op] of docOps) if (!served.has(k)) phantoms.docs.push(`${k} (${op.path})`);
  for (const [k, op] of specOps) if (!served.has(k)) phantoms.spec.push(`${k} (auth=${op.auth})`);

  records.sort((a, b) => a.template === b.template ? a.method.localeCompare(b.method) : a.template.localeCompare(b.template));
  return { records, phantoms, counts: summarize(records, phantoms) };
}

function summarize(records, phantoms) {
  const by = (fn) => records.filter(fn).length;
  return {
    servedRows: records.length,
    servedTemplates: new Set(records.map(r => r.templateKey)).size,
    apiTemplates: new Set(records.filter(r => r.templateKey.startsWith("/api/")).map(r => r.templateKey)).size,
    nonApiTemplates: new Set(records.filter(r => !r.templateKey.startsWith("/api/")).map(r => r.templateKey)).size,
    coverage: {
      both: by(r => r.coverage === "both"),
      docs: by(r => r.coverage === "docs"),
      spec: by(r => r.coverage === "spec"),
      neither: by(r => r.coverage === "neither"),
    },
    neitherApi: by(r => r.coverage === "neither" && r.templateKey.startsWith("/api/")),
    neitherNonApi: by(r => r.coverage === "neither" && !r.templateKey.startsWith("/api/")),
    drifted: by(r => r.drift.length > 0),
    phantomDocs: phantoms.docs.length,
    phantomSpec: phantoms.spec.length,
  };
}

function markdown({ records, phantoms, counts }) {
  const lines = [];
  lines.push("# W2 route contract census", "");
  lines.push("Counts are (method, template) rows unless stated. Templates are {}-normalized.", "");
  lines.push("```json", JSON.stringify(counts, null, 2), "```", "");
  const section = (title, rows, fmt) => {
    lines.push(`## ${title} (${rows.length})`, "");
    for (const r of rows) lines.push(fmt(r));
    lines.push("");
  };
  section("Drifted rows (inventory contradicts code, or double-served)", records.filter(r => r.drift.length),
    r => `- \`${r.key}\` [${r.coverage}] ${r.drift.join("; ")}`);
  section("Neither inventory, /api (class (a) candidates + excluded)", records.filter(r => r.coverage === "neither" && r.templateKey.startsWith("/api/")),
    r => `- \`${r.key}\`${r.excludedPrefix ? ` — excluded by prefix ${r.excludedPrefix}: ${r.exclusionReason}` : " — NOT covered by any exclusion prefix"}`);
  section("Neither inventory, non-/api", records.filter(r => r.coverage === "neither" && !r.templateKey.startsWith("/api/")),
    r => `- \`${r.key}\` [${r.sources.join("+")}]`);
  lines.push(`## Phantom docs/openapi.yaml operations (${phantoms.docs.length})`, "", ...phantoms.docs.map(p => `- \`${p}\``), "");
  lines.push(`## Phantom served-spec operations (${phantoms.spec.length})`, "", ...phantoms.spec.map(p => `- \`${p}\``), "");
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const census = buildCensus(root);
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(census, null, 2) + "\n");
  if (opt("--md")) writeFileSync(opt("--md"), markdown(census));
  console.log(JSON.stringify(census.counts, null, 2));
}
