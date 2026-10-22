# Host outcome contract (proposal, not implemented)

2026-10-21. Status: contract and probe only. No runtime change. Needs review by
the implementation owner of client/request-runner.mjs before any runner edit
(muse-room 17323).

## Problem

A host that runs a reply request can only return `{ body, codeResult? }`
(client/host-result.mjs). The runner always records `responseOutcome:
"answered"`. A host that could not do the work has two options today: throw
(no reply, attempt goes to `needs_attention`) or write a body such as
`FAILED: ...`, which is still recorded as answered. Reading that first line as
control was proposed and rejected: quoted or pasted text can misclassify, and
moving a saved answer to `needs_attention` can strand its delivery (17237).

## Two separate facts

1. Task outcome: did the host do what was asked. Owned by the reply record's
   existing `responseOutcome` field, which already has two values the service
   offers as response actions: `answered` and `declined`
   (server/reply-requests.mjs). No new field.
2. Delivery state: did the saved reply reach the service. Owned by the
   existing request_runs lifecycle (`claim`, `working`, `result_ready`,
   `needs_attention`, `delivered`; server/request-runs.mjs). Unchanged.

A task outcome never changes delivery state, and delivery state never says
whether the task succeeded.

## Proposed host result

```
{ body, codeResult?, outcome?: "answered" | "declined" }
```

- `outcome` absent means `answered`, so every existing host keeps working.
- `declined` means the host ran and is not completing the request (needs input,
  refused, or failed). `body` says why and what is needed. It maps to
  `responseOutcome: "declined"` on the same saved response.
- Body text is never parsed. `FAILED:` or `NEEDS_INPUT:` in a body is content.
- A thrown error is not an outcome. It keeps today's behavior: saved answer
  goes to `result_ready` and is retried unchanged; no saved answer goes to
  `needs_attention`.

## Kept as is

- Retry: a saved response is delivered unchanged through the idempotent
  command path; the host is never re-run for it.
- Unknown write: a journal row with no saved response still refuses to run
  ("Host outcome is unknown").
- Cancel: a closed or cancelled request still refuses `result_ready` and
  `needs_attention` reports.
- Attempt: one attempt id per request; another host's attempt is refused.

## Open point found by the probe

`delivered` is accepted only when the request status is `answered`
(server/request-runs.mjs). A delivered `declined` reply would be refused, and
the runner swallows that report error, leaving the run row in `result_ready`.
The contract needs one of: accept `delivered` for `declined`, or record the run
as delivered from the reply receipt. This is the only server change the
contract implies, and it is the implementation owner's call.

## Probe

tests/host-outcome-probe.test.js pins the current behavior this contract
depends on: body text is passed through untouched, an unknown `outcome` key
is rejected today (so adding it is an explicit contract change, not a silent
one), and the run lifecycle actions are the five above.
