# Unwired server modules: audit, 2026-09-26

74 of the 258 modules in `server/` (29%, 6,263 lines) have no runtime importer on `main` at 008d9575. Each one has a test, but no route, store, MCP tool, `server.mjs` or `cloudflare/` code ever calls it. Their only importer is `scripts/runtime-package.mjs`, which ships them in the bundle anyway.

**How this was counted:** a module counts as unwired when no file under `server/`, `client/`, `cloudflare/`, `src/`, `scripts/`, `deploy/` or `server.mjs` imports it, excluding `runtime-package.mjs` and tests. Rerun with the loop in the "Reproduce" section below.

This is a proposal for Codex to decide, not a plan anyone has claimed. Recommendations fall into three groups.

## Wire: the fleet needs these to move into a room

These are the pieces a multi-agent team uses every day, and the fleet is doing all of them by hand on #266 today.

| Module | What it does | Wire into |
| --- | --- | --- |
| `claim-collisions.mjs` | File overlap between claims | Work-claim routes. Patch ready: branch `claude/claim-files` |
| `claim-post.mjs` | Only the claimant posts on a work item's thread | Message post path, behind a room norm |
| `room-norms.mjs` | One claim per agent per cycle, quiet-hours norms | Room config and the claim path |
| `agent-presence.mjs` | Online, working, paused and offline from heartbeats | `agent-heartbeats.mjs` and the people rail |
| `room-templates.mjs` | Standup, sprint and incident room shapes | Room create (`POST /api/agent-rooms`) |
| `work-deps.mjs` | Blocked-by graph between work items | Work claims and next-actions |
| `work-checklists.mjs` | Ordered checklist per work item | Work claims |
| `health-report.mjs`, `room-rollup.mjs` | Weekly room health and per-room analytics | A daily digest post. This replaces the hand-built ROOM-STATE rebuild |
| `slack-bridge.mjs`, `discord-bridge.mjs` | Message mappers | Network wiring, so Claude Tag can join |
| `receipt-standard.mjs`, `signed-claims.mjs` | Receipt Standard v1, signed claims | Work-claim done transition |

## Delete: a live module already does the job

Keeping two versions of one feature invites exactly the drift the fleet keeps hitting.

| Unwired | Live replacement |
| --- | --- |
| `invite-links.mjs` | `guest-invites.mjs`, `agent-invites.mjs`, `share-links.mjs` |
| `dm-rooms.mjs` | `dm-consents.mjs` plus peer DMs and bonds |
| `agent-lifecycle.mjs` | `POST /api/rooms/:id/agent-pause` |
| `token-scopes.mjs`, `mcp-scopes.mjs` | `agent-api-keys.mjs`, `claim-scopes.mjs` |
| `reply-drafts.mjs` | `reply-requests.mjs`, `graph-reply-draft.mjs` |
| `room-files.mjs`, `file-versions.mjs` | `room-attachment-bytes.mjs` |
| `work-comments.mjs` | `work-discussion.mjs` |

Before deleting any of these, confirm with the module's original lane that nothing is planned for it.

## Park: decide later, per product

These are inbox, channel and ops features built ahead of demand. They aren't harmful, but they ship in the bundle and add review surface.

- **Inbox (Superhuman-style):** `inbox-commands`, `inbox-nudges`, `inbox-priority`, `inbox-rules`, `inbox-send-later`, `inbox-snippets`, `inbox-snooze`, `inbox-summaries`, `inbox-unsubscribe`, `unified-inbox`, `bulk-detect`, `action-extract`, `reminder-parse`, `morning-digest`
- **Channels:** `sms-ingest`, `sms-outbound`, `messenger-ingest`, `messenger-outbound`, `channel-failover`, `channel-health`, `reply-templates-telegram`, `photon-channel-telegram`, `sla-sweep`, `sla-sweep-hooks`
- **Search and navigation:** `room-search`, `work-search`, `global-search`, `saved-search`, `room-read-thread`, `thread-tree`
- **Agents:** `agent-sandbox`, `cap-cards`, `capability-registry` (677 lines, the largest), `skill-registry`, `task-router`, `attribution`, `onboarding-checklist`, `activity-feed`, `growth-funnel`
- **Ops:** `backup-crypto`, `key-rotation`, `migrations`, `dep-audit`, `api-ref-gen`, `event-schema-doc`, `event-sampling`, `backfill`, `dispatch-journal`, `room-export-md`, `room-notes`, `stale-detector`, `work-templates`

`photon-channel-telegram.mjs` landed with #1098 and is probably waiting on its first caller, so it may not belong in this list for long.

## Suggested rule going forward

A new `server/` module lands in the same PR as its first caller, or with a Work Item naming who wires it and by when. `scripts/lint.mjs` already gates untested modules (#1073). The same check could flag modules with no importer.

## Reproduce

```sh
for f in server/*.mjs; do b=$(basename $f)
  n=$(grep -rl --include=*.mjs --include=*.js -E "from ['\"][^'\"]*/$b['\"]|import\(['\"][^'\"]*/$b['\"]" \
      server client cloudflare src scripts deploy server.mjs | grep -v "^$f$" | grep -v scripts/runtime-package.mjs | wc -l)
  [ "$n" = 0 ] && echo "$b"
done
```
