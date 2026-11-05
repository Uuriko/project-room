# Genuine old Native cold upgrade

PASS: actual old8e65 ProjectRoom bundle creates legacy room, account, account access key, account session slot/login and room credential in disposable Miniflare Native SQLite persistence. Dispose old worker, then load actual2ebce68b ProjectRoom bundle against the same persistence directory and Durable Object identity. Dispose/reopen new bundle a second time.

All three phases authenticate the original room key and account session binding. Exact four-table auth snapshot and all rooms rows remain unchanged. Normalized head stays empty; restore stays clear. Actual permit guard changes5 to6 at first new cold open, stays6 at second. No synthetic guard relabeling, schema stamp deletion or direct database mutation. Fixture secrets remain inside disposable storage; only hashes/identity facts are published. Exit0.

Node24.22.1; Miniflare4.20260730.0; esbuild0.28.2; July workerd2026-07-30. Both tracked source trees clean before/after. Source pins, bundled-script hashes and log hashes are in receipt.json. Runtime warnings about unsigned agent card/no local mailer are retained in stderr; no production configuration is changed.

Reproduce with Node24, existing source checkout dependencies, and matching July workerd:

```sh
LOCAL_LAB_GIT=/path/to/git MINIFLARE_WORKERD_PATH=/path/to/july/workerd node genuine_native_upgrade.mjs /path/to/8e65-checkout /path/to/2ebc-checkout
```

Scope: synthetic local legacy data, four auth tables plus rooms, two cold restarts. Not24-table/provider lifecycle coverage, populated normalized-format migration, production state, all latest composition changes, or a performance benchmark. The first harness draft incorrectly reused a24-table helper requiring provider tables this fixture does not create; it failed before upgrade and was corrected to explicitly hash the four seeded tables. No runtime defect was inferred from that harness error.
