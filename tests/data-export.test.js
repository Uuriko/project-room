// F015 — tests for src/data-export.mjs.
//
// Covers manifest correctness (pinned clock: exported_at, format_version,
// section list, per-section item counts), JSON round-trip validity,
// secret redaction (key-name tokens at any depth, PEM-shaped values, no
// mutation of the input snapshot), section filtering, and empty / partial /
// malformed / cyclic / throwing inputs. Deterministic: every
// time-dependent assertion pins `now` explicitly.

import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_FORMAT_VERSION,
  REDACTED,
  KNOWN_SECTIONS,
  scrubSnapshot,
  sectionItemCount,
  exportData,
  exportJson,
} from "../src/data-export.mjs";

const PINNED_NOW = 1_757_999_999_000; // 2026-09-16T04:33:19.000Z
const PINNED_ISO = new Date(PINNED_NOW).toISOString();
const now = () => PINNED_NOW;

// Obviously-fake fixture secrets. If any of these ever appears in an
// exported document, the export leaked.
const FIXTURES = {
  passwordHash: "fake-pw-hash-001",
  apiToken: "fake-api-token-002",
  sessionToken: "fake-session-003",
  clientSecret: "fake-client-secret-004",
  credential: "fake-credential-005",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END PRIVATE KEY-----",
};

const snapshot = () => ({
  profile: {
    name: "Ada",
    email: "ada@example.com",
    passwordHash: FIXTURES.passwordHash,
    apiToken: FIXTURES.apiToken,
    notes: { author: "Ada", memo: "not a secret" },
  },
  settings: {
    theme: "dark",
    notifications: true,
    sessionToken: FIXTURES.sessionToken,
    integrations: [{ name: "x", clientSecret: FIXTURES.clientSecret }],
  },
  activity: [
    { id: "a1", type: "room.join", actor: "ada", credential: FIXTURES.credential },
    { id: "a2", type: "room.post", actor: "ada" },
  ],
  custom: { anything: "goes", monkey: "not a key", keyboard: "also fine" },
});

test("manifest: pinned exported_at, format version, sections, and counts", () => {
  const doc = exportData({ data: snapshot(), now });
  assert.equal(doc.manifest.format_version, EXPORT_FORMAT_VERSION);
  assert.equal(doc.manifest.exported_at, PINNED_ISO);
  assert.deepEqual(doc.manifest.sections, ["profile", "settings", "activity", "custom"]);
  assert.deepEqual(doc.manifest.counts, { profile: 5, settings: 4, activity: 2, custom: 3 });
  assert.deepEqual(doc.manifest.errors, []);
  assert.ok(Object.isFrozen(doc));
});

test("exportData accepts a collect() function and freezes nothing it was given", () => {
  const input = snapshot();
  const before = JSON.parse(JSON.stringify(input));
  const doc = exportData({ collect: () => input, now });
  assert.deepEqual(doc.manifest.sections, ["profile", "settings", "activity", "custom"]);
  // The caller's snapshot is never mutated by scrubbing.
  assert.deepEqual(input, before);
});

test("exportJson round-trips: parse(stringify(doc)) deep-equals the document", () => {
  const doc = exportData({ data: snapshot(), now });
  const json = exportJson({ data: snapshot(), now });
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(doc)));
  // Pretty-printed for a human download.
  assert.ok(json.includes("\n"));
});

test("exportJson accepts a ready-built document via { document }", () => {
  const doc = exportData({ data: snapshot(), now });
  assert.equal(exportJson({ document: doc }), JSON.stringify(doc, null, 2));
});

test("secrets are redacted at every depth and never appear in the JSON", () => {
  const doc = exportData({ data: snapshot(), now });
  const json = exportJson({ data: snapshot(), now });
  assert.equal(doc.data.profile.passwordHash, REDACTED);
  assert.equal(doc.data.profile.apiToken, REDACTED);
  assert.equal(doc.data.settings.sessionToken, REDACTED);
  assert.equal(doc.data.settings.integrations[0].clientSecret, REDACTED);
  assert.equal(doc.data.activity[0].credential, REDACTED);
  for (const secret of Object.values(FIXTURES)) {
    assert.ok(!json.includes(secret), `leaked secret: ${secret.slice(0, 12)}…`);
  }
  // Non-secret fields survive untouched.
  assert.equal(doc.data.profile.name, "Ada");
  assert.equal(doc.data.profile.email, "ada@example.com");
  assert.equal(doc.data.settings.theme, "dark");
  assert.equal(doc.data.activity[1].type, "room.post");
});

