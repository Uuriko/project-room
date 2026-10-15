# Gmail design benchmarks — 2026-09-22

This is a documentation-based comparison of the vendors' own material, not a hands-on audit or a speed benchmark. John's target is simple setup followed by full everyday email functionality, within an inbox that can later accommodate other networks.

| Reference | Documented pattern | Project Room decision and acceptance |
| --- | --- | --- |
| [Superhuman getting started](https://blog.superhuman.com/inbox-zero-in-7-steps/) | Account login, compose and triage shortcuts, Split Inbox, archiving and deferring work | Adopt a visible New email action, concise reader actions and archive-first triage. Keep Cc/Bcc behind disclosure. Basic send/read correctness precedes split inbox, shortcuts, snooze and scheduling; those remain follow-up work. Compose opens with one action; reply opens from the current message without a separate setup form. |
| [Beeper FAQ](https://www.beeper.com/faq) | A common client for multiple networks, multiple accounts, provider-dependent features, and some actions still requiring the native app | Adapt the common navigation and clear sending identity. Preserve a Gmail-specific workspace for folders, drafts and threading. Unsupported formatted drafts and attachments visibly open in Gmail. A selected platform in setup is not shown as connected. |
| [Texts](https://texts.com/) | Texts announces its transition into Beeper; its older page describes unified search, archive/unread, keyboard access and privacy | Treat Texts as a historical reference within the Beeper lineage, not another independently maintained product. Avoid counting product names as evidence of separate current capabilities. Project Room's server-held encrypted grants are not Beeper's on-device architecture, so make no equivalent privacy claim. |

The optional questionnaire remains short and resumable: identity/use, platform choices plus Connect Gmail, then finish. The connection button leads directly to Google account selection and consent. Google's required prompts cannot legitimately be collapsed into a guaranteed one-click grant. Advanced connection diagnostics stay outside that path.

Gmail-native actions are deliberately visible as Gmail. The unified private inbox remains the place to bring channels together and share selected material with a room. A common shell must not erase email-specific recipients, subject, thread references, mailbox state or draft identity. The live mailbox is the authority for its actions; synchronizing its state back into the current imported snapshot is a remaining integration task.

## This checkpoint's acceptance

- New and reply composers display the sending mailbox; replies respect Reply-To and retain provider threading. Cc and Bcc work without occupying the default view.
- Draft save, reopen, edit and send operate on Gmail drafts. Changed provider drafts are rejected before overwriting. Unsupported attachments/formatting are not silently removed.
- Inbox/Sent/Drafts/Starred/All mail/Trash and search use Gmail's API, with provider pagination. Archive/read/star/trash actions change Gmail itself.
- Requests that time out after dispatch are not automatically repeated. The UI preserves the uncertain request and points the user to Gmail; provider reconciliation is still needed for a seamless recovery experience.
- Mobile and desktop browser tests exercise real application HTTP routes against a stateful provider double. No test contacts a real mailbox or sends external email.

## Google implementation references

[Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [drafts and sending](https://developers.google.com/workspace/gmail/api/guides/drafts), [draft send reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send), [thread requirements](https://developers.google.com/workspace/gmail/api/guides/threads), [sync](https://developers.google.com/workspace/gmail/api/guides/sync), [push notifications](https://developers.google.com/workspace/gmail/api/guides/push).

`gmail.modify` provides everyday mailbox read/write/send capability without permanent bypass-trash deletion. Initial service enablement, consent-screen configuration, restricted-scope verification and applicable security assessment are deployment work. History-based background sync and watch renewal are separate from a successful OAuth callback.
