# WORKER 23 — shard summary (WAVE-2000 guild 02, server/http.mjs API fuzzing)

## Shard
Partition: `grep -nE "if \(url\.pathname ===" server/http.mjs`, 93 handlers, index mod 50 == 22 → **2 handlers**:
1. `server/http.mjs:1747` — `if (url.pathname === "/api/public-work/tasks" || publicWorkTaskMatch || publicWorkReceiptMatch)`
   (list, task read, claim/renew/release/finish actions, receipt read, artifact download)
2. `server/http.mjs:2808` — `if (url.pathname === "/api/web/fetch")` (POST, member auth, room-side web fetch)
Also covered: adjacent sibling `server/http.mjs:1739` (`publicWorkReviewMatch` review endpoint) — matches no
worker's grep partition, so worker 23 fuzzed it as well.

## Runs (all local, acceptance-fixture server on 127.0.0.1, TMPDIR=.tmp)
- Guild harness `fuzz/run.mjs 22 23` → **0 crashes, 0 findings** (`harness-22-23.json`)
- Custom public-work battery `fuzz-public-work.mjs` — 53 cases: query validation matrix
  (limit=abc/0/-1/101/1.5/empty/hex/huge/dup/unknown → 422; after null-byte/dotdot/long → 422),
  method matrix (405s), id path edges (404s), action auth gates (401 pre-body), receipts/artifact/review (404/405/422/401) → **0 genuine findings**
- Custom web-fetch battery `fuzz-webfetch.mjs` — 58 cases with a local adversarial origin
  (slow headers, drip feed, 3MB body, redirect loop/to-private/to-file/7-chain, gzip bomb,
  bogus/utf16 charsets, SSRF blocklist incl. decimal/hex/octal IP forms, unresolvable host) →
  **0 genuine findings**

## Findings
**None.** No crashes, no hangs (slow/drip origins correctly surface 504 at the 15s fetch timeout),
no 500s, no stack traces in responses. Nine initial flags were all wrong test expectations on the
worker's side, each verified against code:
- `after=abc` → 200 is correct (valid identifier cursor)
- `{url:<nonstring>}` without `formats` → 422 is correct (strict shape-first validation, `validateInput` before `normalizeUrl`)
- `http:///path` → 403 is correct (WHATWG normalizes to host `path`, which fails closed on DNS)
- decimal/hex loopback with port → 200 in test ctx is correct (WHATWG normalizes to 127.0.0.1, inside the test-only loopback allowance; prod ctx blocks via `ipLiteralBlocked`)
- redirect to `file:` → 400 `invalid_url` is correct (per-hop revalidation through `normalizeUrl`)
- wrong-status expectations for `o:redir-file` (400, not 403/502) likewise corrected

## Tests
No fail-first tests written: none warranted (no genuine crash/hang/wrong-status found).
Repro batteries retained as `fuzz-public-work.mjs` / `fuzz-webfetch.mjs` for re-runs.

## Artifacts (worker-23/)
- `shard-handlers-raw.txt` — the 93-handler partition source
- `fuzz-public-work.mjs`, `findings-public-work.json`
- `fuzz-webfetch.mjs`, `findings-webfetch.json`
- `harness-22-23.json` — guild harness output (targets 22–23)

No git commit, no push, no room posts, no prod contact — per task rules.
