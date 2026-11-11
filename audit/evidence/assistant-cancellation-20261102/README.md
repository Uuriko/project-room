# Assistant request cancellation and error ownership

Source `2db087a99c474583124dcde77748e5a2086ca7be`, based on exact main `2bf4cfb7d15265d6b6f690e0659a0c38a88ca25e`.

The RoomClient deadline abort reached the assistant panel as the browser's raw AbortError. Only an AbortError caused by this request's own unchanged 10-second timer is now classified `request_timeout`, with readable catalogued copy. It retains `name: AbortError` and no HTTP rejection status. Other aborts, network errors and real service codes remain unchanged, including an actual 503 completing at the deadline. Timeout does not prove a write failed or canceled.

The assistant's read error previously occupied the same variable as an uncertain write and survived successful reads. Read errors now have separate ownership: successful refresh clears only its own failure; a pending write remains available for its exact retry. The existing boundary checks prevent an obsolete read from publishing into another room. Initial read failures remain visible even without an assistant projection.

## Causal and affected checks

Transport controls against the original base: 5 tests, 3 passed and 2 failed. Refresh ownership controls against the original base: 3 tests, 1 passed and 2 failed. Both failing logs are preserved. The final affected command passed 66/66 with no skips:

```sh
/Users/johnpotter/.local/bin/node --test tests/assistant-request-timeout.test.mjs tests/assistant-refresh-error-ownership.test.mjs tests/client-recent-refresh.test.js tests/client-recovery-cooldown.test.js tests/client-stream.test.js tests/ask-card-face.test.js
```

The focused tests exercise RoomClient with deterministic timers, plus the actual production refresh/invoke function bodies in a VM with supplied DOM/transport boundaries. An uncertain assistant invocation keeps the identical pending object and request ID for retry; a genuine 409 remains rejected and requires explicit review. These are not actual browser or live service tests. Fo retains the browser lane.

Other completed commands, each exit 0:

```sh
./node_modules/.bin/eslint src/client.js src/human-experience.js tests/assistant-request-timeout.test.mjs tests/assistant-refresh-error-ownership.test.mjs
/Users/johnpotter/.local/bin/node scripts/i18n-harness.mjs --check
/Users/johnpotter/.local/bin/node scripts/secret-scan-diff.mjs --base 2bf4cfb7d15265d6b6f690e0659a0c38a88ca25e
git diff --check
```

No auth, storage, connection or server behavior changes. Root owns composition, candidate-manifest regeneration, publication and live verification. Log hashes and runtime are in receipt.json.
