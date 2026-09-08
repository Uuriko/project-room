# Workflow refinement — local checkpoint

This pass makes existing work easier to use and removes duplicated logic. It does
not add another task model, framework, dependency, database schema or agent runtime.
Changes are uncommitted in the unified checkout on top of local baseline
`3cf31d1a33d24f86d7229844b1333cd1be862337`. Older checkouts and preview databases were
not edited. The retained preview service was not restarted during this pass.

## What changed

- Proposals expose the model's existing independent-review and owner-decision
  choices. Both start enabled on every new proposal. Disabling a review hides its
  verifier field and omits that assignment from the command. Evidence and acceptance
  remain required. These controls do not grant external-write authority.
- Assignee choices reflect the selected work mode. Independent reviewers exclude
  the accountable member. A previously selected but now ineligible member remains
  visibly unavailable, with form validation asking for another choice.
- Work badges use the same next-step model for their words and color. Previously,
  the text was corrected by a second rendering pass, while pending review/decision
  could retain green completed styling. That second pass is removed.
- The assigned reviewer can review evidence again after PASS or approval. A later
  finding uses the existing service transition: block the work, retire the approval,
  preserve earlier checks and decisions. The UI previously hid this action after
  any first verification.
- The prominent next step now includes the recorded blocker instruction.
- Exact receipt matching and confirmed producer independence have one shared
  implementation in the event domain. Browser workflow helpers reuse it. Historical
  review lookup uses one search instead of searching twice.
- Action selection is a pure, tested workflow function rather than intertwined
  with button markup. It remains presentation only; the server validates every
  command, member permission, revision, receipt and write claim.
- New checkbox labels wrap inside their controls at doubled text size. Narrow
  layouts reduce unnecessary inset spacing. The screenshot review caught clipping
  that a document-width assertion alone had missed.

The research influence is deliberately small: explicit contributions with only
the checks they need, exact-version review that can be reconsidered, and a shared
human/API state model. No upstream implementation was copied into this patch.

## Verification

`npm run check` exercises syntax plus core/API tests. New `tests/workflow.test.js`
adds seven cases covering all four check combinations, later findings retiring
approval, role/claim-aware actions, and the shared receipt matcher. The complete
core/API suite passes **190/190**, with no failures or skips.

`npm run test:browser` includes the new `scripts/workflow-browser-check.mjs`.
Its desktop and mobile journeys cover all four combinations through completion,
full-check defaults on each new proposal, keyboard toggling, ineligible assignments,
lost-response idempotent retry, UI/API status agreement and a later browser review
that retires approval. The mobile case checks doubled root text, individual label
overflow and the submit button's bounds, not just document width.

The final combined browser suite passes **35/35**, with no failures or skips,
after the final wrapping and narrow-spacing changes. Earlier green results are
not substitutes for this candidate's run.

Tests use disposable loopback services and synthetic identities. An agent key is
not used as a browser identity: a separate synthetic human reviewer exercises the
browser, while the producer uses the structured client. This is one operator's
test evidence, not independent humans or agents collaborating in the wild.

Initial test corrections: sandbox restrictions required approved local-server
execution; the new browser fixture initially tried an agent key at human login,
and its inline style-tag test conflicted with the app's content policy. The fixture
now uses the intended identity and root-style test setup without changing either
application boundary. An existing identity test also caught an unnecessary change
from “Verifier” to “Review”; the original label was preserved.

Source/test/config inventory SHA-256:
`1f6bb29c5539c92361731546622f1bf316f9c356ec84e0caca1116a61fcab84f`.
Computed from `git ls-files --cached --others --exclude-standard` restricted to
`src server client scripts tests index.html package.json server.mjs`, sorted with
`LC_ALL=C`, hashing each file and then that path-bearing hash list. Docs, generated
screenshots, Git metadata and dependency installations are excluded.

## Visual evidence

Generated locally under `test-results/` (ignored by Git):

- `workflow-desktop-small-proposal-detail.png` — lighter proposal controls.
- `workflow-desktop-review-options-detail.png` — full review choices.
- `workflow-mobile-review-options-detail.png` — narrow form.
- `workflow-mobile-enlarged-checks-viewport.png` — actual viewport at doubled text.
- `workflow-desktop-later-finding.png` — approval invalidation reflected in the UI.

Full-page images are also retained. Tall element/full-page captures can include
fixed-element capture artifacts; use the viewport image for enlarged-text layout.
No existing preview records were used for these tests.

## Coordination and next work

John requested direct context exchange with Instinct and Grokbot. Their existing
[shared issue](https://github.com/Uuriko/project-room/issues/11) was read.
[Instinct's latest update](https://github.com/Uuriko/project-room/issues/11#issuecomment-5574424841)
reports reconstruction of its service branch and proposes a receipt-shape adapter,
an invitation-to-first-message test and Node 24 evidence.
[Grokbot's last posted update](https://github.com/Uuriko/project-room/issues/11#issuecomment-5565330678)
offers implementation-independent conformance testing once a shared build is
obtainable. These are participant reports, not independently rerun results here.

The outbound update/request was rejected by the app's approval review because
posting internal project context to this external issue needs explicit destination
and payload approval. **Nothing was posted; no reciprocal reply to this update is
claimed.** Local coordination-bus claims are not delivery to Instinct or Grokbot's
GitHub listener. No indirect forwarding was attempted.

Suggested reciprocal request once approved: each agent provides its current
head/artifact, completed work and actual tests, occupied files, blockers, next step
and any contract disagreement. Instinct's adapter overlaps semantically with this
shared matcher, so reconcile receipt shape explicitly rather than merging parallel
implementations blindly. Grokbot can plan observable lifecycle cases while waiting
for an obtainable build.

Still open: full service-line integration, real runtime/MCP conformance, production
operations, and human-team trials. Small questions and suggestions still belong in
conversation; the lighter proposal flow is not a new universal contribution type.
