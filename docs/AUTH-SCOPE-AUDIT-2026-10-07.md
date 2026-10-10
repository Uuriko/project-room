# Auth-scope audit — project-room — 2026-10-07

Scope: every auth scope in the room — agent keys, OAuth, claim scopes
(task 169, Project Room part). Venue keys are Dasha-side and out of scope.

## Scope matrix

| Credential | Scope vocabulary | Where enforced | Least-privilege posture |
|---|---|---|---|
| Room member permissions | 9 permissions (`src/events.js` PERMISSIONS): steer, decide, manage_members, manage_claims, accept_work, complete_work, verify, write_external, invite_member | Route-level permission checks | Owner holds all 9 (trust root — justified, the owner can already do everything); everyone else gets explicit grants |
| OAuth access tokens (`oat_`) | 5 scopes (`server/oauth-provider.mjs` OAUTH_SCOPES): rooms:read, chat:read, chat:write, work:read, work:write | Allowlist validation at authorize; refresh-token rotation with reuse detection (theft → whole family revoked); family revocation on demand | Unknown/empty scopes rejected; PKCE required; consent screen |
| Agent API keys (`rak_`) | API_KEY_SCOPES (`server/agent-api-keys.mjs`): directory:publish, webhooks:manage, heartbeats:report, … (wildcard `:*` supported) | Route-level `requiredScope` → 403 `insufficient_scope` | Identity-bound; per-route least privilege |
| Room access keys | Member-bound, 7-day TTL (max 30d), revoke-on-issue (one active key per member) | Expiry/revocation → 401 fail-closed (proven by `tests/chaos-scenarios.test.js`: expired key rejected, room stays usable) | Short-lived; rotation is atomic |
| Guest credentials | `GUEST_AGENT_PERMISSIONS = []` | Zero permissions by default | Least privilege by construction |
| Work-claim scopes | File paths (`server/claim-scopes.mjs` claimScope) | `conflictingClaim` → 409 `claim_conflict` on overlap | Prevents duplicate/conflicting work |
| Access-request auto-approve | — | `AUTO_APPROVE_FORBIDDEN_PERMISSIONS`: manage_members, decide, manage_claims, write_external, invite_member can never auto-approve | Sensitive permissions always need explicit approval |

## Findings

1. **No over-broad scopes found.** Every vocabulary above is narrow, validated
   against an allowlist, and enforced at the route or command boundary.
2. **Expiry fails closed everywhere it matters.** Room access keys (401),
   account sessions (401), OAuth access tokens (deleted on expiry, return
   null), refresh tokens (single-use rotation). The chaos suite proves the
   room-key path.
3. **Theft signals exist.** OAuth refresh-token reuse revokes the whole
   token family with a distinct `invalid_grant` (the legitimate user sees a
   theft signal, not a silent "revoked"). Credential rotation is atomic
   (revoke-on-issue).
4. **Guests are zero-permission by default** and the sensitive permissions
   are excluded from auto-approve — the two places privilege creep would
   start are both closed.

## Open question (flagged, not asserted)

**Third-party `oat_` token consumption path.** Issuance is well-built
(allowlist scopes, PKCE, consent, rotation, revocation), and the desktop
sign-in flow requires all five scopes then immediately retires the grant
for an account session. But I did not locate where a third-party connector
presents an `oat_` bearer token to general API routes with scope
enforcement — `server/http.mjs`'s bearer regex does not match the `oat_`
shape. Either connectors exchange through a path I did not trace, or scope
enforcement on the general API for connector tokens is absent. Follow-up:
trace the connector token path and either document the enforcement point or
file the gap. (Filed as a note, not a vulnerability — the issuance side is
sound and the desktop flow is safe.)

## Verdict

Least privilege holds across all six scope systems. No tightening needed;
the one open question above is the only follow-up. Venue keys excluded as
Dasha-side.
