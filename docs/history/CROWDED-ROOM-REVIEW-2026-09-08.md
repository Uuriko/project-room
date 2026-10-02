# Crowded-room return review

## Question

Can a returning person find the one useful collaboration in a busy room without
reading its entire conversation or work list? Can their connected agent resume,
read the answer, contribute an exact result and hand it to an independent reviewer?
This is synthetic usability inspection and actual scripted MCP testing, not human
research, native-model reasoning, retention evidence or a production load test.

## Setup and planned journey

Extend the existing reconnect journey rather than create a second workflow harness.
Keep its small-room desktop/touch controls, then repeat at 1280×900 and390×844 with
80 unrelated open tasks assigned to another member and240 unrelated messages.
Enroll the producer through the real owner-managed connection service. Bury its
one answer request under30 newer unrelated messages. No real or private data.

1. Log in as the returning owner. Inspect the initial viewport and capture it.
   Does the existing next-step area expose the relevant request without making
   the person open advanced controls?
2. Open Catch me up. Confirm current attention excludes unrelated assignments,
   history/ongoing sections remain opt-in, and reads/navigation leave every Room
   table and the human read marker unchanged. Capture the actual viewport.
3. Search for the agenda, open the exact work record and inspect navigation/focus.
   Capture its surrounding layout; check viewport overflow and hit targets.
4. Follow the existing relevant-request shortcut and answer with Enter on desktop
   or the mobile control. Keep answer attribution separate from work completion.
5. Restart the disposable server and producer process. Resume through durable
   attention; read the answer and work discussion, acknowledge only the agent's
   private notice, then submit native text with exact version and idempotency.
6. Have the distinct scripted reviewer inspect and verify the exact bytes. Return
   as the person and follow the next-step shortcut to the decision. Preserve
   entered notes across a later review and explicit refresh; leave approval pending.
7. Exercise enlarged text and sign-out cleanup. Retain screenshots, tool sequence,
   read-marker checks and whole-database audits. Stop only these disposable fixtures.

## Inspection rules

Evaluate visible hierarchy, dominant action, repeated labels, clipped content,
scrolling distance, lost context and unnecessary choices—not just passing selectors.
Browser automation can scroll to an obscure control, so it is not proof that a
person could find that control. Screenshots and using visible catch-up/next-step
entry points supplement mechanics. Do not claim timed user task completion.

If friction is demonstrated, prefer improving an existing disclosure, destination
or default. Do not add a dashboard, duplicate inbox or autonomous execution. Any
runtime change needs proportional regression, exact packaging and fallback checks.
No publication or live preview change is authorized by this test plan.

## Findings and changes

Completed September 8. Both desktop and touch journeys expose the relevant reply
request on arrival and one item in Catch me up despite 80 unrelated work records.
Search reaches the intended work; the existing next-step control reaches its
request and later decision. A further incoming message (271 unrelated messages in
total) leaves the selected request focused and within two pixels of its previous
vertical position. No additional inbox, dashboard or explanatory copy was needed.

Visual review found two concrete defects:

- The fixed body font size prevented review prose from following a larger root
  text preference. A new computed-font assertion first failed on the old code.
  Removing the fixed size exposed mobile grid min-content overflow; single-column
  form and label tracks now use `minmax(0, 1fr)`. Review criteria, reviewer labels
  and review text grow at least 1.9 times at a 200% root font setting. Decision,
  notes and Save remain reachable by scrolling without horizontal overflow.
- A successful same-evidence refresh rendered "Current work loaded…" as a red
  error. That unnecessary success message is removed. Notes persist; genuine
  failures and changed-result warnings remain, with recovery regression coverage.

Relative text sizing follows [MDN font-size guidance](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-size).
The inspection is informed by [W3C Resize Text guidance](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html),
but this root-font preference scenario is not a complete browser-zoom or WCAG audit.

The real scripted producer reconnects after the disposable service restart,
reads the human answer, acknowledges its own private attention notice and submits
exact native-text evidence. A separate scripted reviewer checks that version.
Repeated question/result operations retain their identity. Later review changes
require explicit refresh and preserve decision notes. Human approval stays null;
owner, producer and reviewer read markers remain zero. Navigation/read checks
preserve the whole 20-table audit; sign-out clears private UI context.

## Frozen qualification

Runtime commit: `4ab081bc5f6fc6071ab9d8a2bd948f7d568a1689`.
Source tree: `f18a8acd73b9f61f7db90a8419e0fb5cd66c3a98`.

- 579 core/API/package tests passed.
- 178 full browser tests passed after the final runtime was frozen (176.95 seconds).
- 28 focused recovery/reconnect tests passed; these overlap the full browser suite.
- 14 local Workers checks, including browser coverage, passed.
- Two exact-commit desktop/touch fallback browser journeys passed.

Retained candidate: `../project-room-runtime-packages-20260908/candidate-4ab081b`
relative to the repository. 65 runtime files, 19 public assets, schema/writer 12.
Manifest SHA256: `70b76d11222c96bf552b7f01b5b358d56ecb7a68cae5ca5cb9e9fcb7638dec67`.
Only `src/app.js` and `src/styles.css` differ from candidate `7a091c7`.
Fallback remains `4d22189ccdebc56db23397e6cc75b07eff0e3c2c` / schema 12.
Local populated-store candidate → pause → fallback → candidate recovery passed.
Expected local TLS certificate warnings did not fail the Workers checks.

## Evidence and limits

Retained sibling directory:
`../project-room-runtime-packages-20260908/evidence-crowded-return/`.
Eight before and eight final PNGs cover arrival, catch-up, selected context, ready
work, decision and enlarged review/controls; final desktop/touch JSON records
contain the scripted tool sequence and audits. They are synthetic fixtures, not
production customer data. Generated screenshots were visually inspected.

No real-person research, native-model reasoning, retention measurement, hosted
load test, production migration or deployment was performed. The existing preview
was not restarted. Passing scripted tasks does not establish human discoverability
or satisfaction; screenshots supplement, not replace, real-user evaluation.

Next bounded review: several simultaneous human-directed requests and review
handoffs, rather than one relevant item among noise. Check stable prioritization,
focus and resumption without adding more default controls. Native-agent host
validation and independent hosted recovery remain separate release gates.
The broader goal remains active and incomplete.
