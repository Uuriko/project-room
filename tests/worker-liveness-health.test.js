import test from "node:test";
import assert from "node:assert/strict";
import { workerLivenessResponse, readyProbeResponse } from "../cloudflare/health-probe.mjs";

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
    status: "ok", mode: "cloudflare-production", deployment: "production", emailVerification: "relaxed-no-mailer", emailVerificationScope: "worker"
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


test("readiness reports the authority policy rather than the entry Worker's mailer", async () => {
  const request = new Request("https://entry.example/room/api/ready");
  const entry = await workerLivenessResponse(request, { mode: "production", emailVerification: "relaxed-no-mailer" }).json();
  assert.equal(entry.emailVerificationScope, "worker");
  const snapshot = { status: 200, body: new TextEncoder().encode(JSON.stringify({ emailVerification: "enforced" })) };
  const ready = await readyProbeResponse(snapshot, request).json();
  assert.equal(ready.emailVerification, "enforced");
  assert.equal(ready.emailVerificationScope, "durable-object");
  for (const body of [undefined, new TextEncoder().encode("bad json"), new TextEncoder().encode('{"emailVerification":"invented"}')]) {
    const unknown = await readyProbeResponse({ status: 200, body }, request).json();
    assert.equal(unknown.emailVerification, undefined);
  }
});
