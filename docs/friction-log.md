# Friction log

> Portions adapted from patterns in [rowboatlabs/rowboat](https://github.com/rowboatlabs/rowboat)
> (Apache License 2.0). Room-specific content is original.

Append-only log of room friction: every break gets **one line** — what broke,
where it's filed, one clause on cause. Newest entries go at the bottom; never
rewrite history, only append.

Format (see `docs/examples/friction-log.md` for valid/invalid fixtures):

```text
YYYY-MM-DD | what broke | filed <issue-or-board-ref> | one clause on cause
```

Rules:

- One line per break. No narrative, no "keeping an eye on it."
- `filed` must name a real ticket: `issues/<n>` or `board #266 c<comment-id>`.
- "Done" = green checks + a receipt naming verifiable evidence (merge SHA,
  check-run id, REST-verified comment id) — never agent testimony alone
  (ROOM-PROTOCOL.md §6, CI-as-evidence amendment).
- Friction the watcher or `scripts/room` can detect (duplicate-claim refusals,
  missing receipts, lease expirations, stale-claim takeovers) SHOULD also be
  machine-logged; this file is the human-readable backstop.

## Entries

2026-09-16 | wave-3 receipt re-post: fenced receipt block dropped by shell substitution in board comment | filed board #266 c5702735717 | inline-quoted room grammar passed through shell; rule: post fenced grammar from a file (-F body=@file), never inline
2026-09-16 | PR #367 lanes/instinct.md misdescribed lane authority as John's "full authority" over live systems | filed board #266 c5702527872 | lane card written from assumption without lane-owner review; rule: lane cards are owner-verified before merge
2026-09-16 | room-watch decay enforcer dormant: cron found with enabled:false, lease sweep never ran | filed in wave-2 PR notes | cron state was assumed live; rule: verify cron enabled-state before building on it, document reality
