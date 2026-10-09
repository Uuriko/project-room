# Adversarial auth fuzz results (wave1000 guild-13, 2026-10-08)

20/20 units PASS. Harness: `findings/guild-13/tools/fuzz.mjs`
(`node tools/fuzz.mjs fN`), runner `tools/run-fuzz.sh` (timeout per input,
logs + ledger). All against LOCAL fixtures only (fresh RoomStore +
HTTP server per unit, worktree-local TMPDIR). Fail-closed contract: every
adversarial input must answer 4xx, never 500, never silent elevation.

## Token forgery (F1–F5)

- **F1** PASS — 16 malformed identity secrets ("", "garbage", null,
  undefined, 123, {}, truncated/extended/unicode variants, `"Bearer
  <secret>"`) → all rejected (null), never throw, valid secret still resolves.
- **F2** PASS — tampered known secret (flipped char, truncated,
  `pri_`+wrong) → all rejected.
- **F3** PASS — 7 HTTP bearer probes (garbage, empty, lowercase scheme,
  wrong scheme, 100KB, unicode, missing) → all fail-closed (401/431), no 500.
- **F4** PASS — known issue verified: `Bearer garbage`, `Bearer
  pri_<unknown>`, `Bearer <identityId>` → **identical 401s** (no oracle).
- **F5** PASS — HMAC verifier keys: fallback accepted alongside a configured
  key (old rows keep verifying), <16-char keys ignored, no false matches.

## Replay (F6–F10)

- **F6** PASS — agent invite double redeem: 201 then **409**
  `invite_already_used`.
- **F7** PASS — OAuth auth-code replay: `invalid_grant`, whole token family
  revoked (RFC 6749 §10.5).
- **F8** PASS — refresh-token rotation reuse: `invalid_grant`, family dead.
- **F9** PASS — guest self-serve idempotency: first 201 + token, replay
  200 + `replayed:true`, **token never re-sent**.
- **F10** PASS — referral invite double redeem: 201 then 404
  `invite_unavailable`.

## Enumeration (F11–F13)

- **F11** PASS — 25 forged GX- probes → all 410, XX- prefix → 410 (the
  known misleading message, still fail-closed); burst past 30 → **429**
  (enumeration is rate-limited). No 500.
- **F12** PASS — identity-id probes (`ai_000…`, `ai_zzz…`, real id,
  garbage) → uniform 404s, no 500.
- **F13** PASS — operator surface: no auth / wrong token / Bearer scheme /
  empty → all **404** (surface is not an oracle), no 500.

## Mint abuse (F14–F16)

- **F14** PASS — anonymous mint flood: 8× 201 (free quota), then **428**
  `proof_required`, never 500.
- **F15** PASS — deceptive names: `owner`/`admin`/`room owner`/empty/81-char/
  unicode-spoof → 422; `Guest` and 80-char names → 201. No 500.
  (Observation: bare `Guest` is accepted as an identity display name —
  not a vuln, recorded.)
- **F16** PASS — 7 MCP mint abuse shapes (bad version, unknown tool, extra
  props, missing name, garbage, 200-char id, notification) → all rejected,
  no mint, no throw.

## Privilege escalation (F17–F20)

- **F17** PASS — guest (observer) attempts agent-invite mint and
  access-request → denied (4xx), no 500.
- **F18** PASS — redeem body schema is strict: junk fields
  (`permissions`, `bogus`) → **422** naming the field; redeemed member gets
  exactly the invite's permissions; unprivileged member mint → denied.
- **F19** PASS — verification-gated room: unverified link → 403
  `unverified_identity`; after owner attestation → link succeeds.
- **F20** PASS — gmail import confused deputy: cross-store, wrong
  connection, wrong envelope, unknown action → 403; forged/null token →
  null; legit grant works; room cookie is not an operator credential;
  `Operator` scheme enforced.

## Known issues (verified, not re-filed)

- Invite redeem misleading error message (XY- vs RM- prefix): confirmed the
  wrong-format message is confusing but fail-closed (404/410); no oracle.
- Bearer garbage vs Bearer identityId identical 401s: confirmed (F4).
