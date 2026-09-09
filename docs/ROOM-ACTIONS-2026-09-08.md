# Room actions: power on demand

## Shipped locally

One **Actions** button in the room header, also available through Cmd/Ctrl K, opens a searchable list of existing room flows. The conversation remains the primary surface. This implements the first recommendation from [whole-product inspiration](BEYOND-INBOX-PRODUCT-INSPIRATION-2026-09-08.md), informed by Raycast's contextual action pattern and Superhuman's emphasis on fluency.

The menu offers writing, room search, catch-up, work, people, new work, invitations, agent connection and room instructions when the current member can access their backing controls. No new navigation destination, settings page, command language, database, dependency or execution system is added.

Choosing an action navigates or opens the existing form. It never submits a message, creates an invitation, enrolls an agent, changes instructions, starts work or approves a result. Form-specific permissions and confirmation steps remain authoritative.

## Interaction details

- Search matches short labels and a small set of intent words. Enter opens the first matching action; arrows move through matches; no match stays in the menu.
- Ordinary buttons remain usable through click, touch and Tab. Cmd/Ctrl K is optional, not required knowledge.
- Escape, Close and the shortcut return to the prior control. Keyboard-opened drafts retain their text selection when unchanged. Returning to writing preserves its existing draft and context.
- The shortcut does not interrupt another open dialog. Composition and held Enter cannot select a menu action.
- Actions are recomputed when selected. A disabled or hidden backing control is not treated as authorized just because it appeared earlier.
- The menu is tied to the room session and generation. Leaving the room or ending access clears its query and rendered actions.
- Desktop shows the shortcut hint; coarse-pointer layouts omit it. The menu scrolls within a short viewport, with 44px action rows.

The feature lives in the existing app and stylesheet. Schema stays at 22 and the production runtime package stays at 81 files.

## Evidence and limitations

The core/syntax/cold-package suite passed **853 checks**. The focused browser suite passed **9 checks** covering desktop/mobile drafts, keyboard navigation, filtering, empty results, focus wrapping, all destinations, guest controls, stale controls, access ending, composition, repeat keys and a 320px-wide touch viewport. These tests record zero external requests and zero room API writes after login.

Screenshots in `test-results/room-actions-20260908/`:

- `desktop-room.png`, `mobile-room.png`: quiet entry in the room.
- `desktop.png`, `mobile.png`: open menu with an unfinished message.
- `guest.png`, `no-match.png`: reduced permissions and empty search.
- `small-touch.png`: last action remains reachable in a short viewport.

Desktop, mobile, mobile room and small-touch screenshots were visually inspected. This is Chromium-based simulated-human testing, not feedback from recruited people or a physical-phone keyboard test. Existing API/agent regression checks run through the core suite; the new menu itself does not require an agent.

The initial browser run exposed the Actions button inside an intentionally desktop-only membership area. It was moved into a sibling header group, retaining the mobile membership simplification. The broader suite then caught a real first-use regression: an extra header row pushed the mobile guest composer below the screen. A compact grid now places Actions alongside About. The combined Actions/first-use rerun passed **11 checks**, and the corrected mobile room screenshot was visually inspected. Keep both initial failure logs alongside the passing reruns.

The initial broader run is diagnostic only because the mobile correction landed while it was running. A fresh committed-runtime regression result will be recorded below.

## Next coherent work

1. Check the new Actions affordance during the existing return journey, particularly whether catch-up leads to the right work without another summary layer.
2. Build a small room shelf from existing references and accepted results, rather than adding another disconnected content system. Qualify permissions, source freshness and empty-state behavior first.
3. Improve comparison of existing alternative drafts before introducing a separate branching model.
4. Retain the independently planned provider-draft update/reconciliation work. This UI checkpoint does not implement it or enable live messaging.

### Shelf qualification before implementation

The next smallest useful experiment is a read-only **Results** view of existing room records, opened through Actions or the Work panel. Do not begin with folders, uploads, favorites, a canvas and a new sidebar destination together.

Use the current work projection and shared predicates in `src/workflow.js` and `src/work-selectors.js`. An assignment's accepted state is not an accepted result. A terminal item may be superseded, so terminality alone is insufficient for inclusion. Require a current receipt, no supersession, and the relevant completion/review/decision gates. Label completion without required review as completed, not independently approved.

Open native text through the existing result reader. Show an external evidence URL as a link, not as fetched, verified or embedded content. Keep the receipt's exact event/version identity and show current state when reopened; do not copy a result into a separate mutable collection.

Before building, qualify six fixtures: an empty room; completed native text with no remaining gates; an exact approved result; a result awaiting review; reopened work with historical approval; and superseded work. Include a participant with room-only access and a replacement session while the view is open. Results must never pull private Inbox sources or silently include other rooms.

Acceptance: one optional compact view, direct return to conversation, no new write operations, no external fetches, no migration, and shared derivation usable by both the room UI and agent-facing code. A curated reference shelf can follow separately once ownership, edits and removal semantics are defined.

No live mailbox access, sending, model execution, payment, push or deployment occurred. The overall product goal remains active.

## Committed-runtime verification

Runtime commit: `c811915092f569d4feca7f13d29425f224b0f858`. After that commit, **853 core** and **23 local Workers** checks passed with zero failures. Logs are `committed-core.log` and `committed-workers.log` in the evidence directory. Subsequent edits are documentation only.

The initial full browser run finished with 258 passing checks and the single mobile-composer failure described above. Because it overlapped the correction, it is retained only as diagnostic evidence in `initial-full-browser.log`. The targeted mobile-polish run passed all 11 checks.

The fresh full browser run against the committed runtime passed **259 checks**, zero failures, skips or cancellations. Evidence: `committed-browser.log`. This includes all nine Actions checks, mobile first use, the existing account/Inbox/collaboration journeys, composer behavior, quiet design, invitations, agent connection, recovery and work reuse. Final verified totals are **853 core + 259 browser + 23 local Workers**; this is local evidence, not a staging or live deployment claim.
