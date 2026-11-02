# Connector consent survives Google return

Source `df79bb59bae828b421cace2083aeca6aa6cc0d0a`, live baseline `bbb8b348423f002b3c636207ecc175faa3a2b573`.

Returning members previously restored their existing Room because startup only recognized desktop consent. Startup now resumes a validated same-origin connector consent on a successful provider return before Room restoration. Exact state, PKCE challenge and query remain intact. Terms and explicit Allow remain mandatory; provider autostart/cancellation stays desktop-only.

Original app with final functional fixture fails waiting for `/oauth/authorize` after landing on `/?room=commons`. Frozen source passes six HTTPS browser journeys (static/DCR × normal/terms/account-read fault+reload), with a preexisting separately authenticated human and managed identity-backed agent. Nineteen combined browser controls pass, including prior malformed returns/provider failure retry and desktop flows. Twelve registration/coverage checks pass. All commands use `/Users/johnpotter/.local/bin/node --test` and the filenames named in receipts/logs. `node scripts/browser-suites.mjs --check` passes and discovers146 suites. `node scripts/secret-scan-check.mjs` exits0.

The initial broader generic-return change caused retained invalid/generic failed-provider retry behavior to navigate; narrowed to successful provider return, preserving previous desktop continuation. First fixture setup attempts lacked HTTPS resource and sponsor permissions/identity; these were fixture corrections, not production policy changes. Original final-fixture red is preserved separately from those setup failures. Registration gate initially correctly rejected a missing measured duration; the real six-journey local measurement is now registered without exemption.

Compressed logs preserve original bytes; receipt lists uncompressed hashes. This is synthetic-provider browser qualification, not Claude cloud/live deployment proof. Root owns publication and manifest regeneration.

Final manifest regenerated through existing generator: schema44,177 assets,9 deployment files, only app.js asset digest changes. Eight manifest tests pass. CI=1 npm run check exits0; full Node suite explicitly skipped by existing CI contract. No source/runtime changes during final gates.
