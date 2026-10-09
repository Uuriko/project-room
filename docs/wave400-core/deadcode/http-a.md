# Dead-code candidates — server/http.mjs lines 1–1250

Scope: symbols defined in this range, checked for callers/importers with
`grep` across `server/`, `tests/`, `scripts/`, `cli/`, `bin/` and within
`server/http.mjs` itself (most consumers live in later ranges of the same
file).

## Definitely dead

none found.

## Probably dead / needs owner confirm

none found.

Checked and alive (definition + at least one caller):

- `touchLruEntry` (269, exported) — channel-transport resolver (cap 2000)
  + unit tests.
- `securityContactFrom` / `securityTxtDocument` / `warnMissingSecurityContact` /
  `warnMissingSecurityContactCheck` / `writeSecurityTxt` (147–183) — the
  security.txt route + startup warning.
- `discoveryLinks` (185), `canonicalLink` (225), `publicPageLinks` (229) —
  `Link` headers on discovery/asset/receipt routes (1664–2037).
- `gr1PublicPath` (199), `gr2PublicPath` (216) — `/room/` alias rewrites
  (1868, 1871). `PUBLIC_RECEIPT_JSON` / `isPublicReceiptsJson` /
  `allowPublicReceiptsCors` (206–214) — public-receipt CORS/OPTIONS (1012).
- `SKILLS_CATALOG_DOC` / `MCP_SERVER_CARD_DOC` (51–52) — identity-compared
  in the discovery branch (1676–1695).
- `pathId` (230), `accountView` (236), `sessionView` (245), `exact` (256),
  `rateHash` (261) — used across routes in later ranges (e.g. session views
  at 2601, 2633, 2786).
- `defaultAssetLoader` (286) — default `loadAsset` param (302).
- `sessionAccountView` (325), `legalApiPaths` (336) — account-session JSON
  routes (2100–2144) and legal-API inventory.
- `accountDeletionSecret` (362) — deletion plan/execute routes (2388, 2405).
- `magicEmailLimit` + the five email rate limiters (360–373) — passed into
  `dispatchRoute`.
- `google()` / `github()` (374, 418) + `linkGoogleSubject` /
  `linkGoogleSubjectToAccount` (526, 555) + `linkGitHubSubject` /
  `linkGitHubSubjectToAccount` (468, 498) + `githubOAuthErrorMessage` (559) —
  the Google/GitHub OAuth routes (1104–1190, 1296–1363).
- `oauthProvider` (434) — OAuth2 provider routes + `dispatchRoute`.
- `recoveryRedeemLimiter` / `recoveryRedeemAllowed` (387–391) — recovery
  redeem route (2188).
- `passkeys()` (395) — passkey ceremony routes via `dispatchRoute`.
- `agentPlugin` (587), `operatorRoutes` (589), `nextActionsRoutes` (593) —
  mounted at 2744–2746.
- `resolveChannelTransport` (596), `sendBudgets` (612),
  `sendBudgetChannelFor` (620) — channel-send path; `sendBudgetChannelFor`
  consumed by `server/routes/inbox.mjs:371`.
- `expectedOrigin` (633), `scopedCookieName` (634), `cookie` (701),
  `setCookie` (798), `bearer` (708), `roomAuth` (726),
  `roomCredentials` (730), `expectedBinding` (738), `accountBinding` (742),
  `checkOrigin` (748), `isEdgeDoorOrigin` (761), `checkPreviewOrigin` (769),
  `carriesBearer` (785), `protectWrite` (793), `json` (803),
  `projectionMessages` (806), `readText` (814), `body` (821),
  `signInSlotToken` (1029) — all referenced by routes in later ranges or
  passed into `dispatchRoute`.
- `stream` (838) — the room SSE route (later range). `STREAM_DRAIN_GRACE_MS`
  (263) used inside it.
- `diagnosticRoute` (644), `serviceRoute` (656), `templateSegments` (640),
  `requestPathname` (641) — the error-path diagnostics (4951–4957).
- `jevShadowAdmission` (958) — shadow admission journaling at join/redeem/
  approve sites (2445–4573).
- `rate`/`dropRate`/`rateFamily` (663–699), `LIVENESS_GET_ONLY_PATHS` (137),
  `channelSendProviders` (259), `JSON_BODY_BYTES` (260) — used in-range or
  later.
- `fetchPullRequest` / `githubToken` (310–311) — forwarded into the room
  routes context (3766–3767).
- `cookieNamespace` (303) — validated (621) and used by `scopedCookieName`.
- `diagnostics` (638), `streams` (635), `channelSenders`/`sendReceipts`
  (582), `accessRequests` (585), `agentRooms` (591), `hostedRoomMcp` (594),
  `gmail` (345), `deploymentField` (340), `serviceMode` (313) — all wired
  into routes or startup validation.
