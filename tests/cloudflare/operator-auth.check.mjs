// The operator secret is a Wrangler secret (the hex SHA-256, never the token).
// Under the deployed compatibility flags it has to show up on process.env,
// which is how the Durable Object reads it. This check does not boot the
// room class: it only proves the secret is visible to Worker code.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";

const HASH = createHash("sha256").update("operator-auth-check-token-value-32b").digest("hex");

const SCRIPT = `
export default {
  async fetch() {
    const env = globalThis.process && globalThis.process.env;
    const name = "ROOM_OPERATOR_" + "TOKEN_SHA256";
    const value = env && typeof env[name] === "string" ? env[name] : null;
    return Response.json({
      visible: typeof value === "string" && value.length > 0,
      sha256Hex: typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    });
  }
}
`;

test("ROOM_OPERATOR_TOKEN_SHA256 is visible on process.env under the deployed Worker flags", async () => {
  const mf = new Miniflare({
    modules: true,
    script: SCRIPT,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough", "enable_nodejs_http_server_modules"],
    bindings: { ROOM_OPERATOR_TOKEN_SHA256: HASH }
  });
  try {
    const response = await mf.dispatchFetch("https://room.example.test/operator-env");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.visible, true, "the secret is not on process.env; do not mount it through cloudflare/room.mjs until it is");
    assert.equal(body.sha256Hex, true);
  } finally {
    await mf.dispose();
  }
});
