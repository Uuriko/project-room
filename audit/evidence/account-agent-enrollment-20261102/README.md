# Account-controlled existing-agent enrollment: offline readers-first qualification

Source `86effdc5874c1212994d1d8b5debd990d3463645`, based on exact main `2bf4cfb7d15265d6b6f690e0659a0c38a88ca25e`. Apply the four source commits in receipt.json order. Add server/account-agent-enrollment.mjs to the existing runtime package allowlist and regenerate the composed public-asset manifest.

Creation and UI choices are disabled by default, with no production environment wiring. This is a readers-first checkpoint, not live enrollment approval. Server OAuth client preferences provide configured authority. Only current account-controlled configured/managed/adopted seats qualify; sponsorship or caller-supplied preference IDs do not suffice. Explicit signed-in target owner consent names the existing identity/member, target room and exact server profile permissions.

New membership, identity link, target-only discarded-raw credential hash and append-only enrollment basis commit atomically through the existing managed writer. No identity or onboarding/API token is minted, no global secret is rotated, and no source security records are copied. Separate target OAuth consent is required. Target authorization remains independent after source archive. Generic invited Dot is not claimed supported.

## Exact completed checks

Final affected Node: **39/39 passed, zero skipped**, including two production UI closure controls.

```sh
/Users/johnpotter/.local/bin/node --test tests/account-agent-enrollment.test.mjs tests/account-agent-enrollment-http.test.mjs tests/account-agent-enrollment-ui.test.mjs tests/agent-connections-identityid.test.js tests/agent-connections-fences.test.js tests/normalized-connection-lifecycle.test.mjs
```

Actual default July Native: **1/1 passed, zero skipped**.

```sh
/Users/johnpotter/.local/bin/node --test cloudflare/account-agent-enrollment.check.mjs
```

Controls cover owner/CSRF/default-off boundaries; actual HTTP OAuth code/refresh and MCP target binding after source archive; same identity/source connection; configured/managed/adopted eligibility; uncontrolled/foreign/bearer refusal; stale identity/account/member/owner authority; protected source corruption; interrupted-save rollback; exact lost-ACK/cold retry; full export/restore with literal recovery oracle. Native restore uses actual synchronous replay/full audit on a small synthetic store, not a large restore cost claim. UI controls execute production consent/retry closures in a VM and verify confirmation content, save-before-send and serialized request/ID equality across reload-style retry. No actual browser run is claimed; Fo owns that lane.

Scoped ESLint, final i18n harness, OpenAPI fragment generation/check and committed secret diff each exited 0. Logs and full hashes are in receipt.json. The initial 4/6 run had two fixture mistakes: token conflict occurred before the intended forged-reference assertion, and the test called nonexistent rotateSecret. These are not product failure reproductions. Initial i18n exposed three hardcoded diagnostics; these were catalogued without a waiver.

## Explicit rollback boundary

The frozen original 2bf AgentConnections test fixture retains original code with import paths adjusted and its original SHA-256 recorded. Old audit refuses the new proof. A preopened old instance can perform an otherwise-authorized rotation, but immutable generation-1 authority remains unchanged and new full audit passes. Old audit still refuses the new proof.

The actual cold-admission qualification verifies original store/connections/recovery bytes against 2bf, opens a disposable enrolled file using that original authority tree and proves connection_integrity_error, then opens it with new code and proves full audit success:

```sh
/Users/johnpotter/.local/bin/node audit/evidence/account-agent-enrollment-20261102/qualify-old-cold.mjs /path/to/original-2bf-authority-checkout
```

Recorded run used pr-assistant-cancellation-1102, whose relevant server authority files exactly match 2bf. Its client-only cancellation changes are outside this authority check. Deploy and verify new readers as the rollback floor BEFORE enabling creation. Old 2bf rollback after enrollment is unsupported without a compatibility backport or pre-enrollment restore. Root owns composition, staging, rollout and explicit activation. No production calls or enrollment performed.
