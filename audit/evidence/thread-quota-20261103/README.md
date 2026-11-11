# Aggregate thread quota classification

Source: `4e84eef846b1c11c4d829de6a5bdd9c859bde9b4`, based on current main `0d92eb3885a6bd2a39bbc65e09225fc098ba6335`.

Synthetic legal root with 24 separately committed replies of 8,192 characters: selected GET succeeds, full GET exhausts aggregate input. Before: one causal failure (expected 413, actual 409), with the nonparty/corrupt-data control passing. After: full read returns existing `413 current_thread_too_large`; the unmodified ACP bridge persists the batch queued/blocked without prompting or ACK, then answers the independent later question. This avoids classifying generic 409 failures as parkable.

The internal quota subclass has the same public status, code, and message. Translation begins only after authentication, history/DM checks, and the selected protected message succeed. The 200-record and 256 KiB limits are unchanged. Per-entity geometry refusals retain their original type; no catch by message/code string. A generic ServiceError with identical public code/message still returns 409. Nonparty DM returns 404; tampered protected body returns 500. No schema, permission, credential, listener policy, live process or stored receipt changes.

Commands (Node v24.22.1):

```sh
node --test tests/current-thread-quota.test.mjs tests/current-thread-http.test.mjs tests/room-acp-park-context.test.mjs tests/candidate-manifest.test.js
node --test cloudflare/thread-quota-native.check.mjs
node node_modules/eslint/bin/eslint.js server/conversation-sync.mjs server/current-room-repository.mjs tests/current-thread-quota.test.mjs cloudflare/thread-quota-native.check.mjs cloudflare/thread-quota-native.test-fixture.mjs
node scripts/secret-scan-diff.mjs --files server/current-room-repository.mjs server/conversation-sync.mjs tests/current-thread-quota.test.mjs cloudflare/thread-quota-native.check.mjs cloudflare/thread-quota-native.test-fixture.mjs
```

28 Node checks pass, zero skipped. One actual local Native Worker check passes using default July compatibility, including disposal/cold reopen and selected/full/small HTTP reads. This is not deployed Cloudflare CPU/memory or live listener qualification. The original Native attempt lacked the dependency symlink; after reusing the existing Cloudflare dependency runtime it passed. No dependency or version change was made. ESLint exits zero with three inherited raw-members warnings outside this patch. Secret scan and diff check pass. Candidate manifest regenerated through the official generator: schema 45, 182 assets. Native test is registered in the existing Cloudflare test command. Hashed compressed logs and raw-byte hashes are in this directory.
