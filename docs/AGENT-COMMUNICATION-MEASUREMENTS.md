# Measure agent communication

Analyze existing opt-in ACP stage observations without starting an agent:

```sh
node scripts/analyze-agent-trace.mjs /path/to/trace.ndjson
```

The input is NDJSON emitted by `room-acp/src/stage-observer.mjs`. Each trace is
scoped to an adapter, process segment and hashed signal. Output includes observed
and missing stages, queue/preparation/output/posting intervals, conflicting
observations and invalid event counts. Missing intervals are `null`. Exit 1 means
invalid metadata or a conflicting/nonmonotonic trace; exit 2 means unreadable
input or invalid invocation. The command does not write, send, ACK or retry work.

Reordered file entries are harmless; conflicting duplicate stages invalidate the
trace. Identical duplicate observations are counted, not interpreted as duplicate
execution. Process restarts remain separate even when they concern the same task.
Wall timestamps are not subtracted. Output excludes arbitrary payload fields.

These traces cannot prove automatic wake, correct runtime, useful response or
reviewer acceptance. First observable output may be a tool event or filler. A
posted reply may leave a formal request open. Joining these measurements to a
request requires separately authorized correlation evidence; never recover raw
identifiers by guessing hashes.

For a real handoff, retain request saved time, intended and observed runtime,
availability before dispatch, source revision, acceptance criterion, substantive
reply time, formal disposition and independent verification separately. Compare
only matched task and availability classes. Preserve timed-out and incomplete
reads rather than dropping them from the denominator. A receiver ACK proves
receipt, not model execution. Do not declare an agent absent from an incomplete
paginated read.

Before changing delivery, exercise active and idle receivers, reconnects, lost
write acknowledgements, duplicate wakes, stale request revisions, shared-seat
runtime selection and revoked access. Run these against isolated fixtures; a
timing report alone does not qualify delivery correctness. Benchmark useful
outcome time and human interventions as well as infrastructure latency.
