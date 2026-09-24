// Typed capability registry (integration slice #11): fail-closed semantics.
// Covers: address parsing, batch mixing rejection, manifest validation,
// resolve with suggestions (never silent substitution), search next-actions,
// credits-only quoting. Ported from the workspace prototype's 56-test suite.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SEGMENT_RE,
  SEMVER_RE,
  validateManifest,
  assertValidManifest,
  parseAddress,
  parseBatch,
  compareVersions,
  AddressError,
  RegistryError,
  CapabilityRegistry,
  quote,
  search,
  NEXT_ACTIONS,
} from "../server/capability-registry.mjs";

const ocrManifest = (version = "1.0.0", overrides = {}) => ({
  provider: "acme",
  name: "ocr",
  version,
  title: "Acme OCR",
  description: "Extract text from images and PDFs with layout awareness.",
  inputs: {
    type: "object",
    properties: { imageUrl: { type: "string", format: "uri" } },
    required: ["imageUrl"],
  },
  outputs: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  pricing: { milliCreditsPerCall: 2, freeCallsPerDay: 50 },
  examples: [
    { input: { imageUrl: "https://example.com/a.png" }, output: { text: "hello" } },
  ],
  acceptance: {
    rubric: "Extracted text matches the source at >= 99% character accuracy on the sample set.",
  },
  ...overrides,
});

const newsManifest = (version = "2.0.0", overrides = {}) => ({
  provider: "benzinga",
  name: "news-search",
  version,
  title: "Benzinga News Search",
  description: "Search financial news wires and regulatory filings.",
  inputs: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  outputs: {
    type: "object",
    properties: { articles: { type: "array", items: { type: "object" } } },
  },
  pricing: { milliCreditsPerCall: 5, freeCallsPerDay: 10 },
  acceptance: {
    rubric: "Every article carries a source URL and a publication timestamp.",
  },
  ...overrides,
});

function seeded() {
  const r = new CapabilityRegistry();
  r.register(ocrManifest("1.0.0"));
  r.register(ocrManifest("1.1.0"));
  r.register(newsManifest("2.0.0"));
  return r;
}

// --- segment / semver shape ------------------------------------------------

test("SEGMENT_RE accepts lowercase hyphenated segments", () => {
  assert.match("acme", SEGMENT_RE);
  assert.match("news-search", SEGMENT_RE);
  assert.doesNotMatch("Acme", SEGMENT_RE);
  assert.doesNotMatch("news_search", SEGMENT_RE);
  assert.doesNotMatch("", SEGMENT_RE);
});

test("SEMVER_RE is strict x.y.z", () => {
  assert.match("1.0.0", SEMVER_RE);
  assert.doesNotMatch("1.0", SEMVER_RE);
  assert.doesNotMatch("v1.0.0", SEMVER_RE);
  assert.doesNotMatch("1.0.0-beta", SEMVER_RE);
  assert.doesNotMatch("01.0.0", SEMVER_RE);
});

// --- address parsing --------------------------------------------------------

test("parseAddress parses provider/capability[@version]", () => {
  assert.deepEqual(parseAddress("acme/ocr"), { provider: "acme", name: "ocr", version: "latest" });
  assert.deepEqual(parseAddress("acme/ocr@1.0.0"), { provider: "acme", name: "ocr", version: "1.0.0" });
  assert.deepEqual(parseAddress("acme/ocr@latest"), { provider: "acme", name: "ocr", version: "latest" });
});

test("parseAddress rejects malformed addresses, never guesses", () => {
  for (const bad of [
    "acme", "acme/ocr/extra", "acme/ocr@1.0", "acme/ocr@1.0.0@2",
    "ACME/ocr", "acme/Ocr", "", "  ", "acme/ocr beta", "a/b@c/d",
  ]) {
    assert.throws(() => parseAddress(bad), (e) => e instanceof AddressError && e.code === "bad_address", bad);
  }
  assert.throws(() => parseAddress(null), (e) => e.code === "bad_address");
});

test("parseAddress rejects URLs as addresses", () => {
  for (const url of ["https://example.com/acme/ocr", "http://x/y", "www.acme.com/ocr"]) {
    assert.throws(
      () => parseAddress(url),
      (e) => e instanceof AddressError && e.code === "bad_address" && e.looksLikeUrl === true,
      url,
    );
  }
});

// --- batch parsing: mixed-address rejection ---------------------------------

