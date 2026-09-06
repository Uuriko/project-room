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
position, on the exact merged revision under review. Record the commit SHA
with every table.
