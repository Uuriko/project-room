# WORKER 44 — shard findings (WAVE-2000 GUILD-02)

## Shard definition (adapted)
Launcher shard spec: `grep -nE 'app\.(get|post|put|patch|delete|use)\(' server/http.mjs` sorted,
index mod 50 == 43. That grep returns **0 rows** in this repo — routes are declared in the
`ROUTES` table (`server/routes/table.mjs`), compiled to a trie in `server/routes/dispatch.mjs`.
I kept the shard formula and applied it 0-based to the frozen `ROUTES` array (115 rows, the
deterministic registration order, equivalent to the intent):

- **idx 43:** `POST /api/rooms/{roomId}/signoff-loops/{recordId}/submit` — `signoff-loops-submit`, auth `room`, handler `server/routes/record-rails.mjs` → `BuyerSignoff.submit` (`server/buyer-signoff.mjs:172`)
- **idx 93:** `PUT /api/rooms/{roomId}/members/me/wants-work` — `set-own-wants-work`, auth `room`, handler `putOwnWantsWork` (`server/routes/wants-work.mjs:46`)

## Coverage
- `worker-44/fuzz44.mjs`: 265 cases (auth-gates, method matrix, JSON body torture, content-type
  confusion, oversize 20k/100k/1MB, truncated/invalid-UTF8/BOM/proto-pollution/deep-nest,
  recordId + roomId path variants, requestId replay, query/header abuse, 140-case rate burst,
  14 raw-socket abuses). Server stayed alive (`/api/health` 200 after every batch).
- `worker-44/followup.mjs`: happy-path/replay/transition/idempotency verification, 75-write
  429 soak, duplicate-JSON-key retest.
- Raw JSON of every case: `worker-44/results.json` (265 cases, status histogram:
  200×82, 400×18, 401×4, 403×84, 404×4, 405×7, 413×5, 415×7, 422×35, 431×1).

## Verdict: no crashes, no hangs, no 500s
- State-machine semantics all correct: valid submit → 200; replay same requestId → 200
  idempotent; replay with different input → 409 `request_id_reused`; second submit on a
  `submitted` loop → 422 `invalid_signoff_status`; buyer `review`/`request_changes` → 200;
  candidate resubmit → 200 (round 2).
- Auth gates correct: no-auth → 401, bad bearer → 401, human on wants-work → 403 `agent_only`,
  non-party/non-candidate → 403 `candidate_mismatch`, unknown loop → 404 `signoff_not_found`.
- Validation correct: missing/extra body fields → 422, bad sha256 → 422, bad identifiers
  (129-char, 10k-char, `%00`, unicode, traversal) → 422 `Invalid identifier`, wrong methods →
  405, wrong content-type → 415, oversize body → 413 naming actual bytes, truncated/empty/
  non-object JSON → 400 `invalid_json`.
- 429 soak: 57×200 + 18×429 `rate_limited`, zero 500s. Raw-socket abuses (CL lies, double CL,
  chunked-invalid, null-in-path, bad request line): connection closed or benign hold; server alive.
- 4 auto-flagged "findings" were client-side fetch limits (GET/HEAD-with-body, TRACE), not
  server bugs. `ww:big-header` → 431 is Node's 16KB header cap, pre-app.

## One soft finding (data-integrity, not crash/hang/500)
**Invalid-UTF8 JSON bodies are lossy-decoded instead of rejected.**
`server/http.mjs:835` (`readText`): `Buffer.concat(chunks).toString("utf8")` replaces bad
bytes with U+FFFD. A submit body whose `deliverableRef` contains raw `0xff 0xfe 0x80`
returns **200** and persists `deliverable.ref === "\ufffd\ufffd\ufffd"` — the `text()` control-char
check in `server/buyer-signoff.mjs:50` does not see U+FFFD. Strict contract would be
400 `invalid_json` like every other body-parse error.

- Minimal repro: POST `/api/rooms/commons/signoff-loops/{loop}/submit` (authed bound candidate)
  with `{"requestId":"utf8-1","deliverableRef":"<0xff 0xfe 0x80>","sha256":"<64 hex>",
  "summary":"ok","candidateId":"<cand>"}` → 200, DB row stores `"���"`.
- Fail-first test (FAILS on current code): `worker-44/failfirst-utf8.test.js` —
  test 1 gets 200 (expects 400), test 2 gets 422 (expects 400). Both fail at the
  `assert.equal(res.status, 400)` lines. Judgment call for the merge queue whether
  to harden `readText` with a fatal UTF-8 decode.

## Files
- `worker-44/fuzz44.mjs` — main fuzz harness (auth'd + unauth'd + raw-socket)
- `worker-44/followup.mjs` — replay/transition/soak verification
- `worker-44/sanity.mjs` — smoke of both routes
- `worker-44/results.json` — all 265 case records
- `worker-44/failfirst-utf8.test.js` — fail-first test for the UTF-8 finding (red)
- `worker-44/FINDINGS.md` — this file
