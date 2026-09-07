# Release review and polish

September 7, 2026. User-authorized testing, simplification, source push and
publication to the existing isolated staging Worker. No final-domain routing,
new service purchase, real Compute call or Dasha source change is included.

## Release state

**Published; primary flow verified, repeat-return defect under repair** at
[Project Room staging](https://project-room-staging.getdasha.workers.dev).
App source: `7084dd4c6d4eaa379b70debcc2cce05b41e18a3b` on
[PR #23](https://github.com/Uuriko/project-room/pull/23).
Worker version: `91b0e98f-9967-43ea-b930-d188ed6514f6`, tag `7084dd4`,
confirmed serving 100% after deployment at 22:27 UTC.
[CI run 34166599955](https://github.com/Uuriko/project-room/actions/runs/34166599955)
passed contract, browser and Cloudflare jobs before deployment.

Command-line push had no available GitHub credential; the connected GitHub API
published all 36 reviewed files instead. Published tree
`94daf8c21d0a345111ac4a128941e2be3ae3ad8b` exactly matches the tested local tree.
Local checkout now tracks that same published commit; its temporary local
commit remains recoverable from the reflog. No force push or main merge.

The pre-release version `5b052420-ec55-4fe3-8a35-7f0ac1347bcb` (app `0e20615`)
remains the documented rollback target. Same Durable Object, data, origin and
bindings; no bootstrap, DNS, marketing site or Dasha deployment was changed.

## Hosted acceptance

An additional post-release repeat-return smoke test exposed a connection
lifecycle defect not covered by the original gates: the same guest's third
rapid return eventually received 429 on the event stream, with the UI
showing reconnecting/stale history despite a permanently closed native stream. A fresh later visit connected. An independent
local Chromium reproduction retained closed connection slots and denied the
fourth connection. Data and ordinary reads remained available. Do not treat
the successful primary journey below as complete reconnect acceptance. The
follow-up candidate below repairs the lifecycle and client retry; hosted
verification of that candidate is still pending. No stream-cap removal or data
reset is involved.

- Existing saved test guest returned successfully both before and after this
  deployment with the same identity and prior message.
- All ten live public assets match the released checkout byte-for-byte. Health
  and readiness return 200; signed-out Room read returns 401. Checked responses
  retain `X-Robots-Tag: noindex, nofollow`.
- Fresh HTTPS owner created a one-hour/single-join invitation; a touch-browser
  guest joined, sent a message and received the desktop owner's Enter-sent
  reply through live updates. The join fragment was removed.
- Guest suggestion became source-linked work. The owner explicitly disabled
  unavailable independent verification while retaining owner decision, accepted
  and started the work. Guest saw progress but no unauthorized work controls.
- The new guest returned with identity/message intact afterward. This is
  browser return and deployment persistence evidence, not a provider restore.
- Root inspected hosted desktop/mobile screenshots. The journey added one
  labeled synthetic guest, two synthetic messages and one in-progress test work
  item. Existing human messages and earlier test records were preserved. The
  test work remains in progress; no human approval or completion was invented.

Evidence remains in ignored `cloudflare/test-results/hosted-{desktop,mobile,return}.png`
and `/tmp/room-release-hosted-assets.log`. Private browser state and owner key
stay in ignored `.operator/`; no credentials or hosted screenshots were pushed.

## Reconnect follow-up candidate

The Node HTTP bridge did not emit `close` or `finish` when a Cloudflare browser
left. The candidate passes the platform request signal through request-scoped
AsyncLocalStorage and releases that stream's timer and admission slot explicitly.
It enables both `enable_request_signal` and `request_signal_passthrough`; the
three-stream credential and 100-stream global limits remain unchanged. No
schema, Durable Object identity, bootstrap or authentication policy changes.

Native EventSource retries CONNECTING but not CLOSED after an HTTP refusal.
The client now replaces only an owned CLOSED stream with one delayed retry,
exponential base delay of 1–30 seconds plus up to 25% jitter (maximum 37.5s).
Only an actual open resets backoff or labels the room Connected. Disconnect,
sign-out, account replacement and manual reconnect cancel or invalidate old
work. The refresh rejection handler also checks ownership, preventing a late
old-session failure from clearing a replacement session.

Seven new service/client regressions cover lifecycle, limits, retry/backoff and
session changes. The real Cloudflare browser test injects one local temporary
429, observes 429 then 200, makes six immediate guest close/reopen visits without
fixed sleeps, proves both participants still receive messages, then restarts the
runtime and verifies return persistence. The explicit hosted `--return` check
now checks six immediate returns with unchanged identity/history and Connected
state, adding no guest, message or work records.

Primary references: [Cloudflare request signals](https://developers.cloudflare.com/workers/runtime-apis/request/),
[compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/),
and [native EventSource behavior](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface).
These describe the platform behavior; the actual defect and repair were verified
with our own browser and service tests, not inferred solely from documentation.

## Review coverage and decisions

Root integrated three read-only reviews: frontend/client/design, domain/service,
and deployment/tooling. The audit covered all production modules in `src/`,
`client/`, `server/`, `server.mjs`, HTML/CSS, the Cloudflare adapter and packaging,
plus scripts, dependency manifests/locks, CI and release runbooks. Test coverage
and changed regression harnesses were reviewed alongside the implementation.
This is a source review with executed regression evidence, not proof that every
possible defect or device combination is absent.

- Removed unused styling and write-only state. Reused one text-update helper,
  one disclosure-preserving rendering helper, one date formatter, one invitation
  retry predicate and one guest-operation lock. No new runtime dependency.
- Avoided replacing unchanged people, work, summary and History panels. Tests
  demonstrate retained DOM identity/text selection on an unrelated incoming
  message, plus retained History focus on refresh. These are behavioral proofs,
  not a claimed benchmark speedup.
- Room snapshots and return briefs use read transactions instead of reserving
  the SQLite writer. Their admission checks and reads remain in one snapshot;
  concurrent suspension and the next denied request are tested.
- Account authentication cannot outlive the remaining browser-slot lifetime.
  The effective end is the minimum of slot, key and eight-hour authentication
  limits. No schema migration or authentication caching was introduced.
- Invitation previews recover from temporary network/429/5xx errors using the
  same retained secret. Retry does not join; dismissal preserves the original
  draft and selection. Keyboard Retry returns to the next usable control.
- Expired-guest sign-out locks competing actions, checks view ownership between
  awaits and rejects unconfirmed results. An authenticated replacement account
  restored from another tab is never signed out by this recovery path.
- Packaging rebuilds exactly the ten allowlisted assets before deployment and
  rejects unexpected files and symlink outputs without deleting them. Operator
  arguments fail early; hosted checks use a bounded synthetic invitation.
- Added the Cloudflare runtime/restart/browser/dry-run job to CI so it is not a
  separate manual-only release gate.

Broader reducer rewrites, cross-request permission caches, schema changes and
large-scale architecture changes were deliberately deferred. They add risk
without measured need for this single-workspace pilot.

## Lightweight surface

Conversation remains the primary activity. Reactions occupy one compact native
disclosure, with existing reactions/counts visible when collapsed. Their four
buttons appear on demand. Search Clear appears only when useful. History now
has readable non-overlapping rows. Long invitation titles leave Close accessible
on narrow screens. Work details, people, connection detail and invitation limits
remain explicit opt-ins; relevant permission/lifetime warnings remain visible.

Desktop Enter sends; Shift+Enter adds a line. Touch Return adds a line and the
named arrow control sends. Focus, selected text, drafts, retry ownership and
accessibility announcements are part of the release gate, not visual extras.

Design reference: Apple's [disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)
informed keeping secondary controls hidden until requested. Applying that idea
here is our design judgment, not an Apple endorsement or human-study result.

## Final local evidence

Node 24.19.0; installed Playwright Chromium; Wrangler 4.116.0 and Miniflare
4.20260730.0. All browser/API services use disposable local fixtures.

| Gate | Result |
| --- | --- |
| Syntax plus core/API | 221 passed, zero failed/skipped |
| Full browser entrypoint | 56 passed, zero failed/skipped |
| Local Cloudflare runtime/restart/browser | 6 passed, zero failed/skipped |
| Wrangler dry-run | Success; same Worker/object/origin, ten allowlisted assets |
| Whitespace/diff check | Clean |

The baseline before this pass was 200 core/API and 52 browser checks; the added
tests include expiry/read snapshots, packaging safeguards, guest sign-out,
targeted Retry and desktop/touch rendering polish. The first focused run found
a reaction-dispatch regression; it was corrected and the whole browser suite
reran successfully. Failed intermediate runs are not counted as passes.

Reconnect follow-up logs: `/tmp/room-hotfix-final-core.log`,
`/tmp/room-hotfix-final-ui.log`, `/tmp/room-hotfix-final-cloudflare.log`.
The initial polish passed 214 core/API checks; the reconnect follow-up adds seven.
The Mac lacks an npm executable on PATH; the exact browser script's arguments
were run with the available Node binary. CI uses the normal npm entrypoints.

Root visually inspected the four `test-results/release-{polish,history}-*.png`
captures and invitation start/join plus first-use touch evidence. History,
invitation title wrapping, compact reactions and the guest-only view were
checked. Screenshots are ignored local artifacts; no credentials are published.
Touch is emulated, not physical-device certification. Chromium screenshot
capture can reset touch emulation; keyboard semantics are asserted before
capture, and a screenshot's hint alone is not the behavioral proof.

## Agent and human evidence boundaries

This release includes the previously completed [agent write guide](AGENT-WRITE-GUIDE.md),
[actual two-agent exercise](AGENT-ONBOARDING-TESTING-2026-09-07.md) and
[Darkbloom/Compute research](DARKBLOOM-COMPUTE-ROOM-2026-09-07.md).
That exercise produced and independently reviewed real original artifact bytes,
with the human decision deliberately pending. It was not rerun in this release
pass; its guide/contract regression tests are in the current core suite.

Human journeys remain simulated. No human-participant results, cross-vendor
conformance, automatic agent recruitment, live inference, payment system or
unattended agent runner is claimed.

## Publication and rollback procedure

Push the reviewed commit only to `codex/unified-local-20260907` on
`Uuriko/project-room` / existing PR #23. Require fresh contract, browser and
Cloudflare CI results for that candidate before publishing. Do not merge main
or update unrelated repositories. Deploy the same checkout to
`project-room-staging`, preserving `ROOM`, `ProjectRoom`, `room-sqlite-v1` and the
`invite-only-pilot` object. Never re-bootstrap or regenerate the live owner key.

After deployment, compare every public asset byte-for-byte with the checkout;
check health/readiness, unauthenticated denial and no-index headers. Run saved
guest return, fresh HTTPS owner/invite/guest/message/work checks, then return
again. The fresh journey adds clearly labeled synthetic records; it does not
erase any existing room history or assert human approval.

If hosted acceptance fails, stop further publication and use the recorded prior
Worker version for code rollback after confirming compatibility. Cloudflare
[rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
does not restore Durable Object data. No schema changes are part of this pass.

Grok's [PR #24](https://github.com/Uuriko/project-room/pull/24) supplies a separate
offline hosted-denial conformance package against the old PR #23 tip. Its
reported 17 offline passes are not live denial evidence and are not counted in
this release. It was not merged or run here. Cancelled/expired/cap/removed-member
negative journeys remain locally tested; expanding those hosted cases requires
an explicit isolated fixture. Signed-out live denial is verified above.

Remaining pilot gates: a separate provider recovery drill, budget alerts,
final unlisted trydemigod.com routing/ownership, real-device/human testing and
self-service identity recovery. Guests still have up to eight-hour browser
access; provisioned keys still expire. The existing staging site is not a claim
that these broader launch gates are finished.