test("parseBatch rejects a batch containing ANY URL, wholesale", () => {
  assert.throws(
    () => parseBatch(["acme/ocr", "https://example.com/tool"]),
    (e) => e instanceof AddressError && e.code === "mixed_batch",
  );
});

test("parseBatch rejects a batch mixing tool addresses and freeform text", () => {
  assert.throws(
    () => parseBatch(["acme/ocr", "just describe the task"]),
    (e) => e instanceof AddressError && e.code === "mixed_batch",
  );
  // freeform is never coerced: the failure is on mixing, not on the freeform entry
  assert.throws(
    () => parseBatch(["benzinga/news-search", "OCR this image please"]),
    (e) => e.code === "mixed_batch",
  );
});

test("parseBatch rethrows bad_address when NO entry is a valid address", () => {
  assert.throws(
    () => parseBatch(["not an address", "also not"]),
    (e) => e instanceof AddressError && e.code === "bad_address",
  );
});

test("parseBatch accepts a clean all-address batch and rejects empty/non-array", () => {
  const parsed = parseBatch(["acme/ocr", "benzinga/news-search@2.0.0"]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "ocr");
  assert.throws(() => parseBatch([]), (e) => e.code === "bad_address");
  assert.throws(() => parseBatch("acme/ocr"), (e) => e.code === "bad_address");
});

// --- manifest validation: malformed manifests --------------------------------

test("validateManifest accepts a valid manifest and applies defaults", () => {
  const v = validateManifest(newsManifest());
  assert.equal(v.ok, true);
  assert.deepEqual(v.manifest.examples, []);
  assert.equal(v.manifest.category, "benzinga");
  assert.equal(v.manifest.version, "2.0.0");
});

test("validateManifest rejects missing required fields", () => {
  const v = validateManifest({ provider: "acme" });
  assert.equal(v.ok, false);
  for (const f of ["name", "version", "title", "description", "inputs", "outputs", "pricing", "acceptance"]) {
    assert.ok(v.errors.some((e) => e.includes(f)), `missing error for ${f}`);
  }
});

test("validateManifest rejects unknown fields everywhere", () => {
  const m = newsManifest();
  m.wallet = "0x1234"; // money-adjacent field must not sneak in
  m.pricing.usdPerCall = 1;
  m.acceptance.paid = true;
  const v = validateManifest(m);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('"wallet"')));
  assert.ok(v.errors.some((e) => e.includes('"usdPerCall"')));
  assert.ok(v.errors.some((e) => e.includes('"paid"')));
});

test("validateManifest rejects non-strict semver", () => {
  for (const version of ["1.0", "v1.0.0", "1.0.0-beta", "latest"]) {
    const v = validateManifest(newsManifest(version));
    assert.equal(v.ok, false, version);
    assert.ok(v.errors.some((e) => e.includes("version")));
  }
});

test("validateManifest rejects bad pricing (floats, negatives, money-shaped)", () => {
  for (const pricing of [
    { milliCreditsPerCall: 1.5, freeCallsPerDay: 10 },
    { milliCreditsPerCall: -1, freeCallsPerDay: 10 },
    { milliCreditsPerCall: 5 }, // missing freeCallsPerDay
    { freeCallsPerDay: 10 }, // missing milliCreditsPerCall
    "5",
  ]) {
    const v = validateManifest(newsManifest("2.0.0", { pricing }));
    assert.equal(v.ok, false, JSON.stringify(pricing));
  }
});

test("validateManifest rejects unknown JSON Schema keywords", () => {
  const m = newsManifest();
  m.inputs = { type: "object", oneOf: [{ type: "string" }] };
  const v = validateManifest(m);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('"oneOf"')));
});

test("validateManifest rejects schema nesting past depth 8", () => {
  let node = { type: "string" };
  for (let i = 0; i < 10; i++) node = { type: "object", properties: { deep: node } };
  const v = validateManifest(newsManifest("2.0.0", { inputs: node }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("too deep")));
});

test("validateManifest requires the acceptance rubric (the pinned done-definition)", () => {
  const m = newsManifest();
  delete m.acceptance;
  assert.equal(validateManifest(m).ok, false);
  const m2 = newsManifest("2.0.0", { acceptance: { rubric: "   " } });
  const v2 = validateManifest(m2);
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes("acceptance.rubric")));
});

