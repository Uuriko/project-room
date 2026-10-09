# scripts/room — failure modes & invariants (guild-05 D2)

## Exit codes
- 0 ok · 2 refused by guard (duplicate-claim) · 1 error (header line 18).

## die() sites (93 — every one is a fail-closed path)
40:  [ "$count" -ge 2 ] && [ -n "$next" ] && [[ "$next" != --* ]] || die "$verb: $flag needs a value"
44:  command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1 (need bash + gh + jq)"
142:  mkdir -p "$base" || die "$verb: cannot create lock dir $base"
153:      die "$verb: timed out waiting for the enforcer lock ($lock) — another run is still posting; refusing to overlap"
275:  gh api "$@" || die "gh api failed: $*"
281:    || die "failed to fetch board comments from $(board_addr)"
286:    || die "failed to read issue $(board_addr)"
1497:  [ -n "$blk" ] || die "no claim block found on the board for task-id $task"
1516:    *) die "claim: unknown flag $1" ;;
1518:  [ -n "$task" ]   || die "claim: --task-id required"
1519:  [ -n "$files" ]  || die "claim: --files required"
1520:  [ -n "$lease" ]  || die "claim: --lease required"
1521:  [ -n "$reason" ] || die "claim: --reason required"
1524:  case "$lane" in ""|*[!A-Za-z0-9_-]*) die "claim: --lane must match [A-Za-z0-9_-]+" ;; esac
1527:    *) die "claim: --task-id must match RC-YYYY-MM-DD-NNN" ;;
1529:  case "$state" in submitted|working) ;; *) die "claim: --state must be submitted|working" ;; esac
1530:  case "$files" in *\**) die "claim: files: '*' is forbidden" ;; esac
1532:  case "$lease_n" in ''|*[!0-9]*) die "claim: --lease must be Nh (1-72)" ;; esac
1533:  [ "$lease_n" -ge 1 ] && [ "$lease_n" -le 72 ] || die "claim: --lease out of range 1-72h"
1536:  [ -n "$reason" ] || die "claim: --reason must be non-empty"
1538:  [ -n "$files" ] || die "claim: --files resolved empty"
1615:    *) die "heartbeat: unknown flag $1" ;;
1617:  [ -n "$task" ] || die "heartbeat: --task-id required"
1641:    *) die "release: unknown flag $1" ;;
1643:  [ -n "$task" ]   || die "release: --task-id required"

## Invariants (from code comments)
9:# never the prose) is ported here to the GitHub-issues substrate: comments
83:  # clock reading. (GitHub's clock itself is never the problem here.)
95:  # ROOM_CLOCK_OP is a test seam (scripts/room _clock); never set in production.
124:  # by both sides, so junk never breaks the hash — but a truncated file
125:  # (fewer rows) always does.
138:  # so the deciding state is always fresher than any overlapping run's
139:  # posts. Dry runs never take the lock (they post nothing).
146:    # A SIGKILLed run never cleans up; break locks no live run could hold.
236:            pushes; never force-pushes; never touches main.
257:Review verbs (read-only; query the live room API, never the board):
263:            Shadow mode never enforces: this only reads the measurement log.
306:# silently ignored. Fenced claims always win and are byte-for-byte untouched.
318:    # never crashes the whole rebuild (2026-09-24: a [lane][done]
334:    # the next character is "r", so the number never matches. "pull request"
348:    # silently ignored. A fenced room-claim block always wins when present.
406:    # field is authoritative, never the ledger post date — the
484:    # handoff comment is ignored loudly, never applied.
562:             # proposed strike-two because the parser never saw it.
587:           # ($rest), never the whole body. Searching the full body
618:         # fresh; edited comments never carry them.

## Enforcer fail-closed
guard_enforcer_freshness() { # $1 = verb
  local verb="$1"
  [ "${ROOM_ENFORCER_ALLOW_STALE:-0}" = "1" ] && return 0
  need sha256sum
  local rr ref self_path self_sha main_sha
  rr="$(repo_root)"
  # 2026-09-30 (phase-2 gap audit L-P2-3): refresh the origin/main ref
  # before comparing — trusting a stale local ref lets a stale
  # scripts/room pass the byte-identical check.
  git -C "$rr" fetch --quiet origin main 2>/dev/null \
    || die "refusing $verb: cannot fetch origin/main — run from a full clone of $DEFAULT_REPO with network access"
  ref="$(git -C "$rr" rev-parse --verify --quiet 'refs/remotes/origin/main' 2>/dev/null || true)"
  [ -n "$ref" ] || die "refusing $verb: cannot locate origin/main in $rr — run from a full clone of $DEFAULT_REPO with origin/main fetched"
  self_path="$(room_self_path)"
  [ -f "$self_path" ] || die "refusing $verb: cannot read the running script ($self_path)"
  self_sha="$(sha256sum < "$self_path" | cut -d' ' -f1)"
  main_sha="$(git -C "$rr" show "$ref:scripts/room" 2>/dev/null | sha256sum | cut -d' ' -f1)"
  [ -n "$main_sha" ] || die "refusing $verb: cannot read scripts/room at origin/main ($ref)"
  [ "$self_sha" = "$main_sha" ] || die "refusing $verb: stale scripts/room copy — self=$self_sha, origin/main@$ref=$main_sha. Run main's copy (git checkout $ref -- scripts/room), then restore it before committing."
}