test("secret-like key tokens across naming styles; innocent keys survive", () => {
  const scrubbed = scrubSnapshot({
    password: "x", passwd: "x", pwd: "x", passPhrase: "x",
    api_key: "x", apiKey: "x", "X-API-KEY": "x",
    clientSecret: "x", access_token: "x", refreshToken: "x",
    privateKey: "x", bearer: "x", sessionId: "x", jwt: "x",
    cookie: "x", set_cookie: "x", totpSecret: "x", salt: "x",
    // Innocent keys: substrings of secret words must not match.
    author: "Ada", authenticated: true, monkey: "m", keyboard: "k",
    passports: "p", tokens: "t",
    publicNotes: "visible",
  });
  for (const key of Object.keys(scrubbed)) {
    if (["author", "authenticated", "monkey", "keyboard", "passports", "tokens", "publicNotes"].includes(key)) {
      assert.notEqual(scrubbed[key], REDACTED, `innocent key redacted: ${key}`);
    } else {
      assert.equal(scrubbed[key], REDACTED, `secret key missed: ${key}`);
    }
  }
});

test("PEM private-key values are redacted even under innocent key names", () => {
  const scrubbed = scrubSnapshot({ backup: FIXTURES.privateKeyPem, note: "plain text" });
  assert.equal(scrubbed.backup, REDACTED);
  assert.equal(scrubbed.note, "plain text");
});

test("empty data yields an empty export with a valid manifest", () => {
  const doc = exportData({ data: {}, now });
  assert.deepEqual(doc.manifest.sections, []);
  assert.deepEqual(doc.manifest.counts, {});
  assert.deepEqual(doc.data, {});
  assert.equal(doc.manifest.exported_at, PINNED_ISO);
});

test("partial data exports only the sections present", () => {
  const doc = exportData({ data: { profile: { name: "Ada" } }, now });
  assert.deepEqual(doc.manifest.sections, ["profile"]);
  assert.deepEqual(doc.manifest.counts, { profile: 1 });
  assert.deepEqual(doc.data, { profile: { name: "Ada" } });
});

test("sections option filters to the requested sections in the requested order", () => {
  const doc = exportData({ data: snapshot(), sections: ["activity", "profile"], now });
  assert.deepEqual(doc.manifest.sections, ["activity", "profile"]);
  assert.deepEqual(Object.keys(doc.data), ["activity", "profile"]);
  // Unknown section names are skipped, not invented.
  const doc2 = exportData({ data: snapshot(), sections: ["nope"], now });
  assert.deepEqual(doc2.manifest.sections, []);
});

test("known sections are the documented profile/settings/activity domains", () => {
  assert.deepEqual([...KNOWN_SECTIONS], ["profile", "settings", "activity"]);
});

test("sectionItemCount: arrays, objects, scalars, and missing values", () => {
  assert.equal(sectionItemCount([1, 2, 3]), 3);
  assert.equal(sectionItemCount({ a: 1, b: 2 }), 2);
  assert.equal(sectionItemCount("scalar"), 1);
  assert.equal(sectionItemCount(42), 1);
  assert.equal(sectionItemCount(null), 0);
  assert.equal(sectionItemCount(undefined), 0);
});

test("non-object section values export as-is with count 1; null counts 0", () => {
  const doc = exportData({ data: { profile: null, settings: "flat" }, now });
  assert.deepEqual(doc.manifest.sections, ["profile", "settings"]);
  assert.deepEqual(doc.manifest.counts, { profile: 0, settings: 1 });
  assert.equal(doc.data.profile, null);
  assert.equal(doc.data.settings, "flat");
});

test("a throwing collect() never throws: the error lands in manifest.errors", () => {
  const doc = exportData({ collect: () => { throw new Error("db down"); }, now });
  assert.deepEqual(doc.manifest.sections, []);
  assert.deepEqual(doc.manifest.errors, ["db down"]);
});

test("malformed inputs degrade instead of throwing", () => {
  assert.doesNotThrow(() => exportData());
  assert.doesNotThrow(() => exportData(null));
  assert.doesNotThrow(() => exportData({ data: "nope" }));
  assert.doesNotThrow(() => exportData({ data: [1, 2] }));
  assert.doesNotThrow(() => exportJson(null));
  const doc = exportData({ data: "nope", now });
  assert.deepEqual(doc.manifest.sections, []);
  assert.ok(doc.manifest.errors.length > 0);
  const doc2 = exportData({ collect: () => 42, now });
  assert.deepEqual(doc2.manifest.sections, []);
  assert.ok(doc2.manifest.errors.length > 0);
});

test("cyclic inputs terminate: repeated references reuse the scrubbed clone", () => {
  const cyclic = { name: "Ada", password: FIXTURES.passwordHash };
  cyclic.self = cyclic;
  cyclic.list = [cyclic];
  const doc = exportData({ data: { profile: cyclic }, now });
  assert.equal(doc.data.profile.password, REDACTED);
  assert.equal(doc.data.profile.self, doc.data.profile);
  assert.equal(doc.data.profile.list[0], doc.data.profile);
  // Original untouched.
  assert.equal(cyclic.password, FIXTURES.passwordHash);
});
