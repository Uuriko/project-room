// File version history (K027). A pure version tracker for room files:
// record versions (with content hashes), list history, and diff metadata
// between versions. File bytes are caller-owned; this module tracks only
// metadata. All state is caller-owned (a Map); the module is pure and
// dependency-free. Frozen outputs; malformed inputs throw VersionError.
// Storage/UI wiring is a later slice.
class VersionError extends Error { constructor(code, message) { super(message); this.name = "VersionError"; this.code = code; } }
const fail = (code, message) => { throw new VersionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_version", message); };
// Create a version manager. store is a caller-owned Map (fileId -> versions[]).
export function createVersions({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const files = store ?? new Map();
  const versionsFor = fileId => {
    check(typeof fileId === "string" && fileId.length > 0, "fileId must be a non-empty string");
    if (!files.has(fileId)) files.set(fileId, []);
    return files.get(fileId);
  };
  // Record a new version.
  const record = ({ fileId, contentHash, sizeBytes, authorId, note }) => {
    const versions = versionsFor(fileId);
    check(typeof contentHash === "string" && contentHash.length > 0,
      "contentHash must be a non-empty string");
    check(Number.isInteger(sizeBytes) && sizeBytes >= 0, "sizeBytes must be a non-negative integer");
    check(typeof authorId === "string" && authorId.length > 0, "authorId must be a non-empty string");
    check(note === undefined || typeof note === "string", "note must be a string if given");
    const version = Object.freeze({ fileId, version: versions.length + 1,
      contentHash, sizeBytes, authorId, note: note ?? "",
      // The caller supplies createdAt for determinism; default is not allowed.
    });
    versions.push(version);
    return version;
  };
  // List versions newest-first.
  const history = fileId => Object.freeze([...versionsFor(fileId)].reverse());
  // Get a specific version.
  const get = (fileId, versionNumber) => {
    const versions = versionsFor(fileId);
    check(Number.isInteger(versionNumber) && versionNumber >= 1 && versionNumber <= versions.length,
      `version ${versionNumber} not found for file "${fileId}"`);
    return versions[versionNumber - 1];
  };
  // Diff metadata between two versions.
  const diffMeta = (fileId, { from, to }) => {
    const fromV = get(fileId, from);
    const toV = get(fileId, to);
    return Object.freeze({ fileId, from, to,
      hashChanged: fromV.contentHash !== toV.contentHash,
      sizeDelta: toV.sizeBytes - fromV.sizeBytes });
  };
  return Object.freeze({ record, history, get, diffMeta });
}
export { VersionError };
