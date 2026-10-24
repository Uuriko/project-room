# Human help invitations

Previous goal turn was progress: real agent help discovery, compatibility and
browser/MCP evidence qualified. This slice brings that capability into human
use without adding a dashboard or implying automated dispatch.

## Implementation plan

1. Reuse the existing work action dialog, submission ticket, pinned revision,
   identity boundary, exact receipt verification and unknown-save retry.
   Add help opening/update and withdrawal as distinct action types, not work
   state transitions. Do not change workActions or agent assignment actions.
2. Put Ask for help inside existing Details when the accountable member may
   publish. An active invitation gets one collapsed Help wanted disclosure with
   scope, end time and contextual edit/end controls. Only the accountable member
   publishes; the human owner may end another member's invitation.
3. Ask for a short scope and duration. Updates may keep the current end time.
   Freeze the exact canonical expiry on first submission; retries never silently
   extend it. The service remains authoritative for time and permission checks.
4. Pin help revision and accountable membership revision in addition to work
   revision. Background changes preserve text and require explicit current-state
   review. Show the latest invitation when reviewing a stale draft.
5. Use the existing return clock to retire expired invitation labels even without
   new events. Do not change human read markers or create attention/notices.
6. Test desktop/touch human publish → actual scripted MCP discovery → update →
   withdrawal; role/independent-review boundaries, stale scope/withdrawal,
   lost/mismatched receipts, exact retry, close/reopen, permission changes,
   keyboard/large text, composer preservation and escaped untrusted scope.
7. Inspect screenshots, run relevant and broader regressions, freeze a local
   candidate and document evidence. No deployment, provider use or preview change.

## Remaining after this slice

Invitation-bound offers, service-side offer limits, simultaneous-helper choice,
and populated schema13 fallback qualification remain separate work. Existing
conversation and draft contribution remain available but are not represented
as invitation-bound offers or permission to act.
