import test from "node:test";
import assert from "node:assert/strict";
import { workerLivenessResponse } from "../cloudflare/health-probe.mjs";

// #3272: the Worker answers /api/health itself and never enters the handler,
// so its liveness body must carry the documented emailVerification field the
// Node handler reports (docs/openapi.yaml). The caller (cloudflare/room.mjs)
// derives the value from the same env rule the Durable Object constructor
// uses to build its mailer: magicLinkMailerFromEnv(env) non-null = enforced.
test("worker liveness carries emailVerification alongside status/mode/deployment", async () => {
  const relaxed = await workerLivenessResponse(new Request("https://room.example/api/health"), {
    mode: "cloudflare-production", deployment: "production", emailVerification: "relaxed-no-mailer"
  }).json();
  assert.deepEqual(relaxed, {
    status: "ok", mode: "cloudflare-production", deployment: "production", emailVerification: "relaxed-no-mailer"
  });
  const enforced = await workerLivenessResponse(new Request("https://room.example/api/health"), {
    mode: "cloudflare-production", deployment: "production", emailVerification: "enforced"
  }).json();
  assert.equal(enforced.emailVerification, "enforced");
});

test("worker liveness HEAD answers 200 with no body", async () => {
  const response = workerLivenessResponse(new Request("https://room.example/api/health", { method: "HEAD" }), {
    mode: "cloudflare-production", deployment: "production", emailVerification: "enforced"
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});
