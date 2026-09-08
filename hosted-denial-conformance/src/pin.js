/**
 * Live pin for this isolated Grok package.
 *
 * Re-fetched 2026-09-08: draft PR #23 head is
 * 2dcf3deeaf3dc2b897eb39617c43c6efb9f11a49 on codex/unified-local-20260907.
 * If that tip moves, update PIN.sha to the live #23 head — do not retarget Instinct #8.
 *
 * This package must not import or edit:
 * server/http.mjs, server/store.mjs, server/share-links.mjs,
 * src/app.js, cloudflare/room.mjs, cloudflare/hosted-check.mjs.
 */

export const PIN = Object.freeze({
  pull: 23,
  title: "Unified invite-only pilot candidate: quiet UI, guest access and deployment preparation",
  branch: "codex/unified-local-20260907",
  sha: "2dcf3deeaf3dc2b897eb39617c43c6efb9f11a49",
  url: "https://github.com/Uuriko/project-room/pull/23",
  sourceUrl: "https://github.com/Uuriko/project-room/tree/2dcf3deeaf3dc2b897eb39617c43c6efb9f11a49",
  fetchedAt: "2026-09-08T01:47:55Z",
  notInstinctPull: 8,
  siblingSkeleton: {
    pull: 22,
    path: "conformance-pilot/",
    note: "PR #22 stays the #8 / Phase 0 checklist skeleton. This sibling pins #23 hosted denial only."
  }
});

export const STAGING = Object.freeze({
  origin: "https://project-room-staging.getdasha.workers.dev",
  healthPath: "/api/health",
  readyPath: "/api/ready",
  bareHealthPath: "/health",
  observed: Object.freeze({
    at: "2026-09-07T21:37:14Z",
    health: Object.freeze({ status: 200, body: { status: "ok", mode: "cloudflare-staging" } }),
    ready: Object.freeze({ status: 200, body: { status: "ready" } }),
    bareHealth: Object.freeze({
      status: 404,
      body: { error: { code: "not_found", message: "Not found" } }
    })
  }),
  note: "Public health/ready only. Bare /health is 404 by contract. No DNS, route, Worker, or billing change from this package."
});

export const HOSTED_CHECK_GAP = Object.freeze({
  path: "cloudflare/hosted-check.mjs",
  pinSha: PIN.sha,
  covers: Object.freeze([
    "owner login + share-link create",
    "guest join on the live invitation URL",
    "--return reconnect of a saved guest session after redeploy",
    "optional --work first-use and --invite-user private invite save"
  ]),
  missing: Object.freeze([
    "cancelled link denial on the hosted origin",
    "expired link denial on the hosted origin",
    "join-cap / full link denial on the hosted origin",
    "removed-member denial on the hosted origin",
    "signed-out 401 room-read denial as a repeatable hosted-check case"
  ]),
  localCoverage: Object.freeze([
    "tests/share-links.test.js",
    "tests/acceptance-fixture.test.js",
    "tests/share-link-ui.test.js",
    "tests/invitation-http.test.js",
    "cloudflare/store-worker.test-fixture.mjs (local workerd cancel/preview only)"
  ]),
  note: "Codex operator evidence recorded a one-time signed-out 401 on staging. That is not encoded as a hosted-check.mjs case. This package documents the gap; it does not edit hosted-check.mjs."
});
