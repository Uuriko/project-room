# Durable email import checkpoint

Runtime tested: `b0c0800d6b0b84cfb4b8e9d28e477c76f1a475b4`, schema 19.
Foundation: `86c2674`, schema 18. Local implementation only.

## Outcome

Fixture email now persists in the existing account-owned Inbox domain. Connection state, imported message versions and folder progress commit atomically. Drafts survive message changes, disconnect, full rescans, restart and recovery. Neither room membership nor an agent room token grants private mailbox access.

The import path remains internal and explicitly fixture-backed. No credentials, OAuth, network driver, live mailbox, real sending or new email UI are enabled. The current browser source list stays synthetic-only until it explicitly negotiates email support.

## Defect found and fixed

Folder-level concurrency checks alone allowed an old observation from one folder to replace a newer version of the same message imported through another folder. The regression failed with “Missing expected exception” before the fix.

Schema 19 requires the source revision captured before message hydration. A stale observation rejects the entire page, preserving newer content and folder progress. A driver must fetch fresh content, not relabel the stale payload. Schema-18 writers are retired after migration; their stored historical requests still replay and retrieve exact existing receipts under current account and connection authority. They cannot perform new unfenced imports.

Genuine historical package tests exercise migration rollback, unchanged old records, already-open writer refusal, populated email replay and restart. The old synthetic Workers v7 fixture also needed to exclude email tables introduced after v7; runtime migration validation was not relaxed.

## Verification

- Exact committed syntax/core checks: **778/778 passed**.
- Exact committed complete local Workers checks: **21/21 passed**, including browser/SSE, v18-to-v19 migration and private import restart.
- Exact committed complete browser regression: **233/233 passed**.
- Focused import and genuine migration checks: **30/30 passed** before committing.

Evidence is retained in `test-results/email-import-b0c0800/`. The initial Workers attempt failed because the sandbox could not bind loopback ports; the permitted local run passed. The browser npm launcher was unavailable; the same package-defined arguments were executed directly with Node. Earlier schema-18 and mixed-source browser results are exploratory, not final-version proof.

Evidence naming:

- `committed-core-b0c0800.log`, `committed-workers-b0c0800.log` and `committed-browser-b0c0800-full.log`: final-runtime verification.
- `source-race-before.log` and `source-race-after-final.log`: failing regression, then focused correction.
- `workers19-candidate.log`: loopback permission failure; `committed-browser-b0c0800.log`: unavailable npm launcher.
- `final-core.log`, `final-workers.log`, `final-browser.log`: earlier schema-18/exploratory runs despite their original filenames.
- `email-import-*.log`: earlier candidate results, including corrected fixture account authentication, synthetic downgrade schema and cold-package inventory/count assertions.
- `arrival-desktop.png`, `arrival-mobile.png`: inspected synthetic account-home browser captures.

Fresh desktop/mobile account-home screenshots were inspected. They show the existing synthetic Inbox, not a connected email interface. Simulated browser actors do not establish human satisfaction; no new native-model/provider participation is claimed in this checkpoint.

## Next

Follow [the persistence contract](EMAIL-IMPORT-PERSISTENCE-2026-09-08.md): offline fixture driver, negotiated plain-text email in the same Inbox, precise excerpt sharing, and only then a separately authorized dedicated mailbox pilot. Keep Inbox and Rooms as the navigation; advanced channel details should not become a new dashboard.

The ambitious project goal remains active. Deployment, real messaging, broader channel support, hosted execution and rewards remain separate unfinished gates. No push, deployment, external message, model call or payment occurred.
