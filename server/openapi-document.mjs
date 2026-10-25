// ETag helpers for the OpenAPI document. Node and the Worker both hash
// bytes they already loaded. This module does not parse YAML: the runtime
// package only ships relative and node: imports, and docs/openapi.json is
// the JSON form of docs/openapi.yaml.
import { createHash } from "node:crypto";

export function strongEtag(bytes) {
  return `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
}

export function ifNoneMatch(header, etag) {
  if (typeof header !== "string" || !header) return false;
  return header.split(",").some(tag => {
    const value = tag.trim().replace(/^W\//, "");
    return value === "*" || value === etag;
  });
}
