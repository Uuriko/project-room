// VL-2a GitHub App core. No route is mounted; these tests call the library.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appJwt, githubAppCredentials, installationToken } from "../server/github-app/auth.mjs";
import { MANIFEST_EVENTS, MANIFEST_PERMISSIONS, MANIFEST_SETUP_URL, MANIFEST_WEBHOOK_URL } from "../server/github-app/index.mjs";
import { shouldPost } from "../server/github-app/policy.mjs";
import { renderPrComment } from "../server/github-app/render.mjs";
import { fetchRepoConfig, parseRepoConfig } from "../server/github-app/repo-config.mjs";
import { parseEvent, verifyWebhook, WEBHOOK_BODY_LIMIT } from "../server/github-app/verify.mjs";

const TURN_OFF = "https://github.com/Uuriko/project-room/blob/main/docs/GITHUB-APP.md#turn-it-off";
const START = "https://room.trydemigod.com/start?from=pr:0123456789abcdef";
const FOOTER = `<sub>Coordinated in Project Room · [Use Room for your repo](${START}) · [Turn off](${TURN_OFF})</sub>`;

function markerFor(id) {
  return `<!-- project-room:claim:${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32)} -->`;
}

function claimFixture() {
  return {
    id: "claim-1",
    roomId: "room-1",
    title: "Ship the receipt",
    state: "done",
    note: "private note",
    agent: { displayName: "Ada" },
    pullRequest: { url: "https://github.com/acme/app/pull/4", ci: { status: "passing" } },
    review: { state: "approved" },
    memberLogins: ["octocat"],
  };
}

function renderOptions(extra = {}) {
  return {
    reviewUrl: "https://room.trydemigod.com/c/tok",
    startUrl: START,
    env: {},
    ...extra,
  };
}

async function signature(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `sha256=${Buffer.from(mac).toString("hex")}`;
}

function strictResponse({ status = 200, body = "", headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const target = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    async text() { return text; },
    async json() { return JSON.parse(text); },
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (Object.prototype.hasOwnProperty.call(obj, prop)) {
        const value = obj[prop];
        return typeof value === "function" ? value.bind(obj) : value;
      }
      throw new Error(`response stub has no ${String(prop)}`);
    },
  });
}

