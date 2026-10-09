# Guild-03 docs — D3: agent-plugin / next-actions / operator / legal / supervision catalog

Verified against code at origin/main b53c52af (2026-10-09).

## server/agent-plugin-routes.mjs (986 lines)

Lane D agent plug-in surface. Factory `createAgentPluginRoutes({store,
json, reject, body, rate, bearer, exact, pathId, origin})`; returns true when
served (fall-through otherwise). Reuses credential factories for
`server/routes/table.mjs` (GET /api/wake-status).

Auth model: **agent credential** = `pri_` identity secret (owner, full
permissions; `scopes: null`) or `rak_` API key (scoped to stored scopes).
`createAgentAuth({store,bearer,reject})(req, scopeName?)` → 401 unknown
credential, 403 `insufficient_scope` when a scoped key lacks the required
scope. **Owner-only**: key issue/rotate/revoke need the `pri_` secret —
`ownerAuth` rejects `keyId !== null` (403). A key can never mint keys.
`grantsScope(scopes, required)`: exact match or `prefix:*` wildcard.

| Method | Path | Auth | Body | Success | Notes |
|---|---|---|---|---|---|
| POST | `/api/agent-keys` | owner | `{scopes, label?, expiresAt?}` (exact shape) | 201 `{…, credential: "rak_"+secret (shown once), next[]}` | 422 invalid_api_key_request |
| GET | `/api/agent-keys` | owner | — | 200 `{keys[], next[], identityUsage}` (no secrets) | — |
| POST | `/api/agent-keys/{keyId}/rotate` | owner | `{confirm:true, requestId?}` | 200 replacement credential (once) | 422 confirm_required without `{confirm:true}` |
| POST | `/api/agent-keys/{keyId}/revoke` | owner | `{confirm:true, requestId?}` | 200 | 422 confirm_required |
| POST | `/api/agent-directory/cards` | `directory:publish` scope | `{agentId, card, publicKey, signature, visibility?, rotationSignature?, recovery?}` (signed cards; recovery:true only with identity secret) | 201 + lifecycle next[] | 422 invalid_card (+signing guide), 403 on scoped-key recovery |
| DELETE | `/api/agent-directory/cards/{agentId}` | `directory:publish` | — | 200 | — |
| GET | `/api/agent-directory` | public; member credential upgrades view | — | 200 public cards (+room-visibility for members) | private cards never listed |
| POST | `/api/agent-skills` | `skills:publish` | `{publish, skills}` | 200 (replaces set) | 422 invalid_skills |
| GET | `/api/agents/{identityId}/card` | public | — | 200 public skill card | 404 unless publish:true |
| POST | `/api/agent-webhooks` | `webhooks:manage` | `{url (public HTTPS), events, secret? (≥16 chars)}` | 201 signing secret once (server-generated) or never echoed (caller-supplied) | 422 |
| GET | `/api/agent-webhooks` | `webhooks:manage` | — | 200 (no secrets) | — |
| DELETE | `/api/agent-webhooks/{id}` | `webhooks:manage` | — | 200 | cross-identity reads as 404 (never an oracle) |
| GET | `/api/agent-webhooks/{id}/deliveries` | `webhooks:manage` | — | 200 | — |
| POST | `/api/agent-webhooks/{id}/verify-delivery` | `webhooks:manage` | — | 200 | — |
| GET | `/api/agent-manifest` | public | — | 200 derived manifest | — |

Error translation (`translateWith`): AgentPluginError → its status;
ApiKeyError/DirectoryError/WebhookSubscriptionError/ManifestError/
VerificationError/HeartbeatError → status ?? (404 for directory_not_found
else 422). Cross-identity access reads as 404, never an oracle. Webhook
signing secrets are never returned (agents hold only the `secretRef`
sentinel). Rate limits per route per remote address.

Gotcha: `credential` (presentation-ready `rak_…`) vs `secret` (raw, kept
for backward compat) — agents must send `credential` as the Bearer token.

## server/next-actions-routes.mjs (93 lines)

Ranked per-agent "what next" surface. Factory
`createNextActionsRoutes({store, json, reject, body, rate, roomCredentials,
expectedBinding, accountBinding})`; returns true when served.

Auth: room credential (Bearer identity secret or room cookie) via
`roomCredentials`; missing token → 401. Reads rate-limited 120/min per
member; writes 60/min. `NextActionsError` → 422; `ServiceError` → its status.

| Method | Path | Success |
|---|---|---|
| GET | `/api/rooms/{roomId}/next-actions?limit=&kinds=` | 200 ranked list |
| POST | `/api/rooms/{roomId}/next-actions-dismiss` | 200 `{actionId, expiresInDays?, forever?, reason?}` |
| GET | `/api/rooms/{roomId}/next-actions-suppressions` | 200 newest-first |
| PUT | `/api/rooms/{roomId}/next-actions-suppressions` | 200 `{suppressions:[{kind, reason?}]}` (replace-all) |
| GET | `/api/rooms/{roomId}/next-actions-dismissals` | 200 incl. lapsed rows |

