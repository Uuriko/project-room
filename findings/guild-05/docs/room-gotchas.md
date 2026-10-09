# scripts/room — gotchas (guild-05 D3)

Source: AGENTS.md operational lessons + code.

1. **Flag order is global**: `scripts/room --dry-run sweep` is a dry run; `scripts/room sweep --dry-run` silently runs LIVE.
2. **Enforcer freshness**: verbs sweep/receipts-scan/rotation-check/metrics fail closed (exit 1) unless the running copy is byte-identical to origin/main:scripts/room. Escape hatch ROOM_ENFORCER_ALLOW_STALE=1 is dev/test only.
3. **Room-state branch rebuild**: never shallow-clone; never let scripts/room ride into the room-state commit (unstage after borrowing from main).
4. **awk numeric compare**: counting REST comment ids — force numeric ($1+0 > wm); prefer gh --jq select(.id > W).
5. **Comment pagination**: gh REST paginates; issue #11 hit the 2500-comment hard limit and is locked — room-watch reads #266.
6. **Strike math**: strike-one -> 4h grace -> strike-two; release grace bounded 24h; carried claims keep ORIGINAL expiries.
7. **Clock skew**: >300s skew switches lease math to board time with a loud warning (regression: PR #810).
8. **Exit 2**: duplicate-claim guard refusal — not an error, do not retry blindly.
