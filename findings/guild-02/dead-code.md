# wave1000 guild-02 — dead-code scan: server/http.mjs

Method: enumerated every top-level and `createRoomServer`-scoped function /
const definition and counted identifier occurrences across the module; every
definition with ≤2 occurrences was checked by hand for callers (including
comment references and the `dispatchRoute` context object).

## Result: no dead code found

Every definition is referenced. Spot-checks on the most suspicious
candidates:

| Candidate | Reachability evidence |
|-----------|----------------------|
| `legalApiPaths` (line 331) | Used at line 1932 (`legalApiPaths.has(url.pathname)`); the comment notes `scripts/open-routes.mjs` reads the literals. |
| `writeSecurityTxt` (167) | Called at line 952 for the three security.txt paths. |
| `touchLruEntry` (269) | Exported; used at line 601 (channel-sender cache) and by tests/channel-sender-cache.test.js. |
| `warnMissingSecurityContactCheck` | Called at line 334 on non-Worker runtimes. |
| `securityContactFrom` / `securityTxtDocument` | Both used by `writeSecurityTxt`. |
| `diagnosticRoute` / `serviceRoute` (644/656) | Used in the tail catch for diagnostics + operator traces. |
| `dropRate` / `rateFamily` | Used by `rate()`. |
| `discoveryLinks`, `canonicalLink`, `publicPageLinks` | Used on public pages / Link headers. |
| `gr1PublicPath`, `gr2PublicPath`, `isPublicReceiptsJson`, `allowPublicReceiptsCors` | Used in the funnel (steps 7–9). |
| `pathId`, `accountView`, `sessionView`, `exact`, `rateHash` | Used across routes; `exact` at ~40 call sites. |
| `defaultAssetLoader` | Used as the default `loadAsset` parameter. |
| `stream` / pump helpers, `body`, `readText`, `json`, `cookie`, `setCookie`, `bearer`, `rate`, `checkOrigin`, `protectWrite` | All called in the funnel or passed into `dispatchRoute`. |
| `signInSlotToken` | Used by the sign-in JSON routes. |
| `magicEmailLimit`, `recoveryRedeemAllowed`, `passkeys`, `google`, `github` | Used by their respective routes. |
| `setIntentAdmissionShed`-style exports | N/A to main (branch-only). |

The module is large (4777 lines) but fully live; the legacy route chain is
being drained into `dispatchRoute` by design, which is migration — not dead
code. No deletions proposed.