test("validateManifest rejects non-objects", () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
  assert.equal(validateManifest("acme/ocr").ok, false);
});

test("assertValidManifest throws a coded error", () => {
  assert.throws(
    () => assertValidManifest({ provider: "acme" }),
    (e) => e.code === "invalid_manifest" && Array.isArray(e.errors),
  );
  assert.doesNotThrow(() => assertValidManifest(newsManifest()));
});

// --- registry: register / resolve fail-closed --------------------------------

test("register stores the manifest and resolve returns it pinned or latest", () => {
  const r = seeded();
  assert.equal(r.count(), 3);
  const pinned = r.resolve("acme/ocr@1.0.0");
  assert.equal(pinned.ok, true);
  assert.equal(pinned.manifest.version, "1.0.0");
  const latest = r.resolve("acme/ocr");
  assert.equal(latest.ok, true);
  assert.equal(latest.manifest.version, "1.1.0", "bare address resolves the NEWEST registered version");
  assert.equal(r.resolve("acme/ocr@latest").manifest.version, "1.1.0");
});

test("register rejects invalid manifests and duplicate triples", () => {
  const r = new CapabilityRegistry();
  assert.throws(() => r.register({ provider: "acme" }), (e) => e instanceof RegistryError && e.code === "invalid_manifest");
  r.register(ocrManifest("1.0.0"));
  assert.throws(() => r.register(ocrManifest("1.0.0")), (e) => e.code === "duplicate");
  // a new version of the same provider/name is fine
  r.register(ocrManifest("2.0.0"));
  assert.equal(r.count(), 2);
});

test("resolve fails closed on unknown provider with suggestions", () => {
  const r = seeded();
  const res = r.resolve("acm/ocr");
  assert.equal(res.ok, false);
  assert.equal(res.code, "unknown_provider");
  assert.ok(res.suggestions.includes("acme"), "suggests the real provider");
  assert.ok(!("manifest" in res), "no manifest is returned on failure");
});

test("resolve fails closed on unknown capability with provider-scoped suggestions", () => {
  const r = seeded();
  const res = r.resolve("acme/ocrx");
  assert.equal(res.ok, false);
  assert.equal(res.code, "unknown_capability");
  assert.ok(res.suggestions.includes("acme/ocr"));
  assert.ok(res.suggestions.every((s) => s.startsWith("acme/")), "suggestions stay inside the addressed provider");
});

test("resolve never silently substitutes a close-enough capability", () => {
  const r = seeded();
  // A typo'd capability is NOT bound to the closest match — the caller
  // must pick from suggestions and re-issue the address.
  const res = r.resolve("acme/ocrr");
  assert.equal(res.ok, false);
  assert.equal(res.code, "unknown_capability");
  const after = r.resolve("acme/ocr");
  assert.equal(after.ok, true);
  assert.equal(after.manifest.name, "ocr");
});

test("resolve fails closed on unregistered version, listing registered ones", () => {
  const r = seeded();
  const res = r.resolve("acme/ocr@9.9.9");
  assert.equal(res.ok, false);
  assert.equal(res.code, "unknown_capability");
  assert.ok(res.suggestions.includes("acme/ocr@1.0.0"));
  assert.ok(res.suggestions.includes("acme/ocr@1.1.0"));
});

test("resolve returns bad_address for malformed input, never throws", () => {
  const r = seeded();
  for (const bad of ["acme", "https://example.com/x", ""]) {
    const res = r.resolve(bad);
    assert.equal(res.ok, false, bad);
    assert.equal(res.code, "bad_address", bad);
    assert.deepEqual(res.suggestions, []);
  }
});

test("has() mirrors resolve().ok", () => {
  const r = seeded();
  assert.equal(r.has("acme/ocr"), true);
  assert.equal(r.has("acme/nope"), false);
  assert.equal(r.has("nope"), false);
});

test("list() sorts by provider, name, version ascending and filters by category", () => {
  const r = seeded();
  r.register(newsManifest("2.1.0", { category: "finance" }));
  const order = r.list().map((m) => `${m.provider}/${m.name}@${m.version}`);
  assert.deepEqual(order, ["acme/ocr@1.0.0", "acme/ocr@1.1.0", "benzinga/news-search@2.0.0", "benzinga/news-search@2.1.0"]);
  assert.equal(r.list({ category: "finance" }).length, 1);
  assert.equal(r.list({ category: "nope" }).length, 0);
});

