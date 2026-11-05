# Default Native compact normalization scale check

Source commit: 0af970133, based on root f7cc4b8de. Tests/fixtures only, no production runtime or package command changes. Root owns CI wiring.

The new `cloudflare/normalization-compact-scale.check.mjs` runs the package default Miniflare 4.20260730.0 / workerd 2026-07-30 with compatibility date 2026-07-30, Node v24.22.1, and no MINIFLARE_WORKERD_PATH override. The first run passed; a readable test-only orchestration cleanup was then qualified on the final source (1 test, 1 pass, 0 skips, exit 0). ESLint on both changed files exited 0 without warnings.

The existing scale fixture gains only an explicit `fixture=compact` query option, using 64-byte bodies instead of 1,250-byte bodies. Without that option the old stress behavior is unchanged. The optional 7 MB check and its prior evidence are byte-unchanged. This does not qualify 7 MB migration, actual production room dimensions, 64-member activation, live Cloudflare CPU/memory limits, or production latency.

The compact control uses 1,000 actual events and 100 messages; the scale case retains 50,000 actual events and 5,000 messages (44,998 real edits plus two room/member initialization events). The legacy room projection measures 1,111,281 bytes, below 2 MB, and becomes a 131-byte normalized carrier. Cold restart exact activation retry returns the saved result. Another cold restart posts new content; then a further cold restart retries the exact first post, preserving its original sequence and writing only the existing two native permit flips. The saved result remains readable; final event/message counts are 50,002 / 5,002.

The two warm posts at 1,000 and 50,000 events each execute 114 SQL statements, read 1,193 physical rows and write 40 physical rows. Returned JSON materialization differs slightly because receipts/IDs differ, without scaling with history; full values are in receipt.json. The assertions preserve the existing +32 read-row tolerance and add equal statement/write counts and a 2 KiB materialization tolerance. No timing threshold is used. Whole one-time activation is measured separately and is not claimed O(1).

Counters reuse the existing fixture wrapper around actual ctx.storage.sql.exec, including raw native permit SQL. Constructor work is excluded because the active measurement begins in fetch. Materialized bytes count JSON-encoded rows returned through cursor iteration/toArray; they are not SQLite storage bytes or total heap. Worker elapsed clocks and host wall times are observations, not CPU measurements or SLAs. /state performs explicit full count diagnostics; its reads are not attributed to post cost.

Command: `/Users/johnpotter/.local/bin/node --test cloudflare/normalization-compact-scale.check.mjs` from the isolated worktree. Final output and initial passing output are archived complete with SHA-256 hashes in receipt.json. No deployment or production calls.