test("the shared manifest matches the permissions and URLs later GitHub App slices reuse", () => {
  const manifest = JSON.parse(readFileSync(new URL("../github-app/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.default_permissions, { ...MANIFEST_PERMISSIONS });
  assert.deepEqual(manifest.default_events, [...MANIFEST_EVENTS]);
  assert.equal(manifest.setup_url, MANIFEST_SETUP_URL);
  assert.equal(manifest.redirect_url, MANIFEST_SETUP_URL);
  assert.equal(manifest.hook_attributes.url, MANIFEST_WEBHOOK_URL);
  assert.equal(manifest.request_oauth_on_install, true);
});

test("webhook signature accepts a matching body and refuses tampering, the wrong secret, a missing header, and an oversized body", async () => {
  const secret = "hook-secret";
  const body = new TextEncoder().encode('{"zen":"ok"}');
  const header = await signature(secret, body);
  assert.deepEqual(await verifyWebhook({ rawBody: body, signature256: header, secret }), { ok: true });
  const tampered = new Uint8Array(body);
  tampered[0] ^= 0xff;
  assert.equal((await verifyWebhook({ rawBody: tampered, signature256: header, secret })).ok, false);
  assert.equal((await verifyWebhook({ rawBody: body, signature256: await signature("other-secret", body), secret })).reason, "mismatch");
  assert.equal((await verifyWebhook({ rawBody: body, signature256: "", secret })).reason, "missing_signature");
  assert.equal((await verifyWebhook({ rawBody: body, signature256: undefined, secret })).reason, "missing_signature");
  const oversized = new Uint8Array(WEBHOOK_BODY_LIMIT + 1);
  assert.equal((await verifyWebhook({ rawBody: oversized, signature256: header, secret })).reason, "oversize");
  const exact = new Uint8Array(WEBHOOK_BODY_LIMIT);
  assert.equal((await verifyWebhook({ rawBody: exact, signature256: await signature(secret, exact), secret })).ok, true);
});

test("parseEvent keeps the four App events and ignores the rest", () => {
  const headers = new Headers({ "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": "delivery-1" });
  const parsed = parseEvent(headers, JSON.stringify({ action: "closed", pull_request: { merged: true } }));
  assert.equal(parsed.ignored, false);
  assert.equal(parsed.event, "pull_request");
  assert.equal(parsed.delivery, "delivery-1");
  assert.equal(parsed.action, "closed");
  assert.equal(parsed.payload.pull_request.merged, true);
  for (const event of ["check_suite", "installation", "installation_repositories"]) {
    assert.equal(parseEvent({ "X-GitHub-Event": event }, { action: "created" }).ignored, false);
  }
  assert.equal(parseEvent({ "X-GitHub-Event": "push" }, "{}").ignored, true);
  assert.equal(parseEvent({ "X-GitHub-Event": "pull_request" }, "{").reason, "invalid_json");
});

test("App JWT carries RS256 claims with the 60 second and 9 minute window", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_700_000_000_000;
  for (const type of ["pkcs8", "pkcs1"]) {
    const pem = privateKey.export({ type, format: "pem" });
    const token = await appJwt({ appId: "12345", privateKeyPem: pem, now });
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    assert.equal(header.alg, "RS256");
    assert.equal(payload.iss, "12345");
    assert.equal(payload.iat, Math.floor(now / 1000) - 60);
    assert.equal(payload.exp, Math.floor(now / 1000) + 9 * 60);
    const key = await crypto.subtle.importKey(
      "spki",
      publicKey.export({ type: "spki", format: "der" }),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(encodedSignature, "base64url"), signed);
    assert.equal(verified, true);
  }
});

test("an invalid private key is refused without echoing the key", async () => {
  const junk = "not-a-pem-key";
  await assert.rejects(
    () => appJwt({ appId: "12345", privateKeyPem: junk, now: 1_700_000_000_000 }),
    error => error.code === "invalid_key" && !error.message.includes(junk),
  );
});

test("installation tokens are cached until five minutes before expiry", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    GITHUB_APP_ID: "99",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    GITHUB_APP_WEBHOOK_SECRET: "hook-secret",
  };
  const cache = new Map();
  let calls = 0;
  let clock = Date.parse("2026-10-02T11:00:00.000Z");
  const fetchFn = async (url, init) => {
    calls += 1;
    assert.equal(url, "https://api.github.com/app/installations/42/access_tokens");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(typeof init.headers.Authorization, "string");
    assert.equal(init.headers.Authorization.startsWith("Bearer "), true);
    return strictResponse({
      status: 201,
      body: { token: `inst-${calls}`, expires_at: "2026-10-02T12:00:00.000Z" },
    });
  };
  assert.equal(await installationToken("42", { env, fetchFn, now: () => clock, cache }), "inst-1");
  clock = Date.parse("2026-10-02T11:54:00.000Z");
  assert.equal(await installationToken("42", { env, fetchFn, now: () => clock, cache }), "inst-1");
  assert.equal(calls, 1);
  clock = Date.parse("2026-10-02T11:55:00.000Z");
  assert.equal(await installationToken("42", { env, fetchFn, now: () => clock, cache }), "inst-2");
  assert.equal(calls, 2);
});

test("missing GitHub App credentials stay inert and do not call GitHub", async () => {
  assert.equal(githubAppCredentials({}), null);
  assert.equal(githubAppCredentials({ GITHUB_APP_ID: "12", GITHUB_APP_PRIVATE_KEY: "x" }), null);
  let called = false;
  await assert.rejects(
    () => installationToken("42", { env: {}, fetchFn() { called = true; }, cache: new Map() }),
    error => error.code === "not_configured",
  );
  assert.equal(called, false);
});