Every `action.api` emitted names a real route (tests/next-actions.test.js
resolves each against the route patterns).

## server/operator-routes.mjs (62 lines)

Operator surface. `createOperatorRoutes({store, json, reject, body, rate})`
→ true when served. **When the operator secret is unset, returns false**
(falls through to the generic not_found path — no oracle).

| Method | Path | Success |
|---|---|---|
| POST | `/api/operator/purge/plan` | 200 purge plan |
| POST | `/api/operator/purge/find` | 200 |
| POST | `/api/operator/purge/execute` | 200 |
| GET | `/api/operator/actions?limit=` | 200 (limit 1..200, else 422 invalid_limit) |
| GET | `/api/operator/status` | 200 |
| GET | `/api/operator/drift?main=` | 200 |

Auth: per-remote-address rate limit (10); `presentedOperatorToken`; a
room/account cookie WITHOUT a token → 404 (not 401 — no oracle);
token mismatch → 404 `not_found`. Method mismatch → 405. `Cache-Control:
no-store` on all.

## server/legal-routes.mjs (132 lines)

Legal pages, public reports, terms, operator unpublish.
`handleLegalRequest({…})` → true when served; `isLegalPath()` is the gate.

| Method | Path | Auth | Success | Notes |
|---|---|---|---|---|
| GET/HEAD | `/terms` `/privacy` … (LEGAL_SITEMAP_PATHS) + `/report` | public | 200 HTML (CSP, canonical Link) | POST → 405 |
| GET | `/room/terms` etc. | public | 301 → canonical on room host | fixes www.getdasha.com/room 404s (QA4 Q4-H-1) |
| GET | `/api/reports/public/challenge` | public | 200 PoW challenge | — |
| POST | `/api/reports/public` | public, **proof-of-work** | 201 `{received, id}` | 428 proof_required; 422 on extra fields; per-address rate 5 |
| GET/HEAD | `/api/health/jobs` | public | 200 `{schema, publicReports, servedBy, jobs?}` | — |
| POST | `/api/account/terms` | account cookie | 200 accountView | 401; body must be exactly `{version}` (422) |
| POST | `/api/operator/unpublish` | account cookie = operatorAccountId | 200 `{unpublished, kind, id}` | 403 operator_unconfigured / forbidden; exact `{kind,id}` |

## server/supervision-routes.mjs (371 lines)

Supervision inbox (herdr redesign lane B6). **Mounting is DEFERRED — not
mounted in server/http.mjs** (no runtime-package registration); the doc
header gives the intended mount. `handleSupervisionRoutes({req,res,url,
roomId,auth,supervisionRoute,cardId,helpers,deps})`.

Identity: cards are per-(room, operator); every route re-authenticates and
scopes storage to the caller's member id — 404 means "no such card in YOUR
queue" (never leaks another lane's state).

| Method | Path | Route | Success | Errors |
|---|---|---|---|---|
| GET | `/cards` | list | 200 `{roomId, viewerId, cards[]}` (`?include=snoozed`) | 405 |
| POST | `/cards` | derive | 200 `{derived, cards[]}` (internal roll-up tick; never downgrades triaged cards) | 405 |
| POST | `/cards/{id}/seen` | seen | 200 `{card, seen:true}` | 404 unknown_card, 422 bad id |
| POST | `/cards/{id}/pick` | pick | 200 `{card, suggestion, intent{undoDeadlineMs…}}` or `{requiresConfirm:true, challenge}` | 422 bad suggestionIndex / nothing_to_hold |
| POST | `/cards/{id}/retract` | retract | 200 `{retracted:true}` | 409 illegal_transition |
| POST | `/cards/{id}/confirm` | confirm | 200 `{confirmed, write, apiNote}` (idempotent replay when already approved) | 422 confirmation_required (needs `{confirm:true}`) |
| POST | `/cards/{id}/dismiss` | dismiss | 200 `{dismissed:true}` | — |
| POST | `/cards/{id}/snooze` | snooze | 200 `{snoozedUntilMs}` (`snoozeFor: 1h\|4h\|tomorrow` or `untilMs`) | 422 bad preset |
| POST | `/cards/{id}/refetch` | refetch | 200 `{stale:true}` or `{stale:false, verified}`; `{fired:true}` reports client-held dispatch | staleness only from affirmative live evidence — unknown sources keep the card |

Storage contract: `createSupervisionCardStore(db)` with
`upsertCard/getCard/listCards/journal/history` over additive tables
`private_supervision_cards` + `private_supervision_card_history`
(registered in unfencedAdditiveTables). `deps.decide` overrides the
suggestion decider; v1 never suggests money/merges/deploys but the confirm
gate is live for them.
