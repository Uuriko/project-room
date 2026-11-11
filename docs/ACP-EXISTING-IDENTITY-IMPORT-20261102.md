# ACP existing identity import — 2026-11-02

Source `316422a46ca551ef0676988ea5fd6e942064a6ff`, based on root candidate `16817b17debd1cc515be50ec5327f9a6ee75002e`.

```sh
node room-acp/src/cli.mjs import-identity --identity-from <own-private-CLI-connection-directory> --room room-fafdae79cf8c
node room-acp/src/cli.mjs run --room room-fafdae79cf8c --agent codex
```

Import reads the existing private `connection.json` in memory, authenticates its global identity and checks exact active membership before issuing a dedicated scoped key for the same identity. The original connection file is unchanged. The ACP saved connection and private operation receipt contain only the scoped result, never the global bearer. No invitation, identity creation or rotation is used. It uses the existing SQLite ownership journals and atomic credential save.

The 30-day key has `mcp:room:<target>`, `rooms:read`, `rooms:write`, `heartbeats:report`, `heartbeats:read`. The three release/read/write scopes alone are insufficient for ACP: causal removal of the last two scopes fails the actual local heartbeat with `403 insufficient_scope` / `heartbeats:report`. Scoped listener binding still prevents other-room reads. No MCP-only inbox/wake scopes are needed for this HTTP adapter.

Generic `POST /api/agent-keys` has no issuance replay contract. A lost issuance response is explicitly unknown; retry stops without another issue and names its stable operation label for API-key-list reconciliation. An interrupted final save reuses the durably captured scoped result. Concurrent imports issue once, and uncertain ownership blocks a competing invitation. Existing saved ACP connections are checked and reused without replacement. There is no automatic revoke, rotate or uncertain-operation reset.

Validation on the exact source: `node --test tests/room-acp-import-identity.test.js tests/room-acp-join.test.js tests/room-acp-saved-identity.test.js tests/room-acp-preflight.test.js tests/room-acp-agents.test.js tests/room-acp-pack-npm.test.js tests/runtime-pack-build.test.js`: **54/54 pass**, no skips. New cases use real in-process HTTP and prove identity continuity, heartbeat/poll, posting, other-room403, no global persistence/logging, private file permissions, save recovery, unknown-response refusal and concurrency. The actual ACP Bridge with scripted fake adapter responds to a mention as the original member. The public archive explicitly includes the new module; packaged CLI module help loads successfully.

`node scripts/lint.mjs`: exit0, zero errors,365warnings. `git diff --check`: pass. Node26.8.2. Initial package-help harness used a direct temporary path whose `/var` versus `/private/var` spelling bypassed the existing entrypoint guard; invoking the exported packaged main function corrected that test harness. No production identity, credential, endpoint, model or adapter was used. Live real-adapter qualification remains separate.

## Already-issued key import (actual other-laptop format)

Source `8cafd1f587567c251a6f36c6817801d4b869f17f` adds the smaller no-issuance path:

```sh
node room-acp/src/cli.mjs import-credential --credential-file <private-key-JSON> --origin https://room.trydemigod.com --room room-fafdae79cf8c --expected-identity <exact-identity-id>
```

The other laptop confirmed only safe field names/types in Room sequence26388: `credential:string`, `keyId:string`, `identityId:string`, `roomId:string`, `expiresAt:number`, `scopes:array<string>`; no origin field. That existing0600 file is accepted without converting or copying a global identity. The caller supplies explicit origin, target and expected identity. Existing hosted MCP `room_check_access` verifies the authenticated identity/member rather than trusting local identity metadata; target `view=identity` then verifies active membership. Only that exact scoped key, supplied expiry/scopes, authoritative current permissions and explicit origin/room are saved atomically. Source file bytes stay unchanged. Same import retries preserve saved bytes; another saved key or unresolved setup is never replaced. No key issuance/rotation/revocation/admission call is made, and no global credential is needed.

Exact source qualification: the seven-file command above passes **57/57**, no skips. New tests use the real retained shape and real HTTP to verify metadata mismatch/expiry refusal, unknown-read no-save, actual other authenticated identity refusal, final-save retry, no remote business writes and no duplicate key issuance. A causal control bypassing only the authenticated identity equality check makes the wrong-identity test fail with missing expected rejection. Restored source remains clean. Lint exit0, zero errors,365warnings; diff-check pass. Real other-laptop source/adapter/live-room qualification remains external to this local result.