test("comment modes match the receipt text, stay within 2500 characters, and omit private text in minimal mode", () => {
  const claim = claimFixture();
  const room = { title: "Secret room title", purpose: "internal plan" };
  const receipt = { url: "https://room.trydemigod.com/receipts/wcr_abc", summary: "Merged and green" };
  const marker = markerFor("claim-1");
  const full = renderPrComment(claim, room, receipt, renderOptions({ mode: "full", variant: "bottom" }));
  assert.equal(full, [
    "**Project Room** · Ship the receipt",
    "Claimed by **Ada** · done · CI passing · Review approved",
    "Merged and green",
    "[Review in Room](https://room.trydemigod.com/c/tok) · [Receipt](https://room.trydemigod.com/receipts/wcr_abc)",
    FOOTER,
    marker,
  ].join("\n"));
  const top = renderPrComment(claim, room, receipt, renderOptions({ mode: "full", variant: "top" }));
  assert.equal(top.split("\n")[1], FOOTER);
  const minimal = renderPrComment(claim, room, receipt, renderOptions({ mode: "minimal", variant: "bottom" }));
  assert.equal(minimal, [
    "Claimed by **Ada** · done · CI passing · Review approved",
    "[Receipt](https://room.trydemigod.com/receipts/wcr_abc)",
    FOOTER,
    marker,
  ].join("\n"));
  for (const hidden of ["Secret room title", "private note", "internal plan", "Ship the receipt", "Merged and green"]) {
    assert.equal(minimal.includes(hidden), false, hidden);
  }
  const check = renderPrComment(claim, room, receipt, renderOptions({ mode: "check", variant: "bottom" }));
  assert.equal(check.title, "Project Room · done");
  assert.equal(check.summary.includes(marker), true);
  assert.equal(check.summary.includes("Secret room title"), false);
  assert.equal(check.summary.includes("private note"), false);
  assert.ok(full.length <= 2500 && minimal.length <= 2500 && check.summary.length <= 2500);
  const long = renderPrComment(claim, room, receipt, renderOptions({
    mode: "full",
    variant: "bottom",
    reviewUrl: `https://example.com/${"a".repeat(2400)}`,
  }));
  assert.ok(long.length <= 2500);
  assert.equal(long.endsWith(marker), true);
});

test("unsafe agent names are replaced and a forced footer arm moves the footer", () => {
  const claim = claimFixture();
  const hidden = renderPrComment(
    { ...claim, agent: { displayName: "Ada\u0001" } },
    {},
    null,
    renderOptions({ mode: "minimal", variant: "bottom" }),
  );
  assert.equal(hidden.includes("**Agent**"), true);
  assert.equal(hidden.includes("Ada"), false);
  const reserved = renderPrComment(
    { ...claim, agent: { displayName: "admin" } },
    {},
    null,
    renderOptions({ mode: "minimal", variant: "bottom" }),
  );
  assert.equal(reserved.includes("**Agent**"), true);
  const forced = renderPrComment(claim, {}, { url: "https://room.trydemigod.com/receipts/wcr_abc" }, renderOptions({
    mode: "minimal",
    env: { GROWTH_FORCE_ARMS: "pr_footer_placement:top" },
  }));
  assert.ok(forced.indexOf("<sub>") < forced.indexOf("[Receipt]"));
  const quiet = renderPrComment(claim, {}, { url: "https://room.trydemigod.com/receipts/wcr_abc", summary: "Merged and green" }, renderOptions({
    mode: "full",
    variant: "bottom",
    reviewLink: false,
  }));
  assert.equal(quiet.includes("Review in Room"), false);
});

