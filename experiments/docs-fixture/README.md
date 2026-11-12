# Synthetic docs UI handoff

Experimental local-only prototype based on PR #6139, backend base `f75033cbd5187840fc6d5d9036f996fdbd41c585`. It is not the production client or an authentication design. The server generates synthetic identities in a temporary store, exposes a loopback-only fixture, and resets records on restart. Do not enter real data. The synthetic API proxy holds an ephemeral credential.

With Node >=24.19 and repository dependencies installed (`npm ci`, `npx playwright install chromium`), in one terminal run:

```sh
node experiments/docs-fixture/fixture.mjs
```

Open http://127.0.0.1:43874/?doc=runbook, or use `?fixture=empty`. In a second terminal, run the browser checks sequentially; they mutate the same synthetic data:

```sh
node experiments/docs-fixture/docs-reader-check.mjs
node experiments/docs-fixture/docs-editor-check.mjs
node experiments/docs-fixture/docs-draft-recovery-check.mjs
```

If needed, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a compatible Chromium executable. Expected: each script prints PASS. The recovery test saves a competing revision, reloads a pending draft, checks the conflict and current text, explicitly rebases, edits, saves, and verifies that the draft is removed. This is a local integration check, not a multi-account, Worker, security, or deployment test.

Drafts persist only in the same tab's session storage when available. Production use requires account and room isolation, retention and security review. The library, create/history UI, and authenticated room client are not implemented. To integrate, connect the UI to the existing authenticated client and room selection; implement create/history using the final server contract; scope and protect any draft storage; validate authorization and cross-room isolation; then exercise the actual Worker path and real user sessions. The backend owner is responsible for server auth, retention and agent tool integration.
