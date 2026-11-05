# Frozen release artifact reconciliation

Source `634833875a619e4661f6ec328045dd09a045d5bf` on8c1c2bd45. No deployment, merge, live request, Native-model or new product feature. Root owns integration and must regenerate pins if later pinned files change.

Four narrow corrections:

1. The missing derived browser duration is scripts/current-work-search-browser-check.mjs, a genuine browser test. Reused its already-frozen actual Chromium receipt at a378a6b61: one pass,728.641708ms total runner (474.108292ms test body), rounded729ms. Verified the complete archived log SHA and suite source SHA against both existing receipt and frozen8c1 file. No timing was fabricated or browser lane repeated. Provenance/local historical scope is recorded in browser-ci-durations.json. Native pairing is under cloudflare and did not join browser suites.
2. Official `node scripts/candidate-manifest.mjs --write` pins schema45,179assets and9deployment files, correcting app/events/en catalog/cloudflare package hashes. No manual digest edits.
3. Registered the existing server/inbox-next.mjs in the existing runtime allowlist. The original cold package test failed on precisely that missing import; the unchanged original test now passes, reopening imported email and resuming its saved partial scan in a cold allowlisted candidate package.
4. Source-emitted409 current_room_corrupt now has a registry-born actionable integrity hint and catalog recovery: stop/report for operator reconciliation, no unchanged retry or false empty result. The explicit registry fixture set and recovery assertions were updated deliberately. Catalog mirror and en.js generated via the existing skills-sync/build-ui-strings tools, preserving original catalog key order. No grant, data or writer behavior changed.

Validation with local Node24.22.1:

- Baseline browser/shards/manifest control21tests18pass3fail,exit1.
- `node --test tests/browser-shards.test.js tests/browser-suites.test.js tests/candidate-manifest.test.js tests/errors-catalog-drift.test.js`:32/32pass,0skip,exit0. First registry run correctly failed its explicit migrated-set ratchet; preserved red then added exactcode fixture, not an exemption.
- `node --test --test-name-pattern='every module in the server import closure|runtime preflight checks the working source' tests/runtime-package.test.js`:2/2pass,exit0.
- `node --test --test-name-pattern='cold allowlisted candidate package' tests/email-import.test.js`:1/1pass,0skip,exit0 against committed634 source. Original import/resume assertions unchanged. Local elapsed time is not a production performance claim.
- build-ui-strings --check,skills-sync-check,ESLint and diffcheck exit0. Secret scan clean,exit0. No whole suite or hosted CI pass claimed.

Complete gzip logs, observed exit statuses and SHA256 source/log map are in receipt.json. Historical browser log itself remains in audit/evidence/current-work-search-20261102. This evidence does not relabel that historical source as a current browser rerun.
