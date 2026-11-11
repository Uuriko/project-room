# Actual Native mixed message maintenance

PASS on exactff3350cb8d2be1d1c7278677211eeea3282b7c75. Two disposable actual ProjectRoom Native SQLite stores:1 normalized room+1legacy, then40normalized+1legacy. Each normalized room has an ordinary real message post; legacy room has an ordinary post. No direct schema changes, guard bypasses or runtime edits.

Both stores complete legacy backfill in one call and parity certifies z-legacy. Instrumented selectors return exactly1 legacy candidate, with0 normalized per-room head reads and0 current-record query preparations in maintenance. Native seven-table authority snapshot unchanged, no native backfill cursors added. Explicit native legacy-parity request409 directs callers to independent current integrity audit; raw old-writer message UPDATE refuses. Dispose/reopen actual Native worker: native authority still unchanged and all expected heads present.

Actual Native adapter cumulative rowsRead difference for backfill+parity is1088 at1normalized room,1322 at40. This is NOT constant physical SQL work; SQL anti-join can examine excluded IDs. No CPU/latency benchmark or production proof. Cold-start telemetry has its own separate scope. Final refusal/snapshot queries are outside measured rowsRead interval.

Reproduce using Node24 and matching July workerd:

```sh
LOCAL_LAB_GIT=/path/to/git MINIFLARE_WORKERD_PATH=/path/to/july/workerd node native_mixed_maintenance.mjs /path/to/ff335-checkout
```

Node24.22.1, Miniflare4.20260730.0, esbuild0.28.2, compatibility2026-07-30/workerd2026-07-30. Checkout tracked clean before/after. Fixture/log hashes and observations in receipt.json. Local unsigned-card/no-mailer config warnings retained in stderr. Does not certify excluded Native heads through legacy parity; no new corruption/recovery or whole release coverage is claimed.
