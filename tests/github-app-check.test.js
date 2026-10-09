// tests/github-app-check.test.js — regression tests for the
// order-sensitive manifest comparison found by WAVE-2000 worker-10
// (2026-10-09).
//
// What this protects: github-app-check compared the manifest with
// JSON.stringify, which is key/event order-sensitive. A semantically
// identical manifest re-serialized with keys or events in a different order
// (e.g. by a manifest-regeneration tool) failed the gate. checkManifest()
// now normalizes order before comparing, and is exported so the rule is
// unit-testable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest } from "../scripts/github-app-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const realManifest = () => JSON.parse(readFileSync(join(root, "github-app", "manifest.json"), "utf8"));

test("checkManifest accepts the committed manifest", () => {
  assert.deepEqual(checkManifest(realManifest()), []);
});

test("checkManifest accepts a semantically identical manifest with reordered keys and events", () => {
  // Must fail on the pre-fix code: JSON.stringify compared key insertion
  // order and event array order verbatim.
  const reordered = realManifest();
  reordered.default_permissions = {
    metadata: "read",
    contents: "read",
    checks: "write",
    pull_requests: "write",
  };
  reordered.default_events = [
    "installation_repositories",
    "installation",
    "check_suite",
    "pull_request",
  ];
  assert.deepEqual(checkManifest(reordered), []);
});

test("checkManifest still rejects a genuinely wrong permission", () => {
  const bad = realManifest();
  bad.default_permissions = { ...bad.default_permissions, issues: "write" };
  const problems = checkManifest(bad);
  assert.ok(problems.some((p) => p.includes("default_permissions")), `still flags it: ${problems}`);
});

test("checkManifest still rejects a missing event", () => {
  const bad = realManifest();
  bad.default_events = bad.default_events.filter((e) => e !== "pull_request");
  const problems = checkManifest(bad);
  assert.ok(problems.some((p) => p.includes("default_events")), `still flags it: ${problems}`);
});

test("checkManifest still rejects a wrong webhook URL", () => {
  const bad = realManifest();
  bad.hook_attributes = { url: "https://example.invalid/hook" };
  const problems = checkManifest(bad);
  assert.ok(problems.some((p) => p.includes("webhook URL")), `still flags it: ${problems}`);
});
