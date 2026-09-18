import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPluginManifest, validatePluginManifest, ManifestError, MANIFEST_VERSION, WELL_KNOWN_PATH,
} from "../server/agent-plugin-manifest.mjs";

const ORIGIN = "https://room.example";

test("build emits a complete frozen manifest", t => {
  const manifest = buildPluginManifest({ serviceOrigin: ORIGIN, roomId: "commons", clock: () => 1234 });
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.equal(manifest.generatedAt, 1234);
  assert.equal(manifest.service.origin, ORIGIN);
  assert.equal(manifest.service.roomId, "commons");
  assert.equal(WELL_KNOWN_PATH, "/.well-known/agent-plugin-manifest.json");
  assert.ok(Object.isFrozen(manifest));
  // every auth scheme names a header or format the agent can use
  for (const s of manifest.auth.schemes) assert.ok(s.scheme && s.scheme.length > 0);
  // all three enrollment flows documented
  const flows = manifest.enrollment.flows.map(f => f.id).sort();
  assert.deepEqual(flows, ["access-request", "identity-create", "invite-redeem"]);
  for (const f of manifest.enrollment.flows) assert.ok(Array.isArray(f.steps) && f.steps.length > 0);
  // permission profiles match the documented standing profiles
  assert.deepEqual(manifest.enrollment.permissionProfiles.chat, "read-only");
  // transports name the wire modules
  assert.ok(manifest.transports.a2a && manifest.transports.mcp && manifest.transports.webhook);
  assert.equal(manifest.directory.url, `${ORIGIN}/api/agents/directory`);
  assert.ok(typeof manifest.rateLimits.identityCreatePerIpPerHour === "number");
  assert.ok(typeof manifest.docs.guide === "string");
});

test("manifest validates round-trip", t => {
  const manifest = buildPluginManifest({ serviceOrigin: ORIGIN });
  assert.equal(manifest.service.roomId, null); // room-agnostic by default
  assert.equal(validatePluginManifest(manifest), true);
  // a tampered manifest fails validation
  assert.throws(() => validatePluginManifest(null), ManifestError);
  assert.throws(() => validatePluginManifest({}), ManifestError);
  assert.throws(() => validatePluginManifest({ ...manifest, version: "0.0.1" }), ManifestError);
  assert.throws(() => validatePluginManifest({
    ...manifest, service: { origin: "http://insecure.example" },
  }), ManifestError);
  assert.throws(() => validatePluginManifest({ ...manifest, auth: { schemes: [] } }), ManifestError);
  assert.throws(() => validatePluginManifest({ ...manifest, enrollment: { flows: [] } }), ManifestError);
  assert.throws(() => validatePluginManifest({ ...manifest, directory: {} }), ManifestError);
});

test("build rejects non-https origins and bad room ids", t => {
  assert.throws(() => buildPluginManifest({ serviceOrigin: "http://x.example" }), ManifestError);
  assert.throws(() => buildPluginManifest({}), ManifestError);
  assert.throws(() => buildPluginManifest({ serviceOrigin: ORIGIN, roomId: "" }), ManifestError);
  assert.throws(() => buildPluginManifest({ serviceOrigin: ORIGIN, clock: "nope" }), ManifestError);
});
