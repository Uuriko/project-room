# Private operator inbox skip aggregates

Base `680f2b61c2f6679b99c55830af7f1b67516fa5d0`; runtime/tests `b687b8780`. Offline only; Root owns integration and release.

The optional normalized inbox skip now records one internal stop category per attempt. The public reader still returns exactly its prior contract: no reasons, diagnostic fields, IDs, bodies or additional cursor data. This does not acknowledge attention, advance a read horizon, change admission, add SQL, alter trust decisions or persist diagnostic state.

`server/inbox-skip-diagnostics.mjs` holds a WeakMap keyed only by the database handle. It retains fixed configuration, six totals, an attempt count and a cadence count. Totals saturate at 4294967295; cadence is at most63 between emissions. No room/member dimensions, arbitrary labels, samples, timestamps, timers or histories are retained. A closed/unreferenced store can be collected. A restart loses these diagnostic totals; absence of a log is not evidence that nothing happened.

Production Workers emit `room.inbox_skip_stops` to the existing operator console once per64 optional attempts. The only fields are event/version/attempts/stops; all six stop keys are always present. Node has no default log output. Internal configuration/read helpers are available to server tests/operators but are not connected to HTTP, MCP, room policy, request arguments or caller-supplied environment. Observer exceptions are swallowed and cannot replace delivery or its original error.

Fixed categories:

- `addressed`: a verified DM, mention or reply-to-viewer stops optional progress.
- `window`: the admitted source window/end is exhausted.
- `budget`: conservative shared byte/record headroom stops optional progress.
- `parent_unverified`: a reply's parent header cannot be established.
- `row_bound`: an event/own-header scalar, shape, legacy-header or consistency boundary prevents skipping.
- `error`: the optional check encountered its existing error path; no diagnostic text is recorded. The original normal-window failure behavior remains intact.

Qualification on the frozen runtime:48 Node tests, actual Worker/Native1, focused package closure/preflight3,741-source preflight, lint and secret scan pass. Node tests compare serialized reader bytes with diagnostics off/on and a throwing observer; equivalent hidden histories change only equal-shape bodies and nonparty routing yet produce identical reader and aggregate bytes. All six categories are exercised through actual inbox reads; unknown labels are ignored; database scopes stay separate. Native proves63 attempts produce no aggregate,64 produces exactly one fixed-fields row, reader results stay identical and observed reads write zero SQL rows. Existing cold1k/5k and tombstone controls remain green. No production latency/CPU claim.

The whole runtime-package suite was started too broadly and stopped after no further progress in its existing exact-commit cold fixture (one completed pass, observed83s). It is **incomplete**, not a pass or assertion failure. Focused package checks and actual Native qualification are the claimed package/runtime evidence. An initial Native capture test also failed because Worker stdout bypasses Miniflare's Log hook despite emitting the correct aggregate; the final check uses supported runtime-stdio capture. Both logs are retained honestly.

The runtime allowlist includes the new module, with direct tests. Candidate manifest regeneration produced no diff. Commands and hashed compressed logs: `audit/evidence/inbox-skip-diagnostics-20261103/receipt.json`.
