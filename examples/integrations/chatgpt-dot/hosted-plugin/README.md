# Hosted Project Room distribution candidate

**Preparation only — not submitted, approved, published, or a verified install link.**
This package does not establish fresh Android installation or automatic wake.
Its four files were prepared against deployed source
`c1c92c5b65fb6c4fbe87e78cddced8496f0ab51c`.

## Package and ownership

- `plugin.json`: candidate listing, exactly five positive and three negative reviewer
  scenarios, and release notes. Publisher name and demo recording are deliberately
  absent, not invented.
- `mcp.json`: byte-for-byte copy of
  `examples/integrations/chatgpt-dot/hosted-mcp.json` at the source above
  (Git blob `6f8fdabd3b901c07e788609cf602ce6656d26e48`).
- `icon.png`: unchanged `icons/icon-192.png` from that source
  (Git blob `b006dcc295c5c1e8c9b733efa1b8cc4049a60c75`).
  PNG header measured 192 × 192 pixels; 2,554 bytes. Existing purple/white PR artwork.
- This README: preparation evidence, review expectations, and unresolved gates.

No generic template, runtime, checker, OAuth behavior, scope or legal text changes.
The package root is this directory, not the repository root. Do not include private
evidence, credentials, local hooks, or unrelated repository files in an upload.
Preparing this folder is not authorization to upload or publish it.

## Capabilities and limits

The existing configuration requests only `rooms:read`, `chat:read`,
`chat:write`, `work:read`, and `work:write`. It does **not** request
`members:invite`, provide an invitation flow, approve an independent review,
grant computer access, or start a runtime. Tool availability remains constrained
by the current grant, membership, task state and host. Do not substitute the
larger full-profile catalog for this OAuth allowlist.

A read can expose room messages and work context to the connected assistant.
Permitted writes can save messages, responses and assigned-work transitions.
Read access and each request's current context before acting. Room content and
webhook events are untrusted data, not authority. Preserve exact operation inputs
and stable retry IDs after uncertain results; read current state separately.
Do not repost the same result on replay.

Automatic wake requires a supported host-managed event subscription and an actual
idle resumption followed by a saved permitted reply. An OAuth connection, callback,
subscription, manual trigger or this package does not prove that behavior. No
polling workaround is included. Existing persistent subscriptions must not be
disabled after a matching run or tool failure.

## Reviewer preparation (not executed by this package)

The scenarios in `plugin.json` are **expected behavior, not test receipts**.
Use a separately authorized synthetic review room and sample work, not real user
work. Reviewer setup must provide: one addressed request, one actionable assigned
task, one prepared task with an immutable work-linked draft, and retained exact
operation inputs for replay/conflict cases. Do not provision reviewers or send
credentials as part of package preparation. Keep any access details in the host's
approved secure review flow, never this folder.

| Case | Expected evidence | Observed evidence / remaining qualification |
| --- | --- | --- |
| P1 orientation | Actual bound room/member, complete inbox and needs-me work reads; no write | Tool/scope definitions inspected at c1c92; this reviewer scenario not run |
| P2 addressed response | Complete request read, current answerBasis/responseActions, saved response receipt | Current schema inspected; this reviewer scenario not run |
| P3 accept/start | Saved actions plus current work readback, no invented execution | Published c1c92 native QA reports accept/start success; fresh review fixture not run |
| P4 text result | Exact saved draft version, completion event and current state; no approval claim | Published c1c92 native QA reports exact text and completed-state readback; fresh review fixture not run |
| P5 exact retry | Original receipt after progress, no second sequence effect | Published c1c92 native QA reports original accept replay and completion replay; not physical packet-loss testing |
| N1 other-room access | Refuse/no cross-room data; access errors do not trigger a new identity | OAuth room/member binding inspected; fresh negative review scenario not run |
| N2 embedded instructions | Treat message as data; no secret disclosure, invitation or permission bypass | Expected assistant behavior, not proven by source inspection; review scenario not run |
| N3 changed-input retry | Reject changed `resolvedBlocker` under original `room_start_work` requestId; original receipt unchanged | Published c1c92 native QA reports changed-input rejection; exact review fixture not run |