test("policy refuses each blocked case, caps new comments at 200, and edits an existing marker", () => {
  const base = {
    installation: { id: "9", roomIds: ["room-1"] },
    repo: { visibility: "public" },
    pr: { url: "https://github.com/acme/app/pull/4", fromFork: false, authorLogin: "octocat", commentBody: "" },
    claim: claimFixture(),
    config: { ok: true, receipts: null, reviewLink: null },
    postsToday: 0,
  };
  const decide = (patch = {}) => shouldPost({
    ...base,
    ...patch,
    pr: { ...base.pr, ...patch.pr },
    claim: patch.claim === null ? null : { ...base.claim, ...patch.claim },
    repo: { ...base.repo, ...patch.repo },
    config: patch.config === undefined ? base.config : patch.config,
  });
  assert.deepEqual(decide(), { post: true, action: "create", mode: "minimal", reason: null, marker: markerFor("claim-1") });
  assert.equal(decide({ repo: { visibility: "private" } }).mode, "full");
  assert.equal(decide({ config: { ok: true, receipts: "check", reviewLink: true } }).mode, "check");
  assert.equal(decide({ claim: null }).reason, "not_linked");
  assert.equal(decide({ pr: { url: "https://github.com/acme/app/pull/9" } }).reason, "not_linked");
  assert.equal(decide({ installation: { id: "9", roomIds: ["room-2"] } }).reason, "installation_mismatch");
  assert.equal(decide({ config: { ok: true, receipts: "off", reviewLink: null } }).reason, "receipts_off");
  assert.equal(decide({ config: { ok: false, reason: "too_large", receipts: null, reviewLink: null } }).reason, "config_too_large");
  assert.equal(decide({ pr: { fromFork: true, authorLogin: "stranger" } }).reason, "fork_non_member");
  assert.equal(decide({ pr: { fromFork: true, authorLogin: "OctoCat" } }).action, "create");
  assert.equal(decide({ pr: { fromFork: false, authorLogin: "stranger" } }).action, "create");
  assert.equal(decide({ postsToday: 199 }).action, "create");
  assert.equal(decide({ postsToday: 200 }).reason, "daily_cap");
  assert.equal(decide({ postsToday: 200, pr: { commentBody: markerFor("claim-1") } }).action, "edit");
  assert.equal(decide({ pr: { commentBody: markerFor("other-claim") } }).action, "edit");
  assert.equal(decide({ postsToday: 1.5 }).reason, "invalid_budget");
});

test("repo config parses the known keys, ignores unknown keys, and enforces the 64 KB cap", async () => {
  const parsed = parseRepoConfig("receipts: full\nreview_link: false\nextra: 1\n# comment\n");
  assert.deepEqual(parsed, { ok: true, receipts: "full", reviewLink: false });
  assert.equal(parseRepoConfig('receipts: "minimal"\nreview_link: true\n').receipts, "minimal");
  assert.equal(parseRepoConfig("receipts: sometimes\n").receipts, null);
  const exact = `${"\n".repeat(64 * 1024)}`;
  assert.equal(parseRepoConfig(exact).ok, true);
  assert.equal(parseRepoConfig(`${exact} `).reason, "too_large");

  const seen = [];
  const missing = await fetchRepoConfig({
    owner: "acme",
    repo: "app",
    token: "inst-token",
    fetchFn: async (url, init) => {
      seen.push({ url, redirect: init.redirect, authorization: init.headers.Authorization });
      return strictResponse({ status: 404, body: "" });
    },
  });
  assert.equal(missing.source, "missing");
  assert.equal(seen[0].url, "https://api.github.com/repos/acme/app/contents/.github/project-room.yml");
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[0].authorization, "Bearer inst-token");
  const capped = await fetchRepoConfig({
    owner: "acme",
    repo: "app",
    token: "inst-token",
    fetchFn: async () => strictResponse({ status: 200, body: "receipts: full\n", headers: { "content-length": String(64 * 1024 + 1) } }),
  });
  assert.equal(capped.reason, "too_large");
  await assert.rejects(
    () => fetchRepoConfig({
      owner: "acme",
      repo: "app",
      token: "inst-token",
      fetchFn: async () => strictResponse({ status: 500, body: "inst-token" }),
    }),
    error => error.code === "config_failed" && !error.message.includes("inst-token"),
  );
});
