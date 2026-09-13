# Messaging excerpts checkpoint

Runtime `07b32d9` adds selected-text sharing for imported Telegram, SMS and WhatsApp messages. It reuses existing Inbox review, not a new access model.

Exact runtime full regression: 1,509/1,509 Node tests passed, zero failures or skips.

The owner selects exact text, reviews the room audience, then shares either into room history or privately with selected members/agents. No selection is made by default. Shared content is the selected text with a generic message-excerpt label; sender, recipient, subject, connection identifiers and unselected text are not added. The same 4,000-character output limit includes the label. Invalid offsets, split Unicode characters, stale source revisions and changed audiences fail closed.

Room shares become room history, including for future members. Private shares use the existing seven-day recipient-scoped grants and do not create a room event. These are different boundaries shown in the existing review dialog. Copies cannot be recalled. Sharing grants neither provider access nor access to the rest of the Inbox. No messaging send capability is implied.

Evidence: all three providers pass exact selection, malformed bounds, stale source/audience, unauthorized actor, idempotent retry, changed retry conflict, private recipient isolation and recovery checks. Focused excerpt plus existing private-grant tests: 12/12. Four browser checks cover Telegram desktop/mobile and SMS/WhatsApp mobile, including explicit selection and returning to Inbox after room sharing. Messaging package: 50/50, zero skips.

Independent review requested from Grok. No live data was shared and no server deployed or restarted. Next: deepen private-recipient browser acceptance and connect shared messaging context to the existing assign/review/result workflow, keeping replies draft-only until provider sending is separately implemented and authorized.