test("compareVersions orders strict semver numerically", () => {
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
  assert.ok(compareVersions("1.0.0", "2.0.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

// --- search: {manifest, score, actions} ---------------------------------------

test("search returns {manifest, score, actions} hits sorted by score", () => {
  const r = seeded();
  const hits = search(r, "news");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].manifest.name, "news-search");
  assert.ok(hits[0].score > 0);
  assert.deepEqual(hits[0].actions, ["invoke", "inspect", "watch"]);
  assert.deepEqual(NEXT_ACTIONS, ["invoke", "inspect", "watch"]);
});

test("search scores title hits above description hits and is deterministic", () => {
  const r = seeded();
  r.register(ocrManifest("2.0.0", {
    title: "Acme News OCR",
    description: "ocr for documents",
  }));
  const hits = search(r, "news");
  assert.equal(hits[0].manifest.provider, "benzinga", "title hit outranks name/description hits");
  const again = search(r, "news");
  assert.deepEqual(again.map((h) => h.manifest.version), hits.map((h) => h.manifest.version));
});

test("search respects category filter and limit", () => {
  const r = seeded();
  r.register(newsManifest("2.1.0", { category: "finance" }));
  assert.equal(search(r, "news", { category: "finance" }).length, 1);
  assert.equal(search(r, "news", { category: "finance" })[0].manifest.version, "2.1.0");
  assert.equal(search(r, "news", { category: "other" }).length, 0);
  assert.equal(search(r, "a", { limit: 1 }).length, 1);
});

test("search validates its inputs", () => {
  const r = seeded();
  assert.throws(() => search(null, "x"), TypeError);
  assert.throws(() => search(r, 42), TypeError);
  assert.throws(() => search(r, "x", { limit: 0 }), TypeError);
  assert.deepEqual(search(r, "   "), []);
});

// --- quoting: milli-credits, credits-only -------------------------------------

test("quote prices calls in integer milli-credits after the free tier", () => {
  const q = quote(newsManifest(), 15);
  assert.equal(q.capability, "benzinga/news-search");
  assert.equal(q.version, "2.0.0");
  assert.equal(q.freeCallsApplied, 10);
  assert.equal(q.paidCalls, 5);
  assert.equal(q.totalMilliCredits, 25);
  assert.deepEqual(q.breakdown, [
    { kind: "free", calls: 10, milliCreditsPerCall: 0, subtotalMilliCredits: 0 },
    { kind: "paid", calls: 5, milliCreditsPerCall: 5, subtotalMilliCredits: 25 },
  ]);
});

test("quote consumes the caller's reported freeCallsUsedToday", () => {
  const q = quote(newsManifest(), 15, { freeCallsUsedToday: 7 });
  assert.equal(q.freeCallsRemaining, 3);
  assert.equal(q.freeCallsApplied, 3);
  assert.equal(q.paidCalls, 12);
  assert.equal(q.totalMilliCredits, 60);
});

test("quote is exact integer arithmetic — no floats, no money fields", () => {
  const m = ocrManifest("1.0.0", { pricing: { milliCreditsPerCall: 3, freeCallsPerDay: 0 } });
  const q = quote(m, 100000);
  assert.equal(q.totalMilliCredits, 300000);
  assert.ok(Number.isInteger(q.totalMilliCredits));
  const json = JSON.stringify(q);
  assert.ok(!/usd|dollar|wallet|chain|tx/i.test(json), "quote carries no money/wallet/chain references");
});

test("quote handles zero calls and exhausted free tiers", () => {
  const zero = quote(newsManifest(), 0);
  assert.equal(zero.totalMilliCredits, 0);
  const exhausted = quote(newsManifest(), 4, { freeCallsUsedToday: 999 });
  assert.equal(exhausted.freeCallsApplied, 0);
  assert.equal(exhausted.paidCalls, 4);
  assert.equal(exhausted.totalMilliCredits, 20);
});

test("quote rejects bad inputs", () => {
  assert.throws(() => quote(null, 1), TypeError);
  assert.throws(() => quote({ pricing: null }, 1), TypeError);
  assert.throws(() => quote(newsManifest(), -1), TypeError);
  assert.throws(() => quote(newsManifest(), 1.5), TypeError);
  assert.throws(() => quote(newsManifest(), 1, { freeCallsUsedToday: -1 }), TypeError);
});
