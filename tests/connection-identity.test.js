import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectionIdentityLine } from "../src/client.js";

test("connectionIdentityLine names revision, unpublished walk-in, and Google from live contract shapes", () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  const line = connectionIdentityLine(
    { sourceRevision: sha, mode: "cloudflare-production" },
    { ship: false, persistence: "none" },
    { provider: "google", authorizationPath: "/api/auth/google/start" }
  );
  assert.equal(line, `revision ${sha.slice(0, 7)} · unpublished walk-in · Google sign-in`);
  assert.equal(connectionIdentityLine({ sourceRevision: "short" }, { ship: true }, { provider: null }), "published walk-in · key sign-in");
  assert.equal(connectionIdentityLine({}, {}, {}), "");
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /connectionIdentityLine\(version, open, auth\)/);
  assert.match(app, /hostIdentity \? `\$\{normalized\}\\n\$\{hostIdentity\}`/);
});
