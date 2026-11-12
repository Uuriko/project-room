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

Reordered file entries are harmless; conflicting duplicate stages or receipt
operation hashes invalidate the trace. Identical duplicate observations are counted, not interpreted as duplicate
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

## Directed runtime and context evaluation

The same evaluator accepts an optional second file:

```sh
node scripts/analyze-agent-trace.mjs trace.ndjson handoffs.json
```

`handoffs.json` is an explicitly curated, sanitized evidence snapshot:

```json
{
  "nowMs": 200,
  "clockId": "room-server",
  "records": [{
    "handoffHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "clockId": "room-server",
    "fromRuntime": "desktop",
    "toRuntime": "acp-mac",
    "context": "review",
    "openedAtMs": 100,
    "responseAtMs": 130,
    "responseRuntime": "acp-mac",
    "useful": true,
    "responseEvidenceHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "deadlineMs": 20
  }]
}
```

This example uses synthetic milliseconds. Real timestamps must share one clock
source (for example server event times); the evaluator validates order and clock
labels, but cannot independently verify their provenance. Runtime/context labels
are bounded pseudonyms, not member IDs inferred to be devices. Use null for
unknown attribution, response time, usefulness, evidence, or deadline. Evidence
hashes should resolve through the operator's private evidence ledger, without
embedding bodies or credentials here. A useful label requires substantive-answer
review; an ACK or model output is insufficient. This evaluates response usefulness,
not independent verification of the resulting work.

Output groups **sender → intended receiver + context**, preserving reverse
traffic separately. It includes useful response median and sample denominator,
wrong-runtime count, ages awaiting a useful answer, missing telemetry, and deadline
breaches with evaluable denominator. Pending samples enter that denominator only
at their deadline (the boundary counts as breached); resolved useful replies enter
immediately and breach only when strictly later than their deadline. Wrong-runtime terminal replies remain awaiting
a useful answer. Missing telemetry does not establish a dropped request. Duplicate
correlation keys are excluded in full and cause exit 1 instead of choosing a
convenient observation. Preserve unanswered records in each snapshot.

Deadlines are explicit proposed/configured targets, not measured industry
benchmarks. No default timeout or implicit promise is introduced. Existing stage
latencies remain process-local and are not spliced across restart segments.

For multiple replies to one handoff, replace all four scalar response fields with
`responses: [{responseAtMs, responseRuntime, useful, responseEvidenceHash}, ...]`.
Do not mix scalar and array forms, even with null scalar fields. The evaluator
retains each response's elapsed time, runtime match and usefulness and selects the
earliest evidenced useful reply from the intended runtime. A later correction
therefore resolves the pending age without erasing an earlier wrong-runtime reply.
`recoveredAfterWrongRuntime` marks that sequence; `wrongRuntimeResponses` counts
responses while `wrongRuntime` counts affected handoffs. Repeated evidence hashes
within one handoff are rejected to prevent counting one response twice. Scalar
input remains supported. No automatic correlation from conversation prose occurs.

`deadlineEvaluable` includes useful responses resolved before their deadline as
well as pending requests whose deadline has arrived. It is a resolved-or-expired
operational denominator, **not a matured fixed-window success-rate denominator**.
Wrong-runtime evidence and unresolved attribution are independent: a handoff can
have both a known wrong-runtime reply and a later unattributed response. The latter
remains an unknown outcome until an evidenced intended-runtime useful reply exists.
