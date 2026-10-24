# Code simplification review — September 20, 2026

Scope: all tracked JavaScript, TypeScript, CSS and HTML files inventoried;
repository syntax/lint/contracts and full unit suite run separately. This is
not a claim that every line received manual security review. Counts are physical
lines, not complexity scores. Tests/checks include scripts/, tests/, *.test.*,
*.check.* and test-fixture files. Dependencies, lockfiles and Markdown excluded.

- Runtime and UI: 84,926 lines
- Tests and checks: 111,835 lines

## Applied in this slice

Five pre-room client operations repeated origin validation, edge routing,
redirect/cookie policy, deadline/cancellation, JSON decoding and error handling.
They now use one transport helper. Endpoint-specific response validation remains
explicit. Added identity room discovery through that same helper, without a new
auth system, table, dependency or service. Client file: 967 → 904 lines, including
the new listing method. Existing standalone function signatures remain compatible.

New tests exercise all six requests against malicious origins, failure responses,
invalid JSON, abort propagation, edge-prefix routing and bearer placement.
Integration tests cover identity isolation, unlink, revocation/rotation, CLI use
without a room, inactive members and cursor pagination. Worker fixture verifies
actual shared-runtime routing and authorization.

## Highest-value next reviews

| Area | Observation | Simplification approach / acceptance |
| --- | --- | --- |
| `src/app.js` | 4,699 lines | Review ownership and repeated behavior before extraction. |
| `server/store.mjs` | 2,792 lines | Review ownership and repeated behavior before extraction. |
| `server/http.mjs` | 2,723 lines | Review ownership and repeated behavior before extraction. |
| `server/inbox.mjs` | 1,539 lines | Review ownership and repeated behavior before extraction. |
| `src/events.js` | 1,409 lines | Review ownership and repeated behavior before extraction. |

1. app.js: centralize destination transitions and draft/reading-position ownership.
   First inventory existing owners; moving handlers into another file alone does
   not reduce complexity. Keep desktop/touch/back/reload recovery tests.
2. http.mjs: extract repeated request decoding/authorization only within one auth
   family. Keep public, identity, room and account boundaries distinct. Avoid a
   generic dispatcher that obscures permission checks or route documentation.
3. store.mjs: consolidate repeated membership lookups through current authority
   methods; never cache authorization across revocation or drop transaction scope.
4. Inbox: align provider adapters behind the existing delivery contract, retaining
   provider-specific recipients, reply metadata and uncertain-send semantics.
5. Work state: #603 should derive UI/agent descriptions from existing transition
   rules. Do not add a third state vocabulary or rebuild the event model.

Do not use minification, shorter identifiers, compressed statements, removed
comments/tests, or new abstractions as the line-count win. Record runtime, tests
and docs separately. Broad deletion waits for demonstrated equivalence; avoid
mixing an architectural rewrite with a product feature or release repair.
