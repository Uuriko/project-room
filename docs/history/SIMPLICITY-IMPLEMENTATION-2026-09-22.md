# Simplicity implementation — first slice

## Refined scope

Prefer state-derived navigation and existing task rules over more AI calls or another workflow layer. Preserve explicit sending, sharing, access grants and approval. Inbox/unified messaging remains shelved.

1. Notification reachability: implemented bounded older-history paging. The existing 500-event bound remains per request; continuation accounts for event-window and item-limit truncation. Older mentions can be found without scanning unbounded history. This is not a complete unread-count projection or cross-room attention architecture.
2. Agent setup: four visible choices (Claude Code, Codex, Cursor, Grok Build); all other existing routes remain under Other agents. The four are a pragmatic initial set, not a user-validated ranking. Copy and capability boundaries remain truthful; selecting a type does not launch a model.
3. Next useful action: retain the existing contributionSteps selector and renderContribution behavior. It already prioritizes a useful action and preserves a focused choice during updates. No competing recommendation engine added.
4. Routine noise: retain existing work-notification grouping and result/question/blocker grouping in Catch up. Defer hiding arbitrary chat text: classifying prose as routine with keywords could hide a question. A later change should use typed progress events.
5. Empty rooms: retain the existing composer-first empty state; avoid an additional onboarding checklist. Target real newcomer sessions before restructuring it again.
6. Place preservation: exercised existing draft return, exact-result return and phone/desktop Catch up recovery alongside these changes. Results direct navigation was implemented in the preceding checkpoint.

## Paging behavior and limits

Older notifications and Newest navigate bounded pages without changing the read cursor. The selected older page survives ordinary feed refresh. A failed older fetch retains retry; late responses remain session-fenced. Every page uses live access, preferences, mute and deletion state. Empty truncated windows do not say Nothing new. Mark read is limited to a complete newest page, so this control cannot acknowledge unseen older history. Existing explicit Updates/caught-up controls remain available.

Counts and grouped changes are page-scoped, not complete totals. Work items may appear on different pages when they changed in both windows. This slice repairs reachability and false-empty presentation, not durable per-item resolution. Notification unread and pending work remain separate.

## Evidence

A new server regression buries a mention beneath 600 unrelated messages, retrieves it through continuation, advances the read cursor and verifies it disappears, then revokes access and verifies the next request fails. Another walks five notifications with a two-item limit without skipping a message. A real local phone browser traverses the buried-mention case, fails and retries the older fetch, and verifies the read cursor never moved.

Focused validation: 27 unit checks and 44 browser checks passed. Full core: 5,068 passed, zero failures, one existing TODO. npm run check passed, including schema, route documentation, secret scan, lint and core checks. Cloudflare backend: 33/33 passed. The three notification browser checks passed again after the keyboard-focus refinement. Changed-file lint has zero errors; existing prefer-const warnings remain. These are synthetic fixtures and visual inspection, not human participant sessions. No deployment in this slice.
