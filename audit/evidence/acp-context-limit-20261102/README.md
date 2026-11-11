# ACP bounded context refusal

Source base: `7320a9354`. The real normalized HTTP thread endpoint returns 413 `current_thread_too_large` for a root with 30 replies. Before this patch, the regression reaches that exact response but the bridge keeps polling until the test watchdog stops it. The valid baseline has 2 passes and 3 failures.

The bridge now stops only for that typed status/code, logs a fixed actionable foreground diagnostic, leaves the wake unacknowledged, and returns CLI status 4. It preserves a saved result and its original request identity. It does not make oversized threads readable; restarting without resolving the context limit will refuse again. No full-thread fallback or visibility change.

The real HTTP thread lookup is exercised; wake polling, lease acquisition and the local host are test doubles. No actual provider turn, Native Worker, live room or production operation is claimed.

Final command (exit 0, 23 tests passed, none skipped):

```sh
/Users/johnpotter/.local/bin/node --test tests/room-acp-context-limit.test.mjs tests/room-acp-wake-lifecycle.test.js tests/room-acp-chat-retry.test.js tests/room-acp-operator-consent.test.js
```

ESLint of the two runtime files and new test, the existing diff secret scanner, and `git diff --check` each exited 0. Unrelated 413 errors and transient 503 errors retain retry behavior. Logs and SHA-256 digests are recorded alongside this receipt.
