// Production GET / is answered by the Worker edge, before the Durable Object.
// Stripping the GitHub anchor only in the Node asset handler would leave
// the hosted front door linking to a 503.
import test from "node:test";
import assert from "node:assert/strict";
import { edgePublicResponse } from "../cloudflare/edge-public.mjs";

const PAGE = `<section id="auth-panel">
<a id="google-signin" class="button secondary" href="/api/auth/google/start"><span>Continue with Google</span></a>
<a id="github-signin" class="button secondary" href="/api/auth/github/start"><span>Continue with GitHub</span></a>
</section>`;
const pageBytes = new TextEncoder().encode(PAGE);

function env(extra = {}) {
  return {
    ROOM_ORIGIN: "https://room.example.test",
    ASSETS: { fetch: async () => new Response(pageBytes) },
    ...extra,
  };
}

async function frontDoor(bindings) {
  const url = new URL("https://room.example.test/");
  const response = await edgePublicResponse(new Request(url), env(bindings), url);
  return { status: response.status, html: await response.text(), length: Number(response.headers.get("content-length")) };
}

test("the edge front door omits GitHub sign-in until both OAuth secrets are set", async () => {
  let digests = 0, encodes = 0;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const Encoder = globalThis.TextEncoder;
  globalThis.TextEncoder = class extends Encoder {
    encode(text) { encodes += 1; return super.encode(text); }
  };
  crypto.subtle.digest = (...args) => { digests += 1; return digest(...args); };
  let hidden;
  try {
    hidden = await frontDoor();
    const again = await frontDoor();
    assert.equal(again.html, hidden.html);
    assert.equal(encodes, 1, "the stripped document is built once");
    assert.equal(digests, 1, "its etag is hashed once");
  } finally {
    crypto.subtle.digest = digest;
    globalThis.TextEncoder = Encoder;
  }
  assert.equal(hidden.status, 200);
  assert.match(hidden.html, /id="google-signin"/);
  assert.equal(hidden.html.includes("github-signin"), false);
  assert.equal(hidden.html.includes("Continue with GitHub"), false);
  assert.equal(hidden.length, Buffer.byteLength(hidden.html));

  const partial = await frontDoor({ GITHUB_OAUTH_CLIENT_ID: "fixture-client" });
  assert.equal(partial.html.includes("github-signin"), false);

  const shown = await frontDoor({
    GITHUB_OAUTH_CLIENT_ID: "fixture-client",
    GITHUB_OAUTH_CLIENT_SECRET: "fixture-secret",
  });
  assert.match(shown.html, /<a id="github-signin" class="button secondary" href="\/api\/auth\/github\/start">/);
  assert.equal(shown.html.includes("fixture-secret"), false);
  assert.equal(shown.html.includes("fixture-client"), false);
});
