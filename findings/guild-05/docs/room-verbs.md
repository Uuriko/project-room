# scripts/room — reference (guild-05 D1)

## Purpose

room — typed CLI for the project-room claims board (Uuriko/project-room#1160).

Scheduler/board discipline adapted from rowboatlabs/rowboat
(https://github.com/rowboatlabs/rowboat), (c) rowboatlabs, licensed under
the Apache License 2.0. Rowboat's durable-log + stamp-at-write discipline
(agents write structured claims/receipts; tooling reads the fenced blocks,
never the prose) is ported here to the GitHub-issues substrate: comments
are the events, gh REST is the only transport, and docs/ROOM-PROTOCOL.md
is the protocol's only editable surface.

No servers, no daemons, no config files. Dependencies: bash, gh, jq.
Board address defaults to Uuriko/project-room#1160 (see --repo/--issue).

Exit codes: 0 ok · 2 refused by guard (duplicate-claim) · 1 error.

set -euo pipefail

VERSION="0.1.0"

## Architecture
- Single bash file, `set -euo pipefail`. Deps: bash, gh, jq. No servers/daemons/config.
- Board substrate: GitHub issue comments (default Uuriko/project-room#1160); gh REST is the only transport.
- Pipeline: fetch_comments -> parse_events (jq) -> reduce_state (jq) -> verbs (claim/heartbeat/release/handoff/receipt/query/sweep/rebuild/metrics/backlog).

## Verbs (from usage())
  claim     --task-id ID --lane LANE --files f1,f2 --lease Nh --reason "..."
  heartbeat --task-id ID --lane LANE [--note "..."] [--dry-run]
  release   --task-id ID --lane LANE --reason "..." [--dry-run]
  query     [--lane LANE] [--status S] [--file F] [--work-for LANE]
  overlaps  [--files "a,b"] [--state PATH] [--live]
  claim-status --task-id ID [--state PATH]
  handoff   --task-id ID --from LANE --to LANE --context "..." [--note "..."] [--dry-run]
  receipt   --task-id ID --lane LANE --merged SHA|none [--pr N|none] [--tests "..."]
  backlog   [list] [--file PATH]
  backlog   pull [--lane LANE] [--task-id ID] [--lease Nh] [--file PATH] [--dry-run]
  backlog   done BL-NNN [--pr NNNN] [--file PATH] [--dry-run]
  rebuild   [--out PATH] [--commit-push]
  sweep     [--dry-run]
  receipts-scan [--post] [--dry-run]
  metrics   [--since YYYY-MM-DD|ISO-TIMESTAMP]
            claims_opened/completed/expired, receipts, missing_receipts,

## Key functions (78 total)
33:die
34:warn
38:need_val
43:need
47:iso_now
49:iso_epoch
54:httpdate_epoch
75:board_now
88:clock_now
114:lease_now
120:state_canon_rows
132:enforcer_lock
160:trim
165:one_line
170:repo_root
174:board_addr
180:usage
274:gh_api
278:fetch_comments
284:comment_count
289:post_comment
309:parse_events
629:reduce_state
1316:build_state
1353:render_md
1440:registry_json
1458:attribution
1462:claim_block_text
1467:receipt_block_text
1476:handoff_block_text
1481:suffix_line
1485:latest_block
1505:cmd_claim
1608:cmd_heartbeat
1634:cmd_release
1658:cmd_handoff
1691:cmd_receipt
1739:file_rows_json
1766:live_rows_json
1784:cmd_query
1825:cmd_overlaps
1874:cmd_claim_status
1924:room_self_path
1931:guard_enforcer_freshness
1956:cmd_rebuild
1983:rebuild_commit_push
2030:human_dur
2037:sweep_emit
2046:sweep_strike_one
2061:sweep_strike_two
2084:sweep_illegal
2099:closed_prs_json
2113:merged_pr_files_json
2140:sweep_pr_evidence
2168:human_board_activity
2191:validated_receipt_tasks
2212:deliverable_landed
2256:sweep_decide
2347:cmd_sweep
2380:digest_items_unchanged
