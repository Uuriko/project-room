# Native-host request exercise: partial acceptance

September 8, 2026. **Native producer flow confirmed; independent native review is
not complete.** Local synthetic data only. No deployment or live Room changes.

## What actually ran

| Participant | Native host | Observed result |
| --- | --- | --- |
| Producer, first process | Codex CLI 0.153.4 | 10 completed MCP calls: authenticated, pulled v3 attention, read context, acknowledged exact notices and authored a clarification. No work started. |
| Producer, fresh process | Codex CLI 0.153.4 | 18 completed MCP calls: discovered changed context after a simulated human reply, accepted/started work, authored and inspected an immutable draft, submitted its exact result, and answered the request. |
| Independent reviewer | Claude Code 2.1.259 | Connected and inspected the stored result; 12 attempted tool calls. Three discovery reads were denied by the test's approval list. It did not record verification. |

The producer's actual question was “How many minutes should the first project-room
session last?” The coordinator supplied the only simulated human contribution:
20 minutes, four timeboxed items, at most 45 words, Room owner named, newcomer
participation and a concrete next step. The second producer was a fresh native
process, not a scripted answer or continuation with the earlier chat transcript.

Final Room state: sequence18, work completed/revision3, request answered/revision1,
verification null, human decision null. Owner, producer and reviewer read markers
are all0. Current next action remains review by `reviewer`.

The original result is273 UTF-8 bytes with evidence version
`sha256:86eebe9bc1bb1664635928a5fdce962cd6ff6fded852048c4fd289edcc149063`.
Completion event `9dca8aae-f444-466f-b457-fb562303ee06` is correlated to the native
producer's actual tool receipt and exact business-operation ID. A read-only audit
also matches the clarification, draft and answer to canonical events and recomputes
the result hash. The schema12 recovery audit passes. This is evidence consistency,
not cryptographic proof of vendor identity or full feature acceptance.

## What the exercise uncovered

1. **A reviewer needs the full inspection path.** The test approved selected work
   and result reads but omitted `room_read_work_discussion`. The work's original
   source was an ordinary message; the later work-linked request held the clarified
   requirements. Claude correctly refused to claim it checked inaccessible context.
   The harness now includes the scoped discussion reader and explicitly identifies
   the request. Unselected Claude tools are hidden as well as unapproved, avoiding
   a misleading menu of denied routes. This configuration correction is not yet
   native-rerun-qualified. Room membership/verification permissions are unchanged.
2. **Host success is not task success.** Claude exited0 with a successful host
   response, while Room verification remained null. The evidence audit reports
   `acceptance: partial`, never a completed review based on exit status.
3. **Output criteria need a counting convention.** The agenda has47 whitespace
   tokens or43 words excluding its four list markers. Do not claim an unqualified
   45-word pass before the reviewer checks the intended convention.
4. **Duplicate text adds noise.** The producer copied the full agenda into its
   request answer after already storing it as a work result. A future guidance
   improvement should favor a brief result reference unless full text is requested;
   do not silently remove or rewrite an existing answer.
5. **Native Codex shutdown is not cleanly qualified.** Both runs completed their
   operations and exited0 but emitted an MCP startup-path warning during shutdown,
   plus local rollout-index warnings. No user caches/settings were reset to hide it.

## Approval boundary

Existing authentication was checked without exposing account identifiers:
Codex reported ChatGPT login; Claude reported `claude.ai` login. No API keys were
supplied, subscriptions purchased or provider/billing settings changed. This is
**not a zero-cost claim**: existing subscriptions can have usage limits or charges.

The corrected Claude rerun was rejected by approval review over potential billable
subscription usage. It did not start. No alternate host or indirect command was
used to bypass that refusal. Further native model runs require current explicit
user approval covering their usage. Local code, evidence and package checks can
continue without starting models. The overall project is not blocked or complete.

## Reusable tooling and evidence

- `scripts/request-host-fixture.mjs`: creates only a fresh loopback fixture; staged
  simulated-human clarification requires an actual producer question first.
- `scripts/native-host-request-run.mjs`: manual, not part of automatic test runs.
  Per-run configuration only; bounded runtime/output, exclusive evidence reservation,
  no builtin shell/browser tools, and a phase-specific Room tool list. Running it
  still requires the approval described above; the script is not that approval.
- `scripts/audit-native-request-evidence.mjs`: read-only transcript/event/hash audit,
  explicitly recognizing this partial outcome. No model, network or credentials.
- `tests/native-host-run-guards.test.js`: invalid input and existing-evidence refusal
  are tested before any host can start. Automatic checks do not consume model usage.

Raw private test evidence is currently retained outside the checkout:

- `/private/tmp/project-room-native-request-evidence-20260908.json`
- `/private/tmp/project-room-native-codex-clarify-20260908.json`
- `/private/tmp/project-room-native-codex-produce-20260908.json`
- `/private/tmp/project-room-native-claude-review-20260908.json`

These temporary files are not a durable release artifact. The discarded fixture
and its credentials cannot be resumed; a later approved exercise needs fresh setup.
Its control process exited normally. Existing preview64985 remains preserved.
No product runtime/UI/schema was changed in this turn. Final local core/API/package
rerun: **536 passed**, including the two model-free guard tests. Prior168 browser
and13 local Worker checks were not rerun in this harness/documentation-only turn.

## Source-informed setup

OpenAI Docs guided per-invocation overrides and selected MCP tools, avoiding saved
host configuration edits. [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp),
[one-off overrides](https://learn.chatgpt.com/docs/config-file/config-advanced).
Claude's CLI documentation distinguishes allowed tools, restricted execution,
explicit MCP configuration and no-session-persistence; tool approval and tool
visibility must both be considered. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

Next: qualify the complete native review after usage approval; clarify word-count
criteria and reduce duplicated result answers. Independently continue the current
schema12 release/fallback/recovery package; do not publish without approval.
