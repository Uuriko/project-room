# Native human invitation and frozen-suite triage

Source 42ead22c0e97bd18bec82dc5094912f5a413c26b adds tests only atop integrated runtime 2a3f8480a (original e99a8d3ad). Actual production ProjectRoom constructor + Durable SQLite, HTTP owner identity invitation issuance and exact retry, wrong-account and CSRF refusal with exact no-write state digest, fault AFTER member_accounts INSERT proving full transaction rollback, cold acceptance, independent full recovery audit, second cold exact retry retaining original event ID, consumed invitation wrong-account retry refusal, and accepted non-owner human cannot administer invitations. Owner principal and original account/credential/security rows stay unchanged on refusal/fault. No configured pre-existing managed connection is manufactured in this fixture; broader retained-connection qualification remains the earlier operator-normalization-auth receipt. Synthetic local accounts/credentials only; fixture doors are not production routes.

Native 1/1, targeted fixture lint clean, full-tree secret scanner1879/0. No runtime changes, production calls, push, or deployment. Existing CI entry: cloudflare/human-invitation-native.check.mjs.

## Frozen full-suite findings (read-only, no second suite)

Original80b05 log finished14814 tests,14456pass,324fail. Parser sees325 failure blocks because the unit-ci self-test embeds one intentionally failing fail-probe. Of198 direct addressed-read errors,166 terminate in agent-identities.mjs:840, so they are shared link setup failures rather than166 independently reproduced product defects. Queue owns that repair. Attached caller grouping preserves exact test source locations.

Other concrete remaining runtime callers beyond setup: spend-grants739/864, spend-allowance105, spend-pricing30, account-deletion356, squads192, share-links298. The share/admin lane is already assigned. Agent-work35 unconditionally reads the full room after selected requests/runs, and log includes actual agent-work409; pairing owns its next port. Unsupported-command failures15 and legacy-work-retired12 are separate policy/fixture or missing-plan issues, requiring classification rather than blanket authorization. Explicit test .room reads after native creation (e.g. charter-audit-ownership72/86) should use addressed assertions, not reenable hydration.

Cap scanner failure is specifically cloudflare/normalization-scale.check.mjs:8, a benchmark data assertion caught by production literal scanner. It is not a measured production projection-cap regression. Catalog/i18n baseline drift, default-room personal preference, current attachment selection, and squads/spend paths remain distinct follow-ups. No blanket claim that shared membership fixes clear these cases.

Frozen log SHA256: e06fd8265051951fd351b81aa5611f2952a3980b15a8b55df49b63f94763c06d; bytes: 7203215.
