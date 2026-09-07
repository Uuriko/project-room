# Local account and invitation checkpoint

6 September 2026. Branch: `codex/project-room-canonical-20260906`, based on canonical account checkpoint `4d26afd`. This is a local implementation checkpoint awaiting independent review of the final revision; it is not a release approval.

## Acceptance and result

The implemented flow provisions a local account without membership, previews an invitation without recording delivery or reading, signs into that account, explicitly accepts the offered role in one Room, and opens the conversation. A matching retry returns the original receipt without adding membership again. Acceptance, its Room event/projection, immutable account/member binding, and audit row commit together.

Account identity switches use a stable browser slot with revision checks and response ownership. Login and retirement of the browser's prior Room credential now commit together. Invitation acceptance never replaces the browser cookie. The browser removes invitation fragments immediately, retains the secret only in memory, preserves the existing conversation draft and selection while previewing, and clears private Room state when account ownership changes.

Review and verification fixed: the Room-root route being mistaken for invitation revocation; a moderator being able to administer authority outside its own grant; role-policy replay depending on a current preset; stale preview status; expired account-slot recovery; asynchronous focus restoration racing dialog closure; unavailable invitations retaining loading copy; opening an existing membership briefly claiming fresh acceptance; and the split account-login/Room-session retirement transaction.

## Reproduce

Use the repository's supported Node runtime and installed development dependencies:

```sh
node --test
node --test --test-concurrency=1 scripts/browser-check.mjs scripts/disclosure-check.mjs scripts/quiet-focus-a34-check.mjs scripts/quiet-focus-final-check.mjs scripts/accessibility-check.mjs scripts/session-boundary-check.mjs scripts/invitation-check.mjs
git diff --check
```

- Core result: **118/118 passed**, including the account-provisioning command and rollback of a failed credential-retirement write.
- Full Chromium result: **24/24 passed** against the final application and service changes.
- After adding viewport captures and assertions that each mobile action can scroll fully into view, the dedicated invitation suite passed **2/2** again. Application and service code did not change after the full browser run.
- Visual inspection: reviewed `test-results/invitation-desktop.png`, `invitation-mobile.png`, and `invitation-mobile-actions.png`. Desktop scope and actions are legible. The 390px modal scrolls internally, text wraps, and both sign-in and dismissal controls can be brought fully into view. These synthetic captures contain no credentials and are generated, ignored artifacts.

Automated keyboard, focus, selection, reflow, and action-target checks are bounded evidence. They do not establish full WCAG conformance, physical-mobile behavior, screen-reader usability, or support in other browsers.

## Review status and remaining work

Earlier implementation reviews and executed assertions informed the fixes above. The two final reviewers stopped on a usage limit without returning findings. There is **no independent PASS for this final revision**. The producing agent's final source and rendered-UI inspection is not a substitute.

Next local work should close the full invitation audit/recovery contract before broadening runtime access: issuance and revocation currently live in authority-bearing relational tables rather than an independently replayable Room event record; revocation has no replay key; the operator lacks an authenticated invitation administration and account-recovery surface. Preserve existing v4 data with an explicit migration rather than rewriting a shipped schema marker.

Other gates remain: server-managed invitation-secret generation or a rigorously controlled issuer, provider identity/recovery, organization isolation, a bounded real Agent Gateway, two authenticated runtime participants, five exact GitHub handoffs, independent verification and human decisions, permission-aware export/retention/deletion, physical devices and assistive technology, load and restore drills, operational ownership, and representative-team dogfooding. The single-node pilot and passing tests do not satisfy these gates.

No push, merge, deployment, publishing, external contact, or live-runtime credentials were used for this checkpoint. Schema-v4 rollback requires a consistent pre-migration backup; an older binary must not ignore the invitation authority tables. The full goal remains active.
