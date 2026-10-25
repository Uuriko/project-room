// DOOR-CURE-2 (stranger-door D1 rows 4-5): browser navigations to the
// auth surface get a readable HTML page for the evidenced failure shapes
// (404 unknown provider, 405 wrong method, 403 missing Origin, 503
// unconfigured provider); API clients keep the JSON envelope byte-for-byte,
// and non-auth API paths keep the envelope for browsers too.
//
// Unit tests pin server/auth-error-page.mjs; HTTP integration tests boot
// the real server with no OAuth providers configured (the production
// stranger posture for GitHub) and drive it with raw node:http so the
// Accept/Origin headers are exactly what each case says — fetch would
// add its own.
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { authErrorPage, authErrorHtmlApplies, isAuthErrorPath, AUTH_ERROR_HTML_STATUSES } from "../server/auth-error-page.mjs";
import { GITHUB_START_PATH, GITHUB_CALLBACK_PATH } from "../server/github-oauth.mjs";

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function call(origin, path, { method = "GET", accept, headers = {} } = {}) {
  const url = new URL(path, origin);
  return new Promise((resolve, rejectPromise) => {
    const req = httpRequest({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: { ...(accept ? { Accept: accept } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

async function startServer(t, options = {}) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// ---------- unit: the negotiation decision and the page shape ----------

test("authErrorHtmlApplies covers only the evidenced auth shapes", () => {
  assert.deepEqual([...AUTH_ERROR_HTML_STATUSES].sort(), [403, 404, 405, 503]);
  for (const status of [403, 404, 405, 503]) {
    assert.equal(authErrorHtmlApplies("/api/auth/github/start", status), true, String(status));
    assert.equal(authErrorHtmlApplies("/api/auth", status), true, String(status));
  }
  for (const status of [400, 401, 409, 422, 429, 500]) {
    assert.equal(authErrorHtmlApplies("/api/auth/github/start", status), false, String(status));
  }
  assert.equal(authErrorHtmlApplies("/api/rooms/r1", 404), false);
  assert.equal(authErrorHtmlApplies("/api/authx", 404), false);
  assert.equal(authErrorHtmlApplies(null, 404), false);
  assert.equal(isAuthErrorPath("/room/api/auth/github/start"), false,
    "the caller passes the pathname after the /room prefix rewrite");
});

test("authErrorPage renders a readable escaped page with a way back", () => {
  const html = authErrorPage({ status: 404, code: "not_found", message: "Not found", hint: "Re-list the resource" });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("That sign-in link does not exist"));
  assert.ok(html.includes("Not found"));
  assert.ok(html.includes("Re-list the resource"));
  assert.ok(html.includes("Error: not_found"));
  assert.ok(html.includes('<a href="/?account=1">Back to sign-in</a>'));
  const evil = authErrorPage({ status: 503, code: null, message: "<script>alert(1)</script>", hint: null });
  assert.ok(!evil.includes("<script>"), "message text is escaped, never markup");
  assert.ok(evil.includes("&lt;script&gt;"));
  assert.ok(!evil.includes("Error:"), "no code line without a code");
});

// ---------- integration: envelope negotiation on the auth surface ----------

test("unknown auth provider: browser gets HTML 404, API keeps the JSON envelope", async t => {
  const origin = await startServer(t);
  const browser = await call(origin, "/api/auth/unknown/start", { accept: BROWSER_ACCEPT });
  assert.equal(browser.status, 404);
  assert.ok(browser.headers["content-type"].includes("text/html"));
  assert.ok(browser.body.includes("Back to sign-in"));
  assert.ok(!browser.body.includes('"operationId"'), "no raw envelope on the page");
  const api = await call(origin, "/api/auth/unknown/start", { accept: "application/json" });
  assert.equal(api.status, 404);
  assert.ok(api.headers["content-type"].includes("application/json"));
  assert.equal(JSON.parse(api.body).error.code, "not_found");
  const star = await call(origin, "/api/auth/unknown/start", { accept: "*/*" });
  assert.equal(star.status, 404);
  assert.ok(star.headers["content-type"].includes("application/json"),
    "curl/fetch default Accept keeps JSON");
});

test("wrong method on an auth route: browser gets HTML 405, API keeps JSON", async t => {
  const origin = await startServer(t);
  const browser = await call(origin, "/api/auth/magic/request", { accept: BROWSER_ACCEPT });
  assert.equal(browser.status, 405);
  assert.ok(browser.headers["content-type"].includes("text/html"));
  assert.ok(browser.body.includes("Back to sign-in"));
  const api = await call(origin, "/api/auth/magic/request", { accept: "application/json" });
  assert.equal(api.status, 405);
  assert.equal(JSON.parse(api.body).error.code, "method_not_allowed");
});

test("missing Origin on a POST auth route: browser gets HTML 403, API keeps JSON", async t => {
  const origin = await startServer(t);
  const browser = await call(origin, "/api/auth/passkey/authenticate/options", { method: "POST", accept: BROWSER_ACCEPT });
  assert.equal(browser.status, 403);
  assert.ok(browser.headers["content-type"].includes("text/html"));
  assert.ok(browser.body.includes("Back to sign-in"));
  const api = await call(origin, "/api/auth/passkey/authenticate/options", { method: "POST", accept: "application/json" });
  assert.equal(api.status, 403);
  assert.equal(JSON.parse(api.body).error.code, "origin_denied");
});

test("non-auth API failure stays JSON even for browsers (scope guard)", async t => {
  const origin = await startServer(t);
  const res = await call(origin, "/api/definitely-not-a-route", { accept: BROWSER_ACCEPT });
  assert.equal(res.status, 404);
  assert.ok(res.headers["content-type"].includes("application/json"));
  assert.equal(JSON.parse(res.body).error.code, "not_found");
});

// ---------- integration: unconfigured-provider direct returns ----------

test("github callback when unconfigured: browser gets the HTML 503 page, API keeps flat JSON", async t => {
  const origin = await startServer(t);
  const browser = await call(origin, GITHUB_CALLBACK_PATH, { accept: BROWSER_ACCEPT });
  assert.equal(browser.status, 503);
  assert.ok(browser.headers["content-type"].includes("text/html"));
  assert.ok(browser.body.includes("GitHub sign-in isn&rsquo;t configured") || browser.body.includes("GitHub sign-in isn’t configured"));
  assert.ok(browser.body.includes("Back to sign-in"));
  const api = await call(origin, GITHUB_CALLBACK_PATH, { accept: "application/json" });
  assert.equal(api.status, 503);
  assert.equal(JSON.parse(api.body).reason, "github_not_configured");
});

test("github start when unconfigured still serves its HTML page to browsers (row 4 regression pin)", async t => {
  const origin = await startServer(t);
  const browser = await call(origin, GITHUB_START_PATH, { accept: BROWSER_ACCEPT });
  assert.equal(browser.status, 503);
  assert.ok(browser.headers["content-type"].includes("text/html"));
  const api = await call(origin, GITHUB_START_PATH, { accept: "application/json" });
  assert.equal(api.status, 503);
  assert.equal(JSON.parse(api.body).reason, "github_not_configured");
});

test("google callback when unconfigured: browser bounces to the sign-in surface, API keeps flat JSON", async t => {
  const origin = await startServer(t);
  const browser = await call(origin, "/api/auth/google/callback", { accept: BROWSER_ACCEPT });
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.location, "/?google=unavailable");
  const api = await call(origin, "/api/auth/google/callback", { accept: "application/json" });
  assert.equal(api.status, 503);
  assert.equal(JSON.parse(api.body).reason, "google_not_configured");
});
