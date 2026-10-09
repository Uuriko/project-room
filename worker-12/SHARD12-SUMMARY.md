# WORKER-12 — shard 12/50 (WAVE-2000 G02, slice server/http.mjs)

## Shard definition (documented adaptation)
The launcher's shard formula (`grep -nE 'app\.(get|post|put|patch|delete|use)\(' server/http.mjs`,
`(index mod 50) == 11`) yields **zero** handlers — this repo has no express-style `app.*`
registrations; http.mjs dispatches through the route table (`server/routes/table.mjs` →
`dispatchRoute`). Canonical partition used: ROUTES rows in table order, `(index mod 50) == 11`.
115 rows → shard 12 owns rows **11, 61, 111**:

- row 11: `POST /api/auth/magic/request` (auth=account, legacy chain in server/routes/auth.mjs:90-113)
- row 61: `POST /api/inbox/gmail/connect` (auth=account, legacy chain in server/routes/inbox.mjs:110-135)
- row 111: `GET /api/rooms/{roomId}/code/{dropId}/raw` (auth=room, handler `rawCodeDrop` in server/routes/code-drops.mjs:60-74)

## Method
Real in-process server (`createRoomServer` + fresh `RoomStore`, loopback 127.0.0.1) — same
pattern as tests/code-drops.test.js. 126 probes: auth-layer (missing/bad cookie, CSRF, Origin,
bearer), body-shape fuzz (types, nesting, unicode, NUL, 100k email, __proto__, extra fields),
transport fuzz (malformed JSON, text/plain, missing content-type, 2MB/12MB bodies), method
fuzz (GET/PUT/DELETE/PATCH/OPTIONS/HEAD + Allow-header checks), param fuzz (dropId traversal,
%2e%2e, NUL-%, 10k strings, unicode, case, roomId mismatch), rate-limit (magic 5/min).

## Findings
**No crashes, no hangs, no 5xx.** One low-severity observation with fail-first test:
- `normalizeEmail` (`server/account-login-methods.mjs:129`) accepts ASCII control chars
  (NUL `\x00`, ESC, BEL) — the comment claims whitespace incl. CR/LF rejection blocks
  header injection, but `\s` doesn't match NUL/ESC/BEL, so they survive into the
  magic-link recipient / lookup key. Repro: `POST /api/auth/magic/request`
  `{"email":"a@b.co"}` → 200 (mail_not_configured) — passes validation.
  Fail-first: `worker-12/email-control-chars.failfirst.test.mjs` (fails on current code, as intended).

Investigated and cleared (not bugs):
- One-off `fetch failed` on `GET /api/auth/magic/request` in the first run: undici
  keep-alive socket race after an early 413 on a 12MB upload — not reproducible in three
  follow-up repros (isolated / raw-http keep-alive+close / undici sequence all → 405,
  server healthy). `worker-12/repro-get-magic.mjs`, `worker-12/repro-keepalive.mjs`.
- `returnTo: "/rooms/commons"` → 422: by design — `validateMagicReturnTo`
  (server/magic-links.mjs:58) is an intentional allowlist (`/?room=`, `/?account=1`,
  `#invite/`, `#join/`, `#code/` only).
- `POST /api/inbox/gmail/connect` → 503 `gmail_not_configured`: designed honest-unavailable
  gate; the `gmail.begin(...)` body-parse path is unreachable without a configured Gmail
  provider (coverage gap, documented). Binding checks behave: missing → 422
  `session_binding_required`, malformed → 422 `invalid_session_binding`, stale → 409
  `session_binding_changed`.
- `code-drop-raw`: 404 `code_drop_not_found` for missing/wrong-case/traversal ids;
  traversal `..` falls through to 404 `not_found`; Content-Length byte-exact incl.
  multibyte content (Buffer-based); 405 + `Allow: GET` on wrong methods; trailing slash tolerated.

## Files (all under worker-12/)
- `fuzz-shard12.mjs` — the harness (node:test)
- `fuzz-results.json` — 126 raw probe results
- `fuzz-summarize.mjs`, `SHARD12-FINDINGS.md` — full probe table + flags
- `email-control-chars.failfirst.test.mjs` — fail-first test (1 low-severity observation)
- `repro-get-magic.mjs`, `repro-keepalive.mjs` — cleared-artifact repros

No commits, no pushes, no PRs, no room posts, no prod contact. Shard complete.