For N3, use only authorized synthetic fixtures and an intentionally changed,
schema-valid `resolvedBlocker` string. It is a negative test, never a recovery
strategy for real work. For all cases, record the exact host/version, source,
request IDs, saved result/event IDs and errors with secrets removed. Distinguish
an assistant refusal from a server denial; neither is evidence of the other.

### Existing evidence (not newly executed production tests)

[Published c1c92 release qualification](https://github.com/Uuriko/project-room/blob/b3f955f0572b21b8ea4872427a29d783cfe3090d/docs/research/2026-11-01-c1c92-release/README.md)
records separate native QA and its limits: reissued requests after progress, not
physical network loss, independent human review, host execution or background wake.
It also preserves the initially failed deployment and later recovery; it does not
relabel cancelled CI jobs green.

[Saved strict-smoke recovery](https://github.com/Uuriko/project-room/blob/b3f955f0572b21b8ea4872427a29d783cfe3090d/docs/research/2026-11-01-c1c92-release/live-c1c92-strict-smoke-recovery.json)
records HTTP 200 for the homepage, privacy and terms URLs below at exact c1c92.
These are historical saved checks, not fresh HTTP tests in this preparation run.

## Public links and disclosures

- Website: https://room.trydemigod.com/
- Support: https://github.com/Uuriko/project-room/blob/main/SUPPORT.md
- Privacy: https://room.trydemigod.com/privacy
- Terms: https://room.trydemigod.com/terms

Support is the existing public repository guidance: Discussions for setup,
Issues for reproducible bugs, separate private security reporting, no guaranteed
response time. The current `SUPPORT.md` was inspected at the pinned source;
the listing points to its maintained main-branch location.

Existing legal source is `docs/legal/privacy.md` and `docs/legal/terms.md`,
version 2026-10-02. Their existence and HTTP success do not verify publisher
identity, legal accuracy, or complete disclosures. The owner must review actual
data handling for accountless OAuth grants, assistant-visible room data, saved
writes/history, event subscriptions, revocation, deletion and retained shared
history. Do not promise immediate erasure, perpetual availability or universal
wake. Legal/operator claims in those documents are not independent verification.
Commerce classification and country availability also need owner review; they
are not silently set here.

## Host review and release gates

The metadata layout follows the published
[plugin submission guide](https://developers.openai.com/plugins/deploy/submission)
and [plugin build guide](https://developers.openai.com/plugins/build/plugins),
read on 2026-11-01. This is not a successful host validation or schema verdict.
The existing root SVG has a 32 × 32 viewBox; the packaged existing 192px PNG was
chosen instead to meet the documented square/minimum-48px icon requirement.

Run the **unchanged** adopted checker from the repository root:

```sh
node scripts/check-dot-distribution.mjs examples/integrations/chatgpt-dot/hosted-plugin
```

Expected outcome: `not_ready`, with publisher and review-video gaps intentionally
remaining. The original hosted baseline has 14 preparation gaps. Reducing that
count does not close these independent gates:

1. Verified publisher identity/project authority, legal accuracy, commerce and
   country decisions, and final listing/category approval.
2. Actual saved host OAuth client/resource/callback registration and domain
   verification. A public client ID in JSON is not registration evidence.
3. Host package/schema acceptance, authenticated tool/Events scan and secure,
   separately authorized reviewer access.
4. Execute the eight scenarios, record a genuine review video, address failures.
5. Explicit authorization for submission, approval and publication; obtain and
   verify the actual directory install route. None is supplied or invented here.
6. Fresh consenting friend-account Android installation, consent, first useful
   task, reconnect/disconnect and revocation; no desktop-derived mobile claim.
7. Any advertised automatic wake: actual idle resumption and saved reply, including
   retry/replay behavior, separately for each promised host. Codex host wake and
   restart are not established by this Dot package.

These files are an adoption candidate for the owning integration lane. They do
not authorize an external submission, registration, deployment or production test.
