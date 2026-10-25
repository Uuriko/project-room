// Content-hashed client bundles produced by scripts/build-client.mjs.
// Dev and self-host keep serving the raw /src modules. Production HTML
// points at /assets/<name>-<hash>.js, which is safe to cache forever.
import { createHash } from "node:crypto";

export const IMMUTABLE_CLIENT_CACHE = "public, max-age=31536000, immutable";
export const HTML_ENTRY_CACHE = "no-cache";

// esbuild's [hash] is 8 alphanumeric characters of the output contents.
const HASHED_FILE = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}-[A-Za-z0-9]{8}\.(js|css)$/;
const HASHED_URL = /^\/(?:room\/)?(assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}-[A-Za-z0-9]{8}\.(js|css))$/;

export function isPackagedClientAsset(path) {
  return HASHED_FILE.test(path);
}

export function resolveHashedClientAsset(pathname) {
  const match = HASHED_URL.exec(pathname);
  if (!match) return null;
  const file = match[1];
  const css = file.endsWith(".css");
  return { file, type: css ? "text/css" : "text/javascript" };
}

export function contentEtag(bytes) {
  return `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
}

export function etagMatches(header, etag) {
  if (typeof header !== "string" || !header) return false;
  return header.split(",").some(tag => {
    const value = tag.trim().replace(/^W\//, "");
    return value === "*" || value === etag;
  });
}
