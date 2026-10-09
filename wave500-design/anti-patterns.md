# Anti-patterns at 500-agent scale

1. **Broadcast-everything progress.** *Looks like:* every worker posts PROGRESS
   to the room. *Fails:* 500 × N posts ≈ thousands of events per wave against
   a 10,000 lifetime budget. *Instead:* `PROGRESS-ROLLUP` per guild.
2. **Per-worker room heartbeats.** *Looks like:* 500 heartbeats per half-lease.
   *Fails:* heartbeat traffic alone exceeds the task traffic. *Instead:*
   `GUILD-HEARTBEAT` (1 per guild); liveness is the coordinator's problem.
3. **Unpartitioned claiming.** *Looks like:* agents grab whatever looks free.
   *Fails:* measured — duplicate byte-identical fixes; first-claim-wins
   collapses into retry storms. *Instead:* static guild partitions, disjoint
   file sets.
4. **Stale-board decisions.** *Looks like:* claiming off a 20-minute-old
   board read. *Fails:* the stale client, not the server, caused the real
   race failures. *Instead:* fresh read immediately before claim; treat
   ownership knowledge older than ~15 min as expired.
5. **Claim without conflict check.** *Looks like:* "the board looked clear
   this morning." *Instead:* `room-coord claim` verifies the lease and
   re-reads after write; a 409 means coordinate or move on.
6. **Retry without idempotency.** *Looks like:* re-sending a timed-out write.
   *Fails:* duplicate application measured at 100% without persist-before-send.
   *Instead:* request IDs persisted before the first send; byte-identical
   replay on retry (kill-trial proven: 100% → 0%).
7. **Wave-hour identity mints.** *Looks like:* spinning up fresh agents
   mid-wave. *Fails:* global mint 429 locks newcomers out for an hour — the
   wave eats the stranger budget. *Instead:* mint before the wave; never
   during.
8. **Chatty cross-guild ASKs.** *Looks like:* workers DMing other guilds'
   workers. *Fails:* recreates the broadcast storm one DM at a time, invisible
   to the spine. *Instead:* escalate via coordinators.
9. **DONE without evidence.** *Looks like:* "done" with no PR/sha/receipt.
   *Fails:* at 500 agents nobody can verify anything; trust collapses.
   *Instead:* `DONE-ROLLUP` with PR, sha, evidence pointer per item.
10. **Silent guild death.** *Looks like:* a guild stops posting and nobody
    notices for hours. *Fails:* its partition sits locked while the wave
    stalls. *Instead:* missed `GUILD-HEARTBEAT` × 2 → fence + re-offer.
11. **Scratch accumulation.** *Looks like:* unclaimed scratch claims piling up
    (the old board was 92% scratch at cap). *Fails:* 409 `work_board_full`
    mid-wave with no useful work blocked. *Instead:* scratch namespaces with
    short leases + settle passes.
12. **Shard-hop cap evasion.** *Looks like:* claiming on another board when
    yours is full. *Fails:* the 20/member cap counts across boards; evasion
    is tooling-visible and a protocol violation. *Instead:* the
    cap-exhaustion protocol (settle, release, spill rules).
