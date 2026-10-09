# WAVE-2000 G02 — Worker 7 shard report

## Shard
Sorted `url.pathname === "..."` dispatch lines in `server/http.mjs` (98 total),
0-based index mod 50 == 6 → **2 handlers**:
1. `GET /.well-known/oauth-authorization-server` (`server/http.mjs:1367`)
2. `POST /api/guest-agent-links/preview` (`server/http.mjs:2434`)

Note: this repo dispatches routes via `if (url.pathname === ... && req.method === ...)`
chains, not `app.get(...)`; the equivalent enumeration was used. Other 49 workers
cover the remaining 96 lines.

## Method
Local server booted on 127.0.0.1:45971 (own DB in `worker-7/db/`, own instance lock).
40 HTTP fuzz cases (statuses, body shapes, origins, content-types, methods, sizes,
host headers, raw-socket slow-drip). Existing suite `tests/guest-agent-links.test.js`
run for the preview 200-path: 9/9 pass.

## Findings

### F1 (hang-adjacent, genuine): configured `server.requestTimeout = 15000` not honored
- `server/http.mjs:5029` sets `server.requestTimeout = 15000`.
- An incomplete chunked-body POST to `/api/guest-agent-links/preview` stayed open
  **23.4s** (live server) / **30.0s** (fresh `createRoomServer` in test) before the
  408 arrived — well past the configured 15s.
- Bare-Node 24.20.0 calibration (no app code): requestTimeout 2s→408 at ~30s,
  5s→~60s, 15s→~60s. Node does not enforce sub-~30s requestTimeout values
  promptly in this version.
- Impact: slowloris-class; generic to every body-reading route, not just this
  shard. Severity low (eventually bounded, rate-limited per IP on this route),
  but the configured 15s is misleading — operators believe incomplete requests
  are cut at 15s.
- Repro: `/tmp/slowdrip.cjs` (raw socket, headers + `Transfer-Encoding: chunked`,
  zero body bytes; observed 408 at ~23.4s / 30.0s).
- Fail-first test (currently FAILS):
  `worker-7/wave2000-worker7-slowbody-timeout.test.mjs`
  — `AssertionError: 408 arrived after 30028ms; configured requestTimeout is 15000`.
- Candidate fix (not applied): app-level inactivity timeout inside `readText()`
  (`server/http.mjs:820`), since Node's own knob can't be relied on here.

### Non-findings (verified benign)
- `/.well-known/oauth-authorization-server/` trailing slash → 200 is **intended**
  (`server/http.mjs:~948`: "a trailing slash must reach the route, not a 404 —
  Normalize once, up front").
- `preview` body edge cases all correct: missing/extra keys → 422; null/number/
  array/object/bool/unicode/dup-key tokens → 410; human-share-shape token → 422
  `wrong_link_kind`; no JSON content-type → 415; empty/malformed/non-object JSON →
  400; >16KB body → 413 (limit named in message, G7); missing/wrong Origin → 403;
  wrong methods (OPTIONS/PUT/PATCH/DELETE/GET) → 404; Host mismatch → 403.
- Non-string `linkToken` cannot crash `preview()`: `classifyJoinToken`
  (`server/guest-agent-links.mjs:57`) returns `"invalid"` for non-strings →
  `fail(410)`.
- Well-known discovery doc is a complete RFC 8414 field set, `Content-Type:
  application/json; charset=utf-8`, issuer derived from `expectedOrigin()` and
  Host-header validated (403 on mismatch) — no Host-poisoning of `issuer`.

## Files (all under `~/workspace/pr-wave2000-guild-02/worker-7/`)
- `fuzz7.mjs`, `fuzz7b.mjs` — fuzz scripts (31 + 9 cases)
- `fuzz-results.json`, `fuzz-results-2.json` — raw case results
- `wave2000-worker7-slowbody-timeout.test.mjs` — fail-first test for F1
- `server.log`, `db/` — scratch server artifacts (server stopped)

No commits, no pushes, no PRs, no room posts.
