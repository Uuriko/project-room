# Release review and polish

September 7, 2026. User-authorized testing, simplification, source push and
publication to the existing isolated staging Worker. No final-domain routing,
new service purchase, real Compute call or Dasha source change is included.

## Release state

Local release gates pass. Source publication and hosted acceptance are the next
gates; this section will record their exact outcomes, not infer them from local
tests. Confirmed pre-release live Worker version:
`5b052420-ec55-4fe3-8a35-7f0ac1347bcb`, serving app source `0e20615`.

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
| Syntax plus core/API | 214 passed, zero failed/skipped |
| Full browser entrypoint | 56 passed, zero failed/skipped |
| Local Cloudflare runtime/restart/browser | 6 passed, zero failed/skipped |
| Wrangler dry-run | Success; same Worker/object/origin, ten allowlisted assets |
| Whitespace/diff check | Clean |

The baseline before this pass was 200 core/API and 52 browser checks; the added
tests include expiry/read snapshots, packaging safeguards, guest sign-out,
targeted Retry and desktop/touch rendering polish. The first focused run found
a reaction-dispatch regression; it was corrected and the whole browser suite
reran successfully. Failed intermediate runs are not counted as passes.

Local logs: `/tmp/room-release-final-core.log`,
`/tmp/room-release-final-browser.log`, `/tmp/room-release-final-cloudflare.log`.
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

Remaining pilot gates: a separate provider recovery drill, budget alerts,
final unlisted trydemigod.com routing/ownership, real-device/human testing and
self-service identity recovery. Guests still have up to eight-hour browser
access; provisioned keys still expire. The existing staging site is not a claim
that these broader launch gates are finished.
