// API reference generator (O004). Generates a Markdown API reference
// from docs/openapi.yaml. Pure and dependency-free (simple YAML subset
// parsing for paths). The module is pure. Frozen outputs; malformed
// inputs throw ApiError.
class ApiError extends Error { constructor(code, message) { super(message); this.name = "ApiError"; this.code = code; } }
const fail = (code, message) => { throw new ApiError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_api", message); };
// Parse paths from openapi.yaml content (simple line-based parsing).
// Returns [{ path, methods: [{ method, summary }] }].
export function parsePaths({ yaml }) {
  check(typeof yaml === "string" && yaml.length > 0, "yaml must be a non-empty string");
  const paths = [];
  const lines = yaml.split("\n");
  let currentPath = null;
  let inPaths = false;
  for (const line of lines) {
    if (line === "paths:") { inPaths = true; continue; }
    if (!inPaths) continue;
    // Path line: "  /api/rooms:" (2-space indent, ends with colon)
    const pathMatch = line.match(/^  (\/[^:]*):$/);
    if (pathMatch) {
      currentPath = { path: pathMatch[1], methods: [] };
      paths.push(currentPath);
      continue;
    }
    // Method line: "    get:" (4-space indent)
    const methodMatch = line.match(/^    (get|post|put|patch|delete|head|options):$/);
    if (methodMatch && currentPath) {
      currentPath.methods.push({ method: methodMatch[1].toUpperCase(), summary: "" });
      continue;
    }
    // Summary line: "      summary: ..." (6-space indent)
    const summaryMatch = line.match(/^      summary: (.*)$/);
    if (summaryMatch && currentPath && currentPath.methods.length > 0) {
      currentPath.methods[currentPath.methods.length - 1].summary = summaryMatch[1].trim();
    }
    // End of paths section: top-level key (no indent, ends with colon)
    if (/^[a-z]+:$/.test(line) && line !== "paths:") break;
  }
  return Object.freeze(paths.map(p => Object.freeze({ path: p.path,
    methods: Object.freeze(p.methods.map(m => Object.freeze(m))) })));
}
// Generate Markdown API reference from parsed paths.
export function pathsToMarkdown({ paths, title }) {
  check(Array.isArray(paths), "paths must be an array");
  const lines = [`# ${title || "API Reference"}`, "",
    `Generated from docs/openapi.yaml. ${paths.length} paths.`, ""];
  for (const p of paths) {
    lines.push(`## \`${p.path}\``, "");
    for (const m of p.methods) {
      lines.push(`### ${m.method}`, "");
      if (m.summary) lines.push(m.summary, "");
    }
  }
  return lines.join("\n");
}
export { ApiError };
