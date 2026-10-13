# Quiet attribution — September 8, 2026

## Result

Everyday conversation, audience labels, search, thread headings, reply context,
reaction attribution and work next steps now reuse the existing duplicate-aware
display-name helper. Unique names no longer carry long internal identifiers.
Duplicate names retain exact identifiers, including when the other membership is
inactive. Normalized comparison already handles case and surrounding whitespace.

Action choices, member details, review authorship and the technical event history
still expose exact identity. Display names are not verified identity. This changes
presentation only: no service, schema, permission or stored record changes.

Runtime commit: `c2dd5935080f9a7ddadc22a79b0e1e581543b7a9`.
The implementation reuses existing code; no new presentation framework or feature.

## Evidence

- 536 core/API/package tests passed.
- 170 browser tests passed, including two new desktop/touch attribution tests.
- The two focused attribution tests passed again after improving screenshot framing.
- 13 local Workers runtime checks and one Workers browser check passed.
- Two exact-commit desktop/touch fallback journeys passed with this candidate and
  fallback `4d22189ccdebc56db23397e6cc75b07eff0e3c2c`.
- Whitespace checks passed. Desktop return and touch duplicate-name screenshots
  were inspected. At 200% text, exact duplicate identifiers wrap without horizontal
  overflow; their visual density remains an intentional identity tradeoff.

New tests cover readable summaries, exact recipient choices and member details,
live duplicate-name updates without losing keyboard focus, inactive duplicates,
search/thread attribution, enlarged text and absence of browser script errors.
These are synthetic browser checks, not interviews or evidence of retention.

The Workers browser emits the previously observed local self-signed TLS diagnostics;
its assertions and the full combined 14-test run pass. No hosted browser was tested.

## Exact release artifacts

Retained root: `../project-room-runtime-packages-20260908/`.

- New `candidate-c2dd593`: 65 runtime files, 19 assets, schema/writer12.
  Manifest SHA256: `3e470c61b53b69678bfa82e0a052a486e19bc0d058ce5dff606fe6bdc42a85cf`.
- Unchanged `fallback-4d22189`: 64 files, 19 assets, schema/writer12.
  Manifest SHA256: `01667e2de94d79bf2b67f102995696f8bf0e02b3e46777bc38a3a8cbdd9627e6`.
- Older `candidate-9745978` remains intact. `fallback-135d824` remains superseded;
  do not use it for release because of the documented draft/sign-out failures.

The Workers switch loaded the actual retained pair and preserved all 20 application
tables through candidate/pause/fallback/return. The browser switch generated fresh
verified packages from those exact commits, preserving drafts, exact pending retry
commands and immediate private-state clearing on fallback sign-out.

To requalify the browser switch, set `ROOM_DRAFT_CANDIDATE_COMMIT` to the complete
candidate hash before running `node --test scripts/fallback-draft-browser-check.mjs`.
Without that override, the regression script intentionally defaults to historical
candidate9745978. Workers qualification requires both explicit retained package
paths, as documented in the previous release checkpoint.

The browser suite log and three inspected screenshots are retained separately in
`evidence-c2dd593`. Neither older package was overwritten. Later documentation-only
commits do not alter the packaged runtime.

## Next and boundaries

Next safe priority: recovery reconciliation of current identity/permissions after
restoring historical state, without adding a public restore endpoint. Then continue
the first useful human–agent contribution journey and contextual connection help.

Hosted recovery/undo and independent native-model review remain approval gates.
This is local, not published or live. No model invocation, push, deployment, paid
service, other-product change or preview restart occurred. The broad goal remains
active and incomplete.
