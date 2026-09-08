# Bounded work search for connected agents

## Decision

Bring the already-tested room work search to the existing client orientation and
MCP work list. Agents should be able to find an earlier outcome or relevant work
without consuming every complete task record. Discovery remains separate from
assignment, execution and approval. Do not add a tool, endpoint or search index.

## Implementation plan

1. Add optional `query` to `client.orient` and `room_list_work`. Omission preserves
   both the full default and existing `needs_me` output. Explicit queries must be
   nonblank strings, at most200 UTF-16 code units before trimming; invalid input
   fails before private reads and diagnostics do not echo it. Preserve literal,
   case-insensitive matching through the shared selector; no new query language.
2. Filter `needs_me` candidates before search/ranking/limit. A query plus focus is
   intersection, not a union or recommendation. Keep assignments visible when
   their Room action permissions are missing. Use one explicit client clock.
3. Reuse shared current-field matching and open-first/recency ordering. Return at
   most25 compact work identities/revisions/states, excerpts, next-step/action
   descriptions and exact selected-work read pointers. Report room count, eligible
   count, match count, shown count and truncation. Preserve charter, current member
   and scope; disclose omitted context and refine-query guidance. No persistent
   result cursor or historical/full-text completeness claim.
4. Add `agent-inbox.mjs search "phrase" [--needs-me]` with strict syntax before
   reading private configuration. Preserve all existing commands and their output.
   Do not put credentials in command arguments or query text. A query is ordinary
   operator input and may appear in local shell/process tooling; no query history
   or telemetry service is added by Room.
5. Exercise actual local client, scripted MCP and CLI processes: defaults, bounded
   outputs, Unicode excerpts, many nonmatching/other-owner tasks, intersection
   before truncation, selected reads, current-result replacement, inactive/revoked
   identity, cancellation, invalid syntax and unchanged all-table audits.
6. Review public-asset hashes before deciding whether browser rendering needs a
   rerun. Qualify exact local candidate/fallback packages, update handoff and peers,
   and keep the larger goal active. Never invoke a native model or deploy here.

## Research and boundaries

The [pinned MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
supports explicit input schemas and structured results, with serialized text for
compatibility; annotations are not trustworthy permission enforcement. We retain
the existing protocol version and adapter, validate the optional input, and keep
normal service authorization. No source code is copied. The human-side
[search research and selector contract](WORK-SEARCH-2026-09-08.md) remain applicable.

This still obtains the authenticated Room snapshot internally. It reduces displayed
work context, not snapshot network cost, membership scope or credential authority.
Only current work fields are searched, not message bodies, old evidence versions,
external files or private drafts. Returned text is untrusted Room content. A hit
does not prove availability or suitability; an empty result does not mean the room
is done. Reads never acknowledge attention or human read markers.

## Verification

Implemented shared bounded discovery across the existing interfaces. All562
core/API/package checks pass, including six new real local HTTP/MCP/CLI tests.
The focused search and prior focused-list checks also pass together (11 tests).
Invalid inputs fail before private reads; cancellation, revoked credentials,
focus-before-limit, exact selected reads and all20-table read-only audits pass.
Tests use scripted participants, not native AI reasoning or human research.

All19 public assets are byte-identical to retained candidate-b29dcc3. The prior174
general browser and one Workers browser check are not rerun or claimed as new
results; no new UI screenshot is needed. Synthetic protocol evidence is captured
in `test-results/agent-work-search.json` and retained in the sibling runtime package
directory at `evidence-cefc89b/agent-work-search.json`.

Runtime `cefc89bc04a0df049f78ecbae8949e240525068a` is retained in
`../project-room-runtime-packages-20260908/candidate-cefc89b`:65files,19assets,
schema12. Manifest SHA256:
`59c1bf5cfa75636840c2c0c7b8c7b614e5366e9bb0d608b9881b587482874a7f`.
Fallback remains `4d22189ccdebc56db23397e6cc75b07eff0e3c2c`; older packages are
preserved. Both packages verify after testing.

Final qualification adds13 passing local Workers runtime checks, including the
actual retained20-table candidate/fallback switch, and two passing exact-commit
desktop/touch browser recovery journeys. Two additional smoke checks run the
retained candidate's actual search CLI against both retained Node servers, each
with disposable synthetic data and unchanged all-table audits. This does not add
search to the older fallback CLI; use the new client against the compatible service.
Workers synthetic restart evidence remains at
`/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-cf-store-0OcXVV`.
None of these checks certifies provider recovery or current restored authority.

No native model, push, deployment, provider change or existing preview restart.
The larger goal remains active/incomplete.

Now: preserve and qualify this local checkpoint.
Next: use the selected-read pointers in a scripted contribution/reuse journey,
without treating search as a dispatch system. Native-model acceptance and hosted
recovery/current-authority freshness remain separate approval gates.
