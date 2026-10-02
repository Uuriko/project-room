// Offline checks for server.json, plus an optional registry version bump.
// The description text is whatever the file says. POS-1a can change that
// field; this script only checks its shape.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_ORIGIN = "https://room.trydemigod.com";
export const NAMESPACE_PREFIX = "io.github.Uuriko/";
export const DESCRIPTION_MAX = 100;
export const REGISTRY_VERSIONS_URL = "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Uuriko%2Fproject-room/versions";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REQUIRED = ["name", "description", "version"];

export function parseSemver(version) {
  if (typeof version !== "string") return null;
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : null
  };
}

function compareIdentifiers(left, right) {
  const leftNum = /^[0-9]+$/.test(left);
  const rightNum = /^[0-9]+$/.test(right);
  if (leftNum && rightNum) return Number(left) - Number(right);
  if (leftNum !== rightNum) return leftNum ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

// Positive when `left` is a newer semver than `right`.
export function compareSemver(left, right) {
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] - right[part];
  }
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i += 1) {
    if (left.pre[i] === undefined) return -1;
    if (right.pre[i] === undefined) return 1;
    const diff = compareIdentifiers(left.pre[i], right.pre[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function problem(code, message) {
  return { code, message };
}

export function checkServerJson(manifest) {
  const errors = [];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: [problem("missing_field", "server.json must be a JSON object")] };
  }
  for (const field of REQUIRED) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
      errors.push(problem("missing_field", `${field} is required`));
    }
  }
  if (!Array.isArray(manifest.remotes) || manifest.remotes.length === 0) {
    errors.push(problem("missing_field", "remotes is required"));
  }
  if (typeof manifest.name === "string" && manifest.name.length > 0 && !manifest.name.startsWith(NAMESPACE_PREFIX)) {
    errors.push(problem("namespace", `name must start with ${NAMESPACE_PREFIX}`));
  }
  if (typeof manifest.description === "string" && manifest.description.length > DESCRIPTION_MAX) {
    errors.push(problem("description_too_long", `description is ${manifest.description.length} characters; the maximum is ${DESCRIPTION_MAX}`));
  }
  if (typeof manifest.version === "string" && manifest.version.length > 0 && !parseSemver(manifest.version)) {
    errors.push(problem("version_semver", "version must be a semantic version"));
  }
  if (Array.isArray(manifest.remotes)) {
    for (const remote of manifest.remotes) {
      let origin = "";
      try { origin = new URL(remote?.url).origin; }
      catch { origin = ""; }
      if (origin !== CANONICAL_ORIGIN) {
        errors.push(problem("remote_origin", `remote URL must use ${CANONICAL_ORIGIN}`));
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function latestRegistryServer(payload) {
  const rows = Array.isArray(payload?.servers) ? payload.servers : [];
  const flagged = rows.find(row => row?._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest === true);
  if (flagged?.server?.version) return flagged.server;
  let best = null;
  let bestParsed = null;
  for (const row of rows) {
    const server = row?.server;
    const parsed = parseSemver(server?.version);
    if (!parsed) continue;
    if (!bestParsed || compareSemver(parsed, bestParsed) > 0) {
      best = server;
      bestParsed = parsed;
    }
  }
  return best;
}

export function checkVersionIncreases(manifest, registryPayload) {
  const local = checkServerJson(manifest);
  if (!local.ok) return local;
  const latest = latestRegistryServer(registryPayload);
  if (!latest) return { ok: true, errors: [] };
  const next = parseSemver(manifest.version);
  const previous = parseSemver(latest.version);
  if (!previous) {
    return { ok: false, errors: [problem("version_semver", `registry version ${latest.version} is not a semantic version`)] };
  }
  if (compareSemver(next, previous) <= 0) {
    return {
      ok: false,
      errors: [problem("version_not_greater", `version ${manifest.version} is not greater than the registry's ${latest.version}`)]
    };
  }
  return { ok: true, errors: [] };
}

export async function checkAgainstRegistry(manifest, { fetchImpl = globalThis.fetch, url = REGISTRY_VERSIONS_URL } = {}) {
  const local = checkServerJson(manifest);
  if (!local.ok) return local;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "project-room-server-json-check" }
    });
  } catch {
    return { ok: false, errors: [problem("registry_unreachable", "the registry request failed")] };
  }
  if (response.status === 404) return { ok: true, errors: [] };
  if (!response.ok) {
    return { ok: false, errors: [problem("registry_unreachable", `the registry returned HTTP ${response.status}`)] };
  }
  let payload;
  try { payload = await response.json(); }
  catch { return { ok: false, errors: [problem("registry_unreachable", "the registry response was not JSON")] }; }
  return checkVersionIncreases(manifest, payload);
}

function report(result, manifest) {
  if (!result.ok) {
    for (const error of result.errors) console.error(`server.json: ${error.code}: ${error.message}`);
    process.exit(1);
  }
  console.log(`server.json OK ${manifest.name} ${manifest.version}`);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../server.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = process.argv.includes("--against-registry")
    ? await checkAgainstRegistry(manifest)
    : checkServerJson(manifest);
  report(result, manifest);
}
