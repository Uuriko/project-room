// The published OpenAPI document is assembled from the route and contract
// fragments in server/openapi/fragments. Pull requests edit those fragments.
// docs/openapi.yaml is the snapshot `writeOpenApi` refreshes; the route gate
// reads the fragments, not a diff of that snapshot.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function openApiRoot(root) {
  return root ?? fileURLToPath(new URL("..", import.meta.url));
}

export function renderOpenApi(root = openApiRoot()) {
  const dir = join(root, "server/openapi/fragments");
  const names = readdirSync(dir).filter(name => name.endsWith(".yaml")).sort();
  if (names.length < 3 || names[0] !== "0000-preamble.yaml" || !names.at(-1).startsWith("9999-")) {
    throw new Error("OpenAPI fragments are missing the preamble or components");
  }
  return names.map(name => readFileSync(join(dir, name), "utf8")).join("");
}

// Refresh the published snapshot when the fragments moved. Returns whether
// the snapshot bytes changed. Callers that only need the document use
// renderOpenApi and never read the snapshot.
export function writeOpenApi(root = openApiRoot()) {
  const next = renderOpenApi(root);
  const path = join(root, "docs/openapi.yaml");
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current !== next) writeFileSync(path, next);
  return { changed: current !== next, text: next };
}
