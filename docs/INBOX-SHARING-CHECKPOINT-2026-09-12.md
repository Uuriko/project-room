# Inbox sharing checkpoint

## Implemented

The email share sheet offers **All text** as a deliberate alternative to manual
excerpt selection. It selects the plain-text body, previews it, and still requires
Share. It does not include recipients, attachments, HTML, other messages, private
drafts or permission to reply externally. The existing 4,000-character room-message
limit includes the excerpt prefix; oversized selections are refused, not truncated.
Users can then select a smaller excerpt.

The selection control is disabled once submission begins. Existing source/audience
revision checks and immutable uncertain-request retries remain authoritative.
Paragraph checkbox change handling no longer applies to unrelated controls.

## Evidence

- Six focused browser scenarios pass: desktop/mobile All text, desktop/mobile
  email-to-room-to-draft collaboration, lost acknowledgment, changed source.
- 85 inbox/email Node tests pass, including audience changes, account isolation,
  revocation, exact retries, transactional rollback and recorded-email recovery.
- Full inbox browser regression: 65/65 pass, zero skipped (47,673 ms), including
  audience changes, account switching, private drafts and send-review recovery.

These are local tests with synthetic/recorded mailbox input, not live email delivery.

## Prioritized next implementation

1. **Selected-audience private context.** Do not implement a recipient picker over
   room-wide messages. Establish a separate private context record and explicit
   grants, with the owner always retaining access. Scope agent identities to their
   actual room/account bindings. Resolve “my agents” and “all agents” to visible,
   concrete recipients at confirmation rather than silently granting future agents.
   Test every read surface, search, events, exports, receipts and revocation. Do not
   put private content in room-wide logs or notifications. Revocation stops future
   reads but cannot retract copies already received.
2. **A complete email connector.** Use the existing account-private model and
   versioned observations, but implement real authorized transport separately from
   fixture readers. Prove reconnect, cursor recovery, deduplication, disconnect,
   recipient review and uncertain-send reconciliation before calling it connected.
   External credentials/access and deployment remain approval gates.
3. **Additional services.** Research each provider's supported integration model,
   account eligibility and limitations before offering Connect. Do not imply all
   personal messaging accounts support equivalent APIs or privacy guarantees.
4. **Whole conversations and attachments.** Require explicit scope, safe handling
   and bounded storage; All text is not a substitute for those features.

No connector, selective-agent privacy, hosted deployment or production readiness is
claimed by this checkpoint.
