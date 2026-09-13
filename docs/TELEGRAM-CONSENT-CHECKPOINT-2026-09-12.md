# Telegram consent checkpoint

## Current interface checkpoint

Runtime `3bfa9d1`: full Node suite 1,499/1,499; Telegram package including desktop/mobile acceptance 43/43; focused shared-widget and Telegram acceptance 9/9. No failures or skips.

Telegram now exposes the same quiet Receiving disclosure as SMS/WhatsApp alongside its manual Sync and Disconnect controls. Permission transport is pinned to Telegram, with strict provider-row validation. A lost action response clears stale controls and offers Refresh; browser acceptance proves recovery when permission committed before the response was lost. Sign-out clears the interface; explicitly authorized host receiving still imports privately. Stop blocks subsequent polling without deleting saved messages.

The interface gap below is resolved by this checkpoint. Private runtime configuration and a bounded polling schedule remain unfinished; nothing was activated live. Grok review requested for `3bfa9d1`, not yet recorded as passed.

## Earlier service checkpoint

Runtime checkpoint: `41199a0`. Full Node suite: 1,498 passed, zero failed or skipped. Focused Telegram background and Telegram/Twilio receiving controls: 6 passed.

Telegram now supports account-private receiving status, explicit 24-hour permission, stop, and renewal through the same protected HTTP boundary used by SMS/WhatsApp. A host-only sync method resolves current permission on each invocation. Tests cover cross-account denial, CSRF and origin checks, stale revisions, unexpected fields, logout, renewal, and stopping without deleting saved messages or disconnecting the provider.

This is implemented and tested locally, not activated live. The existing Telegram pilot remains manual and receive-only. Interface wiring, private runtime configuration, and a bounded polling schedule remain before continuous receiving can be claimed. No Telegram replies or personal-account history access were added.

SMS and WhatsApp already have locally tested signed inbound webhook and receiving-consent foundations. No live number, paid provisioning, public callback, or outbound sending was configured in this checkpoint. Complete SMS onboarding next, then WhatsApp provider onboarding; do not imply that adapter code alone connects a user's account.

Independent reviews received: grant schema checkpoint `155a33c` passed 11 tests; Telegram background checkpoint `b2bee52` passed 4 tests. Review of `41199a0` requested from Grok; not yet a review pass.
