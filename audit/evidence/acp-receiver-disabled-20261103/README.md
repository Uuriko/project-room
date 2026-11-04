# Explicit disabled local receiver

Source `c60ae4b1dd75da91a7b2acfbb5bcd2cdabd5d0be`, based on exact candidate `680f2b61c2f6679b99c55830af7f1b67516fa5d0`.

`room-acp run --receiver-policy disabled` is a controlled successful exit before loading a saved connection, persisting an approver change, selecting/constructing/probing an adapter, making HTTP requests, reporting presence, acquiring or renewing a listener lease, invoking a model, posting or acknowledging any wake. It creates no new queue/admission/handoff. Existing Room wakes and all local queued, started, result and posted receipts remain untouched. It makes no claim that a capable host has accepted work. It is not a formal-only courier and does not stop another process or release another listener's lease.

The default `respond` path is unchanged. Read-only mode and disabled tools are not treated as evidence of incapability: an explicitly enabled contextual responder can still answer ordinary questions and use the existing formal protocol. The disabled flag applies only to run; join/import/logout/doctor combinations are rejected before invoking those commands. Unknown policy values are rejected before saved-state reads, including direct programmatic run calls. The CLI help and README describe this exact limited policy.

Before: 4 of 5 new controls fail, one default-path control passes. After: 57/57 focused checks pass with zero skips. Tests prove zero network/receiver construction, byte-and-permission equality of all retained local files, no approver mutation, no attempted parse of a poisoned saved connection, no creation of an absent home, explicit run-only parsing, no inference from read-only mode, and unchanged default identity/receiver construction. Existing operator-approval, argument, context-stop and actual formal HTTP/cold SQLite/recovery checks also pass. Manifest 8/8. ESLint, committed diff secret scan and diff check exit zero. Manifest regenerated through official generator: schema 45, 182 assets.

```sh
node --test tests/room-acp-receiver-disabled.test.mjs tests/room-acp-agents.test.js tests/room-acp-operator-consent.test.js tests/room-acp-context-limit.test.mjs tests/room-acp-formal-delivery.test.mjs
node --test tests/candidate-manifest.test.js
node node_modules/eslint/bin/eslint.js room-acp/src/args.mjs room-acp/src/run.mjs tests/room-acp-receiver-disabled.test.mjs
node scripts/secret-scan-diff.mjs --base 680f2b61c
```

No live host, launcher, credential, Room state, lease, ACK, schema or permission changed. No deployment, provider/model or new Native Worker qualification is claimed by this CLI-only lane. Compressed synthetic logs and raw-byte hashes are adjacent.
