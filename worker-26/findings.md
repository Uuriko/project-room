# WORKER 26 findings — fuzz target 25: `GET /api/opportunities.json` (http.mjs:1820)

**Verdict: NO FINDINGS.** No crash, no hang, no 500, no wrong-status, no stack leak.

## Coverage
- Guild runner (`fuzz/run.mjs 25 25`): 31 adversarial cases, 0 findings, 0 crashes
  (`worker-26/target-25.json`). Also 0 findings in the guild's earlier batch run
  of targets 14–26 (`.tmp/findings-14-26.json`) — independent re-run agrees.
- Supplemental probe (`worker-26/probe-params.mjs`, 63 cases, output in
  `worker-26/probe-params.out`): `limit`/`since`/`room` edge values, dup/array
  query keys, path normalization variants, HEAD/OPTIONS/POST-with-body,
  conditional headers. All statuses sane:
  - bad `since`/`room` values → clean 422 (`invalid_since`, `invalid_room`);
  - unknown room / SQL-ish room / 128-char room → 200 with empty feed (parameterized, no injection);
  - 129-char room → 422; `limit` any garbage → 200 clamped to 1..100 default 50;
  - non-GET (PUT/DELETE/PATCH/OPTIONS/POST/PROPFIND/TRACE) → 405; HEAD → 405;
  - trailing slash `/api/opportunities.json/` → 200 (line 952 trim);
  - `/api/opportunities.json%00`, `/API/...`, `//api/...`, `/api//...` → 404.
- Existing coverage: `tests/opportunities-feed-v2.test.js` already covers the feed
  module; no fail-first test written (nothing failed to write it against).

## Non-blocking observations (not bugs; noting for the wave rollup)
1. `GET /%2e/api/opportunities.json` → **200**. Node's WHATWG URL normalizes `%2e`
   to a dot segment before dispatch, so it resolves to the real path. Benign for
   this public route; consistent with the line-952 trailing-slash normalization.
2. `HEAD /api/opportunities.json` → **405 with empty body and no `Allow` header**.
   Sibling 405s (e.g. http.mjs:1731 public-work/match) pass `{ Allow: "POST" }`;
   this route's reject at http.mjs:1829 does not. RFC 9110 §15.5.6 says a 405
   response SHOULD include Allow. Spec nit only — status itself is correct.
3. `?since=%20` (whitespace-only) → **200**, interpreted as epoch 0
   (`Number(" ") === 0` in `parseSince`, server/opportunities.mjs:93).
   `?since=` empty → 200 (documented default); `?since=null` → 422. Minor
   inconsistency, benign — not wrong-status.

## Files
- `worker-26/shard.txt` — shard definition + handler location
- `worker-26/target-25.json` — guild-runner raw results (31 cases, 0 findings)
- `worker-26/probe-params.mjs` — supplemental probe script
- `worker-26/probe-params.out` — supplemental probe output (63 cases)
- `worker-26/findings.md` — this file
