# Invitation note: local evidence ledger

September 7, 2026. Branch: codex/unified-local-20260907.
Parent: ee9bc6cf43d5685890335589ea10eef85cf949b0.
Observed summary, not a verbatim log, production telemetry or human study.

Bundled Node 24.19.0, installed Playwright/Chromium, local workerd.
Disposable loopback fixtures only; no operator secrets or live rooms used.

| Check | Observed outcome |
| --- | --- |
| scripts/check.mjs | Syntax and 355 core/API tests pass |
| Full package.json test:browser, concurrency 1 | First 75/76; after queued-toggle readiness correction 76/76 pass |
| invitation-note-browser-check.mjs | 12 new scenarios included in full suite |
| invitation-note.test.js | 19 new lifecycle/ownership cases included in core suite |
| share-link-ui.test.js | New bounded plain-text formatter case plus preserved existing behavior |
| Final targeted note/UI unit rerun | 27/27 after shortening obsolete-link instruction |
| Local Cloudflare compatibility/store/http/bootstrap/reminder-upgrade/browser | 7/7 pass; no deployment |
| cloudflare/build-assets.mjs | 15 exact allowlisted public files prepared |
| Existing asset/import graph tests | Exact bytes/imports and output guards pass |
| esbuild room.mjs, bundle/write:false/esm/neutral, external node:* and cloudflare:* | 194,636-byte production entrypoint in memory |
| git diff --check | No whitespace errors |

Browser command is read directly from package.json, not a shortened substitute.
Cloudflare suite uses compatibility.check.mjs, store.check.mjs, http.check.mjs,
bootstrap.check.mjs, reminder-upgrade.check.mjs and browser.check.mjs. Its repeated
self-signed local TLS probe diagnostic is recorded; all assertions pass, and no
production trust setting changed.

New journeys verify URL-only default copying, blank optional note, exact multiline
preview, literal markup/emoji, Enter newline, no request/storage/Room-state note,
selectable failure fallback, retained draft, no duplicate link creation from note
input, disclosure retention, close cleanup, late resolve/reject across A→B→A,
replacement and close, one outstanding clipboard operation, current/older-link
cancellation, uncertain cancellation retry, expiry focus/explanation and newer
focus/collapse ownership. Unit checks additionally cover client/visible session,
opening generation, account ownership, member revision/rights/kind, delayed success
after auth/binding denial, fresh retry after confirmed obsolete creation, and
known full/cancelled/expired/authority-changed listing.

Eight masked PNGs are retained locally (ignored test-results):
invitation-note-{desktop,mobile}-{closed,expanded,large-text,large-text-controls}.png.
Root inspected all eight. The enlarged-control capture was tightened to focus
and hit-test the real visible button after layout; screenshot alone was not used
as evidence of clickability. URLs and combined previews are masked. Synthetic
note text contains no private room data. No real participant, activation event,
return rate, causal lift or viral coefficient was measured.

No new public preview was handed off during this background goal checkpoint.
Existing live browser tabs remain untouched; isolated QA servers stopped with
their test fixtures. No service/schema/permission/dependency changes or external
publication were made. The goal remains active, not complete.
