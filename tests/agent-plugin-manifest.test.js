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
  assert.deepEqual(flows, ["agent-room-create", "identity-create", "invite-redeem", "join-request"]);
  for (const f of manifest.enrollment.flows) assert.ok(Array.isArray(f.steps) && f.steps.length > 0);
  // permission profiles match the documented standing profiles
  assert.deepEqual(manifest.enrollment.permissionProfiles.chat, "read-only");
  // transports name the wire modules
  assert.ok(manifest.transports.a2a && manifest.transports.mcp && manifest.transports.webhook);
  assert.equal(manifest.directory.url, `${ORIGIN}/api/agents/directory`);
  // RC-2026-09-19-061: the manifest is an agent's first fetch — every field
  // must be true. Rate limit must match the enforced value in
  // server/http.mjs (identity-create route); the join-request owner step
  // must name the real /decide endpoint; webhook transport must not claim
  // outbound delivery that isn't wired.
  assert.equal(manifest.rateLimits.identityCreatePerIpPerHour, 30);
  const accessFlow = manifest.enrollment.flows.find(f => f.id === "join-request");
  assert.ok(accessFlow.steps.some(s => s.includes("join-decide")), `steps: ${accessFlow.steps.join(", ")}`);
  assert.ok(!/outbound event delivery/i.test(manifest.transports.webhook.description));
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

test("manifest documents the API-key scope vocabulary and it matches enforcement (RC-2026-09-18-019)", async t => {
  const { buildPluginManifest, validatePluginManifest } = await import("../server/agent-plugin-manifest.mjs");
  const { API_KEY_SCOPES } = await import("../server/agent-api-keys.mjs");
  const manifest = buildPluginManifest({ serviceOrigin: "https://room.example" });
  assert.equal(validatePluginManifest(manifest), true);
  // the vocabulary is present, described, and non-empty
  const vocab = manifest.auth.apiKeyScopes;
  assert.ok(Array.isArray(vocab.scopes) && vocab.scopes.length > 0);
  assert.deepEqual(vocab.scopes.map(s => s.scope).sort(), API_KEY_SCOPES.map(s => s.scope).sort());
  for (const entry of vocab.scopes) {
    assert.ok(entry.description && entry.description.length > 0, `${entry.scope} has a description`);
    assert.ok(Array.isArray(entry.routes) && entry.routes.length > 0, `${entry.scope} names its routes`);
  }
  assert.ok(typeof vocab.wildcard === "string" && vocab.wildcard.includes(":*"));
  // stripping the vocabulary fails validation: it is a required field
  assert.throws(() => validatePluginManifest({ ...manifest, auth: { schemes: manifest.auth.schemes } }),
    /apiKeyScopes/);
});
