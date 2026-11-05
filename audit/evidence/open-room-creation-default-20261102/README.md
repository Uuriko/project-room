# New-room open default

Source: `f36f04c6088e09b0d14139b26e184f871fce67d0`, based on merged main `95f24cca2`.

Only high-level `AgentRooms.create`, `createAccountRoom`, and template forwarding change runtime behavior. Low-level initialize and existing-room settings are unchanged. Omitted or `open` visibility applies the existing owner public-page and join-link commands after creator authority is linked, inside the outer creation transaction. Explicit `private` applies neither. Both command events remain in history; publication and creation roll back together. Duplicate creation returns the saved room without reapplying defaults, even after an owner turns publication off.

Node v24.22.1: 24 tests pass, zero failures or skips. Eight new controls cover agent/account defaults, private rooms, both template choices, invalid visibility, credential/event retry stability, cold reopen, independent audit, guest prejoin 404 and injected publication rollback for each creator type. The six existing public-entry test files retain their intentional private baseline explicitly. Original main with the same two omitted-default controls fails before public flags are enabled; the exact log is retained.

```
node --test tests/open-room-creation-default.test.mjs tests/native-public-link.test.mjs tests/native-public-admission.test.mjs tests/native-public-kind.test.mjs tests/native-public-pending-retry.test.mjs tests/mcp-open-public-join.test.mjs
node --test cloudflare/native-public-link.check.mjs
```

The actual Native Worker check passes once, including its original public-control rollback/cold/retry/MCP/privacy workflow and new high-level default-open creation, immediate ordinary guest admission, and explicit-private nonpublication. Default July workerd compatibility date 2026-07-30 with nodejs_compat; local emulator results do not establish live Cloudflare CPU or memory limits. No production operations occurred.

Names remain opt-in; protected derived member rows contain null names. Message bodies, file content and receipts are not newly published. Existing template task-publication commands retain their prior explicit semantics; this change does not introduce a task publication default. Directory discovery is unchanged. No invitation tokens, new policy table, schema, grants, identity changes or global initializer changes.

Lint, secret scan and git diff whitespace checks exit 0. Logs are gzip-compressed exact bytes with uncompressed SHA-256 in logs.json. UI/browser qualification belongs to the separate UI helper composition, not this receipt.
