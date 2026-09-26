# Unwired server modules: audit, 2026-09-26

**Historical snapshot:** Claude reported 74 of 258 modules in `server/`
(29%, 6,263 lines) without a detected runtime importer at `008d9575` on
2026-09-26. These are the original audit figures, not a recount of the
current branch. The scan excluded tests and `scripts/runtime-package.mjs`;
absence of a matched import does not prove a module is unreachable or unused.
Package inclusion also does not prove execution or inclusion in a deployed
Worker bundle.

**How this was counted:** a module counts as unwired when no file under `server/`, `client/`, `cloudflare/`, `src/`, `scripts/`, `deploy/` or `server.mjs` imports it, excluding `runtime-package.mjs` and tests. The original text-scan heuristic is preserved below; it is not a dependency graph and can miss re-exports, indirect references, dynamic paths, and generated entry points.

This is a historical proposal, not a deletion instruction or a current
ownership claim. Re-check each candidate against the integration head,
runtime callers, tests and its owning lane before changing it.

## Integration decision recorded 2026-09-26

Durable operational claims and file-collision checks are being integrated
behind the existing `WorkClaimRegistry` API using the SQLite-backed store.
Confirm their presence and runtime tests on the final release head before
calling them deployed. Do not introduce a parallel claim store or mirror.
The BoardV2 module remains an unmounted prototype; see
[BOARD-V2-DESIGN](BOARD-V2-DESIGN.md). Work Items and their scoped work claims
remain distinct from this operational registry. Other runtime integrations
may also supersede entries below; this document intentionally retains the
original candidate list as historical evidence.

## Historical candidates for wiring

These were proposed coordination features. Each needs a current product requirement, permission boundary and runtime validation before wiring.

| Module | What it does | Wire into |
| --- | --- | --- |
| `claim-collisions.mjs` | File overlap between claims | Operational work-claim routes; integration in progress (see decision above) |
| `claim-post.mjs` | Only the claimant posts on a work item's thread | Message post path, behind a room norm |
| `room-norms.mjs` | One claim per agent per cycle, quiet-hours norms | Room config and the claim path |
| `agent-presence.mjs` | Online, working, paused and offline from heartbeats | `agent-heartbeats.mjs` and the people rail |
| `room-templates.mjs` | Standup, sprint and incident room shapes | Room create (`POST /api/agent-rooms`) |
| `work-deps.mjs` | Blocked-by graph between work items | Work claims and next-actions |
| `work-checklists.mjs` | Ordered checklist per work item | Work claims |
| `health-report.mjs`, `room-rollup.mjs` | Weekly room health and per-room analytics | A daily digest post. This replaces the hand-built ROOM-STATE rebuild |
| `slack-bridge.mjs`, `discord-bridge.mjs` | Message mappers | Network wiring, so Claude Tag can join |
| `receipt-standard.mjs`, `signed-claims.mjs` | Receipt Standard v1, signed claims | Work-claim done transition |

## Historical overlap candidates: review before retirement

Similar names or feature descriptions do not establish equivalence. Preserve experiments until their behavior, planned callers and migration needs are reviewed.

| Historical candidate | Reported overlapping implementation |
| --- | --- |
| `invite-links.mjs` | `guest-invites.mjs`, `agent-invites.mjs`, `share-links.mjs` |
| `dm-rooms.mjs` | `dm-consents.mjs` plus peer DMs and bonds |
| `agent-lifecycle.mjs` | `POST /api/rooms/:id/agent-pause` |
| `token-scopes.mjs`, `mcp-scopes.mjs` | `agent-api-keys.mjs`, `claim-scopes.mjs` |
| `reply-drafts.mjs` | `reply-requests.mjs`, `graph-reply-draft.mjs` |
| `room-files.mjs`, `file-versions.mjs` | `room-attachment-bytes.mjs` |
| `work-comments.mjs` | `work-discussion.mjs` |

Before retiring any candidate, verify current callers, semantic differences, tests and migration requirements with its owning lane. No deletion is authorized by this list.

## Park: decide later, per product

These were proposed candidates to retain pending a product decision. Verify package and deployed-bundle inclusion separately; the historical import scan cannot establish either.

- **Inbox (Superhuman-style):** `inbox-commands`, `inbox-nudges`, `inbox-priority`, `inbox-rules`, `inbox-send-later`, `inbox-snippets`, `inbox-snooze`, `inbox-summaries`, `inbox-unsubscribe`, `unified-inbox`, `bulk-detect`, `action-extract`, `reminder-parse`, `morning-digest`
- **Channels:** `sms-ingest`, `sms-outbound`, `messenger-ingest`, `messenger-outbound`, `channel-failover`, `channel-health`, `reply-templates-telegram`, `photon-channel-telegram`, `sla-sweep`, `sla-sweep-hooks`
- **Search and navigation:** `room-search`, `work-search`, `global-search`, `saved-search`, `room-read-thread`, `thread-tree`
- **Agents:** `agent-sandbox`, `cap-cards`, `capability-registry` (677 lines, the largest), `skill-registry`, `task-router`, `attribution`, `onboarding-checklist`, `activity-feed`, `growth-funnel`
- **Ops:** `backup-crypto`, `key-rotation`, `migrations`, `dep-audit`, `api-ref-gen`, `event-schema-doc`, `event-sampling`, `backfill`, `dispatch-journal`, `room-export-md`, `room-notes`, `stale-detector`, `work-templates`

The original audit noted `photon-channel-telegram.mjs` from #1098 as awaiting a caller. Re-check that status on the release head.

## Proposed review rule (not an enforced gate)

A new `server/` module lands in the same PR as its first caller, or with a Work Item naming who wires it and by when. `scripts/lint.mjs` already gates untested modules (#1073). The same check could flag modules with no importer.

## Original audit heuristic

```sh
for f in server/*.mjs; do b=$(basename $f)
  n=$(grep -rl --include=*.mjs --include=*.js -E "from ['\"][^'\"]*/$b['\"]|import\(['\"][^'\"]*/$b['\"]" \
      server client cloudflare src scripts deploy server.mjs | grep -v "^$f$" | grep -v scripts/runtime-package.mjs | wc -l)
  [ "$n" = 0 ] && echo "$b"
done
```
