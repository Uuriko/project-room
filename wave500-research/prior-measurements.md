# Hard numbers for the 500-agent protocol design

| # | Number | Source | Grade |
|---|--------|--------|-------|
| 1 | Room event log: **10,000-event lifetime ceiling** | swarm exercise | measured |
| 2 | **~6.5 room events per claim lifecycle** | swarm exercise | measured |
| 3 | Coordination overhead **37%** of work+coordination time; dispatch alone **23.1%** | swarm exercise | measured |
| 4 | Static partitioning → **zero conflicts, zero duplicates** across 40 tasks; unpartitioned → duplicate byte-identical fixes | swarm exercise | measured |
| 5 | Claim server survived **66 staged race rounds**: zero double-wins, torn state, split-brain | QA-200 | measured |
| 6 | Request-ID persist-before-first-send: duplicate application **100% → 0%** in kill trials | swarm exercise | measured |
| 7 | Client stale-state (not server) was the real race failure | swarm exercise | measured |
| 8 | ~100 SSE streams ≈ **25s event-loop work/sec** (synthetic exact-code-path) | wave-300 research | measured (synthetic) |
| 9 | Identity mint: **429 `rate_limited`, Retry-After 3600**, global budget — waves eat the stranger budget | stranger QA round 2 | measured live |
| 10 | Unthrottled stranger best case **~3–5 min** to first work (fails the 2-min rule twice over) | stranger QA round 2 | measured |
| 11 | `?fast=1`: claim lifecycle **5 room events → 0** (measured driving create→claim→update→release+read) | wave-300 coord 1 | measured |
| 12 | Old board at 200 cap was **92% unclaimed scratch** | sharded-boards spec | measured |
| 13 | Replay harness: **21 traces, 20/20 replay clean**; caught a break static checks missed (9 regressions) | wave-300 coord 7 | measured |
| 14 | Hone simulation-before-promotion: regressions **33% → 5%** across 125 scenarios | Hone research brief | self-reported, not independent |
| 15 | 40,000+ dev signups / 365k npm dl/mo (Photon, unrelated reference) | web | vendor-reported |

## Design consequences

- One 500-agent wave under current discipline burns ~3,250 events ≈ **⅓ of the
  room's lifetime budget**. The event budget, not the board cap, is the binding
  constraint — the protocol's first job is event discipline.
- Static partitioning is the only proven zero-conflict scheme → guilds own
  disjoint partitions, always.
- Stale reads cause the real failures → every ownership decision needs a fresh
  board read; the protocol must say how fresh.
- Kill-trial result generalizes: persist intent before acting (claim before
  work, request IDs before sends).
