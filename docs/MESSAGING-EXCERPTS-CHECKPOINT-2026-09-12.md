# Messaging excerpts checkpoint

## Journey acceptance follow-up

`42ffa22` changes tests only; runtime remains `07b32d9`. Telegram/SMS/WhatsApp tests now exercise room excerpt → accountable producer completion → independent review → human approval → private draft adoption, including rejection before approval and zero send records. SMS/WhatsApp mobile browser acceptance additionally exercises explicit private recipient selection, inability to confirm without a recipient, recipient-only read, revoke, separate room sharing, result preview and saved private draft.

Private sharing and room work are intentionally separate paths: a private grant does not become public work context automatically. The room-result journey uses an explicit room share. No claim is made that a private-only grant can already drive a fully private multi-agent work item. That remains a product gap.

Focused acceptance passed 5/5 and the complete messaging package passed 50/50 on `42ffa22`, with zero failures or skips. Grok independently passed the three provider excerpt tests on earlier runtime `07b32d9`; review of the expanded journey tests is pending. Corrected test-only timing (wait for enabled result adoption, not merely a visible button) and a false-positive privacy assertion matching a short numeric sender inside random event IDs. No production behavior changed.

## Runtime checkpoint

Runtime `07b32d9` adds selected-text sharing for imported Telegram, SMS and WhatsApp messages. It reuses existing Inbox review, not a new access model.

Exact runtime full regression: 1,509/1,509 Node tests passed, zero failures or skips.

The owner selects exact text, reviews the room audience, then shares either into room history or privately with selected members/agents. No selection is made by default. Shared content is the selected text with a generic message-excerpt label; sender, recipient, subject, connection identifiers and unselected text are not added. The same 4,000-character output limit includes the label. Invalid offsets, split Unicode characters, stale source revisions and changed audiences fail closed.

Room shares become room history, including for future members. Private shares use the existing seven-day recipient-scoped grants and do not create a room event. These are different boundaries shown in the existing review dialog. Copies cannot be recalled. Sharing grants neither provider access nor access to the rest of the Inbox. No messaging send capability is implied.

Evidence: all three providers pass exact selection, malformed bounds, stale source/audience, unauthorized actor, idempotent retry, changed retry conflict, private recipient isolation and recovery checks. Focused excerpt plus existing private-grant tests: 12/12. Four browser checks cover Telegram desktop/mobile and SMS/WhatsApp mobile, including explicit selection and returning to Inbox after room sharing. Messaging package: 50/50, zero skips.

Independent review requested from Grok. No live data was shared and no server deployed or restarted. Next: deepen private-recipient browser acceptance and connect shared messaging context to the existing assign/review/result workflow, keeping replies draft-only until provider sending is separately implemented and authorized.
