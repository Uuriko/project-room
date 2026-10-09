# worker-36 fuzz results — WAVE-2000 guild-02

Shard: server/http.mjs route-handler indexes 35 and 85 of 115 (sorted, `(i mod 50)==35`).
See `shard.txt` and `routes-all-sorted.txt` for the full definition. Note: the task's
`app.(get|post|…)` grep pattern matches nothing — server/http.mjs is a raw node:http
handler with `if (route === "<name>" && req.method === "<M>")` dispatch blocks; the
shard was computed over those blocks instead (documented in shard.txt).

## Handlers under test

1. `GET /api/rooms/:roomId/reminders` — server/http.mjs:4326
   `store.reminders.list(selected.token, roomId, fence)` → 200 (viewer's own private reminders).
2. `POST /api/rooms/:roomId/reports` — server/http.mjs:4700
   `store.moderation.report(selected.token, roomId, await body(req), fence)` → 201 (200 on duplicate).

## Method

`fuzz-w36.mjs`: fresh fixture room (owner + guest/producer/reviewer human+agent members,
3 messages), local `createRoomServer` on 127.0.0.1, 71 HTTP probes with 5s hang timeout
(AbortSignal.timeout). `fuzz-w36-b.mjs`: 4 targeted follow-ups. `dbg-authmode.mjs`:
error-body shape check. Fixture DBs in mkdtemp, removed after each run.

## Verdict

**No crashes, no hangs, no 500s, no wrong-status responses.** All 75 probes answered
within the timeout with the status the code intends. Four first-pass "anomalies" were
fuzzer-expectation errors, each re-verified as correct behavior (see below).

## Findings (all verified non-bugs)

- **B24 (guest files report → 201, expected 403): not a bug.** The `guest_scope_denied`
  gate in `server/moderation.mjs:93` keys on `isGuestAgentMemberId()` = id prefix
  `"guest-agent-"` (server/guest-agent-links.mjs:33,68). A human guest named "guest"
  is *supposed* to report — the repo's own tests expect it
  (tests/moderation.test.js:115 → 201). Follow-up confirmed a real
  `guest-agent-fuzz` member gets **403** on the same call. Gate works as designed.
- **B7 (charset content-type → 422, expected 201): not a bug.** The probe reused the
  producer's own message m3; own-message reports are 422 by design. Re-ran with a
  reviewer reporting the owner's message + `application/json; charset=utf-8` → **201**.
  The `body()` content-type regex accepts the charset parameter.
- **B25 (emoji reason → 200, expected 201): not a bug.** Producer had already reported
  m2 in B20; the one-report-per-(reporter,message) dedupe correctly returned **200
  duplicate**. (B26 duplicate probe confirmed the same 200 path.)
- **A8 (`?auth=banana` with bearer → 200, expected 422): not a bug.** `roomCredentials`
  (server/http.mjs:731) short-circuits on a valid Bearer token and never reads the
  `auth` param — documented precedence. Without any credential, `?auth=banana`
  → **422 invalid_auth_mode** for both GET and POST (verified in dbg-authmode).

## Behavior confirmed by the fuzz corpus (spot-check table)

| Probe | Result |
|---|---|
| No/bogus auth (both routes) | 401 unauthenticated |
| Invalid JSON / empty body | 400 invalid_json |
| Non-JSON content-type / missing | 415 json_required |
| JSON array / null body | 400 invalid_json |
| Body 2MB | 413 too_large |
| Missing/extra/wrong-typed fields | 422 invalid_report |
| Blank/too-long/control-char reason | 422 invalid_report |
| `__proto__` / leading-space / 129-char messageId | 422 (validId) |
| Unknown / unreadable-DM messageId | 404 message_not_found (DM of others indistinguishable from unknown — privacy preserved) |
| Own message | 422 |
| guest-agent member | 403 guest_scope_denied |
| Duplicate report | 200 duplicate:true |
| 21 reports in an hour | 20×201 then 429 report_limit (Retry-After set) |
| DELETE/PUT on both routes | 405 method_not_allowed |
| Oversized roomId segment / traversal | 404 |
| Bad x-session-binding | 422 invalid_session_binding |
| Reminders GET ignores extra query params | 200 (no param validation on this read route — consistent with other list routes) |
| Unknown room id | 403 (authenticate fails before room lookup) |

## Files in worker-36/

- `shard.txt` — shard definition + the 2 handler lines
- `routes-all-sorted.txt` — all 115 route-handler blocks, line-number sorted
- `fuzz-w36.mjs` — main fuzz harness (71 probes)
- `fuzz-w36-b.mjs` — follow-up harness (guest-agent gate, charset CT, auth-mode)
- `dbg-authmode.mjs` — error-body shape probe (errors are `{error:{code,…}}`, not top-level `code`)
- `fuzz-results.md` — this report

No fail-first regression test was written: fuzzing found no defect to pin.
No commits, no pushes, no room posts, no prod contact.
