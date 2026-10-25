// Cached parse of docs/openapi.yaml. Node and the Worker both call this
// with bytes they already loaded (disk or ASSETS). The module does not read
// the filesystem: a bundled Worker has no repo path to open.
import { createHash } from "node:crypto";
import { parse } from "yaml";

let cached = null;

export function openApiDocumentFromYaml(bytes) {
  const yaml = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  const etag = `"${createHash("sha256").update(yaml).digest("hex").slice(0, 32)}"`;
  if (cached?.etag === etag) return cached;
  const doc = parse(yaml);
  if (!doc || doc.openapi !== "3.1.0" || !doc.paths || typeof doc.paths !== "object") {
    throw new Error("OpenAPI document is not 3.1.0");
  }
  const json = JSON.stringify(doc);
  cached = {
    etag,
    doc,
    yamlBytes: new TextEncoder().encode(yaml),
    jsonBytes: new TextEncoder().encode(json),
  };
  return cached;
}

export function ifNoneMatch(header, etag) {
  if (typeof header !== "string" || !header) return false;
  return header.split(",").some(tag => {
    const value = tag.trim().replace(/^W\//, "");
    return value === "*" || value === etag;
  });
}
