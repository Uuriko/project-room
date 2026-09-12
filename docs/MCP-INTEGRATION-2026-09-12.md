# MCP preview integration checkpoint

Branch `codex/project-room-integration`, commit `ea676ef`, based on repaired
`24d0027`. Canonical checkout was not modified. Its local main was 114 commits
behind audited origin/main, so it was not used wholesale as the candidate.

Selected Grok snapshot: public MCP module, open contract, join notice, HTTP tests
and preview documentation. Source hashes were checked before and after reading.
The HTTP MCP routing hunks were applied to the repaired server while preserving
thread guards, import refusal and diagnostic redaction. Existing Node JSON header
handling was retained; focused tests prove Allow and CORS headers survive there.
Alternate-runtime transport parity still needs explicit qualification.

Added the two imported server modules to exact-runtime packaging. Corrected stale
preview documentation: no ephemeral join, no wildcard CORS, no join-required loop.
Membership is not persisted; tools do not read private rooms or execute models.
The source join-notice helper is not wired into a new human join page here.

## Evidence

22 focused MCP/thread/import tests passed before commit. They exercise the new
preview and retained security guards together. A fresh full check against the
integration run completed:1,178 passed, zero failures/skips,102,068 ms. The first package run exposed an
old expected file count (98 vs100); the corrected test now imports both MCP
modules from the cold package and verifies preview behavior. Final focused cold
package tests:2 passed, zero failures/skips. The whole run started before that
test correction. A subsequent exact-state gate ran against unchanged commit
`08868ebc3ba281cec3c52daf370f69b8555aedd3`: 1,178 passed, zero failures/skips,
77,791 ms. HEAD and clean status were checked before and after that run.

This is not production/publication approval or full MCP protocol conformance.
No self-join, registry listing, hosted route, paid model call or deployment was
enabled externally. Broader product scope remains in the implementation handoff.

## Snapshot hashes (source before integration)

```
0a0822013b78b0cf5c0a72f156ba851b6612654ae92d09d5f523710ac5937462  client/mcp-public.mjs
d6fa41f8ece5b23703cdc0c27c69a16386658f87eae23373756d1a8b0c1d858a  server/open-contract.mjs
73e5c698422c41eda140f7da4e68c6387f1a65803f00cc4d4eb5358d8e06983b  src/agent-join-notice.js
42c323c7e85324ed042c920d715099d735a2f997891e523dd7a703c0ac2b6537  tests/mcp-http.test.js
e04d509134fa0206a71a3bc7e45320df91e02e722b0d7243ef2f0b55e4f5a3d8  docs/OPEN-JOIN.md
d250c442e45670317ffa57a6cae13936baf9aeeee88cb7837ada1a925add3868  server/http.mjs
```
