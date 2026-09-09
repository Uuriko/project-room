# Results in the room

## Outcome

People can switch the existing Work panel to **Results**, find current finished outputs, open exact stored text and return without losing their conversation draft. The Actions menu also reaches Results. The same selection is available to agent clients and MCP through the existing work-list operation.

This advances the blueprint's optional Results projection and the whole-product research direction: a room should retain useful outcomes, not only a longer transcript. It does not introduce a second artifact database, a compulsory dashboard or a new primary destination.

The preceding goal turn was progress: it committed Actions and verified the mobile layout. This turn builds the next complete native-room journey. The full product goal remains active; connected production messaging, execution, rewards and operational readiness are not established by these local UI changes.

## Design decision

We considered a separate results page/dialog and an in-place view in the Work panel. Chose the in-place view: the conversation remains visible on desktop, mobile retains the existing vertical room layout, and readers use the established exact-text dialog. The tradeoff is that a long room still requires scrolling on mobile; no new navigation stack is introduced.

Work and Results have stable adjacent controls. Results are quiet rows with a title, short reported summary, status and Work details. Native titles open stored text; external evidence remains an explicitly marked outbound link. Results does not fetch, render, validate or cache those external files.

**Completed** means the work has no outstanding required completion gate. **Approved** additionally means a current matching approval exists. Neither label authorizes copying private content elsewhere, external execution, deployment or payment.

The New action says **New work** in Results. Canceling its form retains Results; only a confirmed proposal switches back to Work. Empty Results says only “Completed results appear here.” It does not force a task, agent, invitation or purchase.

## Shared contract

- `currentResult(item)` and `completedResults(state)` live in the existing shared work selectors.
- Include a current completion receipt with a version, completed state and all required review/decision gates satisfied. Exclude proposed/accepted assignments, pending review/decision, reopened work and superseded work. Historical approval cannot qualify a new receipt.
- Reuse the existing workflow predicates rather than maintaining a second interpretation of verification or approval.
- Return current items in descending update order with stable ID ties. Search applies Results eligibility before matching or limiting.
- The direct client uses `orient({ focus: "results" })`; MCP uses `room_list_work({ focus: "results" })`. Optional `query` uses existing literal work-field search and its 25-match limit.
- Result metadata carries the exact completion event, evidence version, kind and status. Native results supply `nextResultRead` pointing to the existing exact-text operation; external results supply no automatic file fetch. Existing work-detail reads remain available.
- No new MCP tool or server route, schema migration, runtime asset or dependency. Schema stays at 22 and the runtime package stays at 81 files. Existing default work-list behavior remains unchanged.

## Interruption and return

Opening a result retains the exact completion identity, rather than substituting a newer output when a response arrives. If work changes or reopens while the reader is open, the retained text is labeled **Earlier result**. The Results row itself disappears when it no longer qualifies.

Closing the reader returns focus to its Results row, or the Results control if the row disappeared. Conversation text and message-list position remain unchanged. Work details and other work-record navigation switch back to Work before focusing a record. Signing out clears the list/reader and resets the view; leaving the room closes the reader without pulling navigation back to Rooms. Late result responses remain bound to their original session.

## Test evidence

The first targeted run passed 24 browser checks across Results, Actions, existing native-result handling and first use. The initial core suite passed 857 checks, including four new shared-selector and real local API/MCP checks. A final creation/return test and copy clarification were added afterward; exact committed verification is recorded below when complete.

The fixture's initial external-evidence payload incorrectly included a native-only field and was rejected. The fixture was corrected; no production evidence validation was weakened. Keep that failed fixture log alongside the passing rerun.

Screenshots in `test-results/room-results-20260908/`: desktop/touch lists and readers, plus large-text reader. Desktop list, touch list, desktop reader and large-text reader were visually inspected for hierarchy, wrapping, recognizable links and retained conversation context. Subsequent reruns refresh these screenshots from the committed runtime.

These are simulated-human browser checks and scripted clients over real local HTTP/MCP processes. They do not prove delight, retention, native third-party AI-host compatibility or production readiness. Six read-only browser journeys prohibit external requests and room API writes; the explicit new-work case permits exactly its one confirmed submission. Agent tests compare the underlying room audit digest before and after discovery/read, then test reopening and revocation.

No live mailbox access, sending, model execution, payments, pushing or deployment occurred.

## Next work

1. Make useful results easier to reuse through the established preview/copy and private reply flows, without implying that completion grants sharing authority.
2. Compare existing alternative drafts in context before introducing a separate branching abstraction.
3. Qualify optional curated references and pinning separately: ownership, deletion, source freshness and audiences need explicit semantics.
4. Resume the independently planned provider-draft update/reconciliation milestone. Results discovery is not a substitute for finishing authorized real messaging and deeper agent collaboration.
