// Route documentation gate (re-audit 2026-09-14, M4).
//
// docs/openapi.yaml must describe every /api route template server/http.mjs
// can match, and must not describe one the server no longer serves. The
// served set comes from routeCandidates() in scripts/open-routes.mjs (the
// same extraction tests/invite-only-boundary.test.js probes anonymously);
// the documented set is every key under `paths:`. Path parameters are
// reduced to {} on both sides so {roomId}, {id} and :roomId compare equal.
// A new route fails `npm run check` until it is documented with its
// security scheme, request body and responses.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openapiOperations, routeCandidates } from "./open-routes.mjs";

export const templateKey = path => path.replace(/\{[^}]+\}|:[A-Za-z]+/g, "{}");

export function routeDocsDrift({ http, openapi }) {
  const served = new Map();
  // server/http.mjs also names "/api/rooms/:roomId" as a diagnostics label; it folds into the {roomId} template.
  for (const template of routeCandidates(http)) if (!served.has(templateKey(template)) || !template.includes(":")) served.set(templateKey(template), template);
  const operations = openapiOperations(openapi);
  const documented = new Map();
  for (const { path } of operations) if (!documented.has(templateKey(path))) documented.set(templateKey(path), path);
  if (served.size < 50 || !served.has("/api/health") || !served.has("/api/rooms/{}/commands")) throw new Error("server route extraction sanity failed");
  if (documented.size < 20 || !documented.has("/api/rooms/{}/commands")) throw new Error("docs/openapi.yaml parse sanity failed");
  const failures = [];
  for (const [key, template] of served) if (!documented.has(key)) failures.push(`served but not documented in docs/openapi.yaml: ${template}`);
  for (const [key, path] of documented) if (!served.has(key)) failures.push(`documented in docs/openapi.yaml but not served by server/http.mjs: ${path}`);
  for (const op of operations) if (op.security === null && /^\/api\/(inbox|account-)/.test(op.path))
    failures.push(`${op.method} ${op.path} inherits the room-credential default; account routes must declare accountSession or security: []`);
  return { failures, served: served.size, documented: documented.size, operations: operations.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = path => readFileSync(join(root, path), "utf8");
  const result = routeDocsDrift({ http: read("server/http.mjs"), openapi: read("docs/openapi.yaml") });
  if (result.failures.length) {
    console.error("Route documentation drift:\n" + result.failures.map(f => `  ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`Route documentation: ${result.served} served route templates, all in docs/openapi.yaml (${result.operations} operations).`);
}
