# Manual AT verification (VoiceOver / NVDA)

Source-of-truth procedure for the human assistive-technology runs. These
corrections come from the source review of the first evidence card; they are
setup facts, not optional preferences.

## Environment
- Node >= 24.19, as declared in package.json. Results from other runtimes are
  not evidence for this repository's support/CI environment.
- Start the service and use the EXACT origin it prints at startup. The default
  is `http://127.0.0.1:4173` - not `localhost:4173`. The HTTP layer compares
  the configured origin and rejects a different Host before serving the page,
  so `localhost` fails even though it resolves to the same address. Use the
  same origin in both browsers and in any synthetic message request. Keep the
  Host/Origin checks intact.

## Session isolation (two-person setup)
Two ordinary windows in one browser profile share the `room_session` cookie.
For the owner + Maya setup, use SEPARATE browser profiles (or isolated
contexts), or keep the owner sender API-only after seeding. Confirm Maya's
displayed identity before recording any row - a second sign-in in a shared
profile can invalidate the intended two-person setup. Keep provisioned keys
private.

## Send-result announcements
Exactly one live-announcement owner per send result: the composer-local
status region owns the failure announcement and keeps the visible composer
error; the page-level status region stays silent for that event. Send + retry
via Ctrl+Enter with the composer field focused.

## Loss-before-restart observation
The observation window for the restart row starts at server stop. A pass is
EXACTLY ONE loss announcement plus ONE connected announcement - no more, no
fewer.

## What a run must measure
Speech (what the screen reader actually announces), caret position, and focus
position, on the exact candidate revision under review. Record the commit SHA
with every table.

An automated Chromium run is not a manual assistive-technology pass. Complete
the following matrix independently for VoiceOver + Safari and NVDA + Chrome or
Firefox. Record a failure rather than substituting source inspection when an
environment is unavailable.

## Evidence header

Copy this header above each completed matrix:

| Field | Recorded value |
| --- | --- |
| Commit SHA | |
| Date / tester | |
| OS and version | |
| Browser and version | |
| Screen reader and version | |
| Browser zoom / text settings | |
| Owner profile or context | |
| Maya profile or context | |
| Evidence location | |

Do not record access keys, cookies, or other credentials in the evidence.

## Required scenario matrix

For every row, record the exact spoken output, final focus target, final caret
or selection where applicable, Pass/Fail, and an evidence timestamp or clip.

| ID | Setup and action | Required observable result | Speech | Focus / caret | Pass / Fail | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| AT-01 | Signed out: activate **Skip to content**, then submit an invalid key. | Skip lands on connection status. The error is announced once beside sign-in; no duplicate page toast. | | | | |
| AT-02 | Sign in as owner, type a multiline room draft, address Maya, place the caret within the first line, then have Maya post from her isolated profile. | One incoming-message announcement. Owner identity, draft, recipient, focus, and exact caret selection remain unchanged. | | | | |
| AT-03 | Focus an available work-card action, then have Maya post an unrelated message. Repeat with an open **Room capabilities** disclosure summary. | The exact work action remains focused if still available. Disclosure state and summary focus remain unchanged. No unchanged room-summary announcement. | | | | |
| AT-04 | With the composer focused, force one command failure and send with Ctrl/Command+Enter; restore service and retry with the unchanged draft. | Failure is announced exactly once at the composer. Draft and caret remain. Send is available as retry. Success is announced once and the draft clears only after acknowledgement. | | | | |
| AT-05 | Observe **Connected**, stop the service, leave it unavailable through at least two reconnect attempts, then restart the same exact origin. | Exactly one meaningful loss announcement and one later connected announcement. No repeated reconnect chatter and no premature connected claim. | | | | |
| AT-06 | Open **Return brief**; while the fresh brief is loading, inspect its paging/acknowledgement controls. Then use **Show more changes**, activate a message history row, and activate a current-work row. | The panel exposes its busy state and old-horizon actions remain unavailable until refresh completes. Expanded/collapsed state is announced. Each link moves focus to the named message or work card and exposes the same underlying record. | | | | |
| AT-07 | With a frozen return-brief horizon open, create one later event, mark caught up through the displayed horizon, then refresh the brief. | The action announces that only the member's marker moved. The later event remains new; no peer-read claim is announced. | | | | |
| AT-08 | Open an accountable-work action dialog; while it is open, trigger a background update that replaces its opener, then exercise invalid submission, Cancel, Escape, and successful submission. | Dialog name/context are announced. One local error owner announces failure. Cancel/Escape return to the equivalent current action, or its work card if the action disappeared; success returns to the changed work card. | | | | |
| AT-09 | Open the inline New work form from each available opener, then cancel. Enter a reply target and cancel that reply. | Focus returns to the original New/Make-this-work control, or a stable New fallback. Cancel reply returns to the composer. | | | | |
| AT-10 | While focus is in private room UI, sign out; repeat with server-side session revocation. | Private UI disappears, the session-ended alert is announced once, and focus moves to the access-key field. | | | | |
| AT-11 | Repeat the main conversation, return brief, and error/retry flows at actual 200% browser zoom and a 390 CSS-pixel viewport. | No two-dimensional page scrolling, clipping, or obscured active control; reading and focus order remain logical. | | | | |
| AT-12 | Open **Post evidence** and inspect the required producer choices; submit once with **I produced this** and once with **Unknown / not reported**. As verifier, inspect the available actions for known-distinct, unknown, and verifier-as-producer completions; inspect the cards and return brief. | The form starts unselected and requires a deliberate producer choice. Self-produced work records the signed-in member; unknown is explicit. Known-distinct offers an independent check; unknown offers only an evidence check with a spoken boundary that it cannot satisfy independence; verifier-as-producer offers no check. Reporter and producer are separate, PASS is never called independent without confirmation, and approval stays unavailable until confirmed. | | | | |
| AT-13 | In two tabs of one browser profile, sign in as owner in tab A and Maya in tab B, then reopen the owner return brief in tab A. Repeat with a slow owner sign-out response while Maya signs in. | Tab A ends local access instead of announcing or rendering Maya's private return items. The delayed owner response never ends Maya's replacement session or erases its cookie. One session-ended announcement is spoken. | | | | |
| AT-14 | Provision two active human members with the same display name and kind. Inspect recipient, accountable, verifier, completion-producer, work-card, and receipt labels. | Every choice and recorded fact includes the stable member ID, so the two identities are distinguishable in speech and visually before submission. | | | | |
| AT-15 | Mark caught up, but make the reconciliation snapshot or return-brief reload fail after the server commits the marker. Exercise both the room-level and brief acknowledgement controls. | The announcement says the position **was saved** and that refresh is needed. The stale brief is cleared, paging and acknowledgement remain unavailable, and no wording invites a duplicate write retry. | | | | |

## Pass rule

A run passes only when every required row has a recorded result at the same
commit. Retest the affected row after any client markup, styling, focus,
realtime, authentication, or return-brief change. Keep physical iOS/Android
screen-reader evaluation as a separate release gate; responsive desktop
emulation does not satisfy it.
