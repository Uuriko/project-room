# Invitation review corrections

6 September 2026. These corrections follow the resumed reviews of `a88a0c7` and build above private journal candidate `7b5e92f`. Original green tests remain evidence for their exercised scenarios only.

## Corrected behavior

- The invitation cannot be dismissed or replaced by another invitation while account confirmation, acceptance, or opening is in flight. Signing in from a Room with drafts/forms requires an explicit warning/confirmation about clearing private state if the account changes. Same-account draft preservation remains tested.
- Invalidated offers hide both sign-in and acceptance actions and no longer display a pending-offer summary. Async failures return focus to the account field, retry action, or dismissal control. Tab and Shift+Tab cycle through available controls inside the modal.
- Dismissing uncertain acceptance warns that local retry information will be cleared and explains reopening the original link with the same account. Declining keeps the retry and restores its focus. Retry retains the original redemption ID.
- An already-accepted invitation uses opening-specific sign-in copy. A transport/server failure loading that Room is described as a loading problem, separately from an access denial. Neutral opening progress no longer populates the global error alert; the active invitation owns its status feedback.
- Preview labels say “Offered membership” and promise only that preview creates no notification/read receipt. They do not assert the unauthenticated viewer's identity or make claims about all possible observers.
- Account-mode Room access and session lookup require the current response binding, and that binding reaches transactional checks. SSE includes the opaque non-credential binding in its connection request. Room-cookie mode cannot implicitly use an account-slot token; revocation must match the Room in the request.
- HTTPS uses `__Host-` session cookies and rejects duplicate cookie names. HTTP loopback is restricted to isolated development; browser cookies do not distinguish local ports. This does not establish production TLS, provider identity, or deployment safety.

## Evidence and review boundary

The expanded invitation browser suite currently passes six scenarios, including keyboard cycling, blocked dismissal during account confirmation, draft-sensitive confirmation, invalidated-offer controls/focus, account-mismatch recovery, uncertain dismissal/retry, and neutral already-accepted loading failure. Existing core checks cover the account-mode binding requirement, explicit credential scope, host-only HTTPS cookie configuration, and Room-bound revocation. The HTTPS cookie check uses a local proxy-style HTTP fixture; it does not validate a browser's TLS deployment.

The producing agent fixed these findings; an independent follow-up review is still required. The journal candidate's separate review is also pending. No earlier review or test PASS is being carried forward as approval of changed code. Physical mobile, assistive technology, non-Chromium browsers, external runtime handoffs, operational drills, and representative-team use remain release gates.
