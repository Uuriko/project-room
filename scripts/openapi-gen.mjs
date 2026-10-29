// OpenAPI gate (batch RT).
//
// The document is rendered from server/openapi/fragments. This check parses
// that rendering, keeps the template gate, and requires every documented
// operation to be a row in server/routes/table.mjs or a row still listed in
// the legacy allowlist. A documented HEAD is covered when GET is served for
// the same template: several handlers answer HEAD as 404 today, and this
// batch does not change that.
//
// --check and --write both refresh docs/openapi.yaml from the fragments when
// the bytes differ, then validate the rendering. Neither command diffs the
// committed snapshot. Generation from the route-table schemas (RT-final)
// still waits until the legacy allowlist is empty.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { renderOpenApi, writeOpenApi } from "./openapi-document.mjs";
import { openapiOperations } from "./open-routes.mjs";
import { routeDocsDrift, routeSources } from "./route-docs-check.mjs";
import { allowlistProblems, extractLegacyRoutes, loadRouteSources, templateKey } from "./routes-inventory.mjs";
import { ROUTES } from "../server/routes/table.mjs";

const ALLOWLIST = "scripts/routes-legacy-allowlist.json";

export function openApiParseErrors(text) {
  const doc = parseDocument(text, { uniqueKeys: true, strict: true });
  return doc.errors.map(error => `${error.message}`);
}

export function methodCoverageProblems(operations, legacyRoutes, tableRoutes = []) {
  const have = new Set();
  for (const row of [...legacyRoutes, ...tableRoutes]) have.add(`${row.method} ${templateKey(row.path)}`);
  const problems = [];
  for (const op of operations) {
    const key = templateKey(op.path);
    const id = `${op.method} ${key}`;
    if (have.has(id)) continue;
    if (op.method === "HEAD" && have.has(`GET ${key}`)) continue;
    problems.push(`documented operation is not in the route table or the legacy allowlist: ${id}`);
  }
  return problems;
}

export function openApiGateProblems(root) {
  const problems = [];
  const openapi = renderOpenApi(root);
  for (const message of openApiParseErrors(openapi)) problems.push(`OpenAPI document: ${message}`);
  for (const failure of routeDocsDrift(routeSources(root)).failures) problems.push(failure);
  const legacy = extractLegacyRoutes(loadRouteSources(root));
  let document = null;
  try {
    document = JSON.parse(readFileSync(join(root, ALLOWLIST), "utf8"));
  } catch (error) {
    problems.push(`legacy allowlist unreadable: ${error.message}`);
  }
  if (document) for (const problem of allowlistProblems(legacy, document)) problems.push(problem);
  for (const problem of methodCoverageProblems(openapiOperations(openapi), legacy, ROUTES)) problems.push(problem);
  if (legacy.length === 0) {
    problems.push("the legacy chain is empty; generate docs/openapi.yaml from the route table before this gate can pass");
  }
  return problems;
}

function repoRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = process.argv.slice(2);
  if (!flags.length || flags.some(flag => flag !== "--check" && flag !== "--write")) {
    console.error("Usage: node scripts/openapi-gen.mjs --check | --write");
    process.exit(1);
  }
  const root = repoRoot();
  const written = writeOpenApi(root);
  if (written.changed) console.log("OpenAPI snapshot refreshed from server/openapi/fragments.");
  const problems = openApiGateProblems(root);
  if (problems.length) {
    console.error("OpenAPI route gate:\n" + problems.map(line => `  ${line}`).join("\n"));
    process.exit(1);
  }
  console.log("OpenAPI route gate: document parses, and every documented operation is served.");
}
