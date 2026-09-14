# Journey coverage map (M1)

Every capability the project claims in the README "What is combined" list, linked
to its evidence tiers: unit/integration tests (`node --test` via `npm run check`),
browser checks (`npm run test:browser`), actual-agent exercises and hosted
evidence. `node scripts/journey-coverage.mjs` (wired into `scripts/check.mjs`)
fails the suite when a claim has no executable evidence or a linked file is
missing or unwired, so the test count cannot conceal an untested user path.

Empty agent/hosted tiers are honest gaps, not failures: the executable tiers
carry the claim, and the remaining tiers stay visibly open.

```json coverage-map
{
  "version": 1,
  "claims": [
    {
      "id": "accounts-invitations-guests",
      "claim": "Canonical accounts, invitations and anyone-with-link conversation-only guests.",
      "evidence": {
        "unit": [
          "tests/invitations.test.js",
          "tests/invitation-http.test.js",
          "tests/share-links.test.js",
          "tests/account-rooms.test.js"
        ],
        "browser": [
          "scripts/invitation-check.mjs",
          "scripts/quiet-invites-check.mjs",
          "scripts/invitation-recovery-check.mjs"
        ],
        "agent": [
          "docs/AGENT-ONBOARDING-TESTING-2026-09-07.md"
        ],
        "hosted": [
          "cloudflare/README.md"
        ]
      }
    },
    {
      "id": "conversation-threads-reactions-search",
      "claim": "Human conversation, threads, reactions, search and source-linked work.",
      "evidence": {
        "unit": [
          "tests/conversation.test.js",
          "tests/work-search.test.js",
          "tests/work-discussion.test.js"
        ],
        "browser": [
          "scripts/browser-check.mjs",
          "scripts/work-search-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "work-status-model",
      "claim": "One work-status model shared by the UI, catch-up view and structured agent API.",
      "evidence": {
        "unit": [
          "tests/work-snapshot.test.js",
          "tests/work-continuity.test.js",
          "tests/agent-handoff.test.js"
        ],
        "browser": [
          "scripts/workflow-browser-check.mjs",
          "scripts/assisted-work-browser-check.mjs"
        ],
        "agent": [
          "docs/AGENT-ONBOARDING-TESTING-2026-09-07.md"
        ],
        "hosted": []
      }
    },
    {
      "id": "exact-version-verification",
      "claim": "Exact-version verification/approval and reopened-work history.",
      "evidence": {
        "unit": [
          "tests/version.test.js",
          "tests/work-actions.test.js"
        ],
        "browser": [
          "scripts/room-actions-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "resumable-catch-up",
      "claim": "Resumable catch-up and truthful saved-but-not-refreshed feedback.",
      "evidence": {
        "unit": [
          "tests/return-brief.test.js",
          "tests/return-brief-client.test.js",
          "tests/draft-feedback.test.js"
        ],
        "browser": [
          "scripts/calm-return-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "tab-draft-recovery",
      "claim": "Optional tab draft recovery tied to account, authorization epoch, room, member and browser-session binding. Off by default; never sends automatically.",
      "evidence": {
        "unit": [
          "tests/draft-return.test.js",
          "tests/recovery.test.js"
        ],
        "browser": [
          "scripts/draft-return-browser-check.mjs",
          "scripts/session-boundary-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "combined-verification-entrypoint",
      "claim": "One combined core/API and browser verification entrypoint.",
      "evidence": {
        "unit": [
          "tests/release-evidence.test.js"
        ],
        "browser": [
          "scripts/unified-journey-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "agent-pause-remove",
      "claim": "The room owner pauses, resumes and removes an agent member from the People panel; a paused agent starts no queued wake, and a removed member's pause row is inert.",
      "evidence": {
        "unit": [
          "tests/wake-pause.test.js"
        ],
        "browser": [
          "scripts/agent-pause-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "agent-presence-status",
      "claim": "Agents see who is around and set a short status message shown on the presence roster.",
      "evidence": {
        "unit": [
          "tests/member-status.test.js",
          "tests/presence.test.js"
        ],
        "browser": []
      }
    },
    {
      "id": "unified-inbox-connections",
      "claim": "One validated connection record and adapter interface for email and Telegram fixture connections; the Inbox lists channel sources grouped by connection with its state.",
      "evidence": {
        "unit": [
          "tests/channel-connection.test.js",
          "tests/channel-import.test.js",
          "tests/inbox-channel-client.test.js"
        ],
        "browser": [],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "telegram-fixture-import",
      "claim": "Recorded Telegram Bot API updates (text, captions, attachments without bytes, edits, channel posts) normalize into Inbox sources through the shared importer, paged by getUpdates offset.",
      "evidence": {
        "unit": [
          "tests/telegram-adapter.test.js",
          "tests/channel-import.test.js"
        ],
        "browser": [],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "inbox-connection-routes",
      "claim": "Account-session connection routes, loopback-only fixture sync of a recorded page, and secret-verified webhook holding for Telegram; nothing is fetched or sent.",
      "evidence": {
        "unit": [
          "tests/channel-import.test.js"
        ],
        "browser": [],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "telegram-live-trigger",
      "claim": "Live Telegram: bot token and webhook secret read from deployment bindings with a visible not-configured state, a setWebhook registration script, a sendMessage transport with per-attempt idempotency and bounded retry, an owner-authenticated import trigger that works off loopback, and a connection card with status and Reconnect.",
      "evidence": {
        "unit": [
          "tests/telegram-live.test.js",
          "tests/telegram-adapter.test.js"
        ],
        "browser": [
          "scripts/inbox-telegram-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "unified-inbox-ui",
      "claim": "One Inbox list across email, Telegram and samples with channel badges, channel and connection filters and a grouping toggle; a Telegram reply from the Inbox through the deployment's channel transport (fixture until the bindings are set) with accepted, rejected and unavailable states; connection add, reconnect and remove over owner-authenticated routes; a needs-you marker for messages addressed to the owner; and Telegram excerpt sharing into a room.",
      "evidence": {
        "unit": [
          "tests/inbox-unified-routes.test.js",
          "tests/inbox-channel-client.test.js"
        ],
        "browser": [
          "scripts/inbox-unified-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "channel-webhook-journal",
      "claim": "Verified webhook updates are journaled durably per connection and update id, survive a store reopen, drain in cursor order marking exactly the consumed rows imported, and record bounded failed attempts without blocking neighbours.",
      "evidence": {
        "unit": [
          "tests/channel-journal.test.js",
          "tests/channel-import.test.js",
          "tests/recovery.test.js"
        ],
        "browser": [],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "room-export-portability",
      "claim": "Any member can take the room with them: the complete JSONL history or an escaped, script-free HTML page rendered from the same event walk, both Content-Length-framed, both closed to members whose access has ended.",
      "evidence": {
        "unit": [
          "tests/room-export.test.js",
          "tests/client.test.js"
        ],
        "browser": [
          "scripts/room-export-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "owner-access-review",
      "claim": "An owner-only, read-only access review names members and grants, guests with expiry, links with remaining joins, agent identities and connections with state, and last activity, with no token, secret or hash — identically from the route and the CLI.",
      "evidence": {
        "unit": [
          "tests/access-review.test.js"
        ],
        "browser": [],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "access-preview",
      "claim": "Before a run, a member can read exactly what an agent's one-task view can access: the linked source message id only (never its thread, quoted mentions or imported excerpts), current evidence versions, the declared budget with unknowns labeled, and the server's own omission list; opening the preview starts and grants nothing.",
      "evidence": {
        "unit": [
          "tests/work-context.test.js"
        ],
        "browser": [
          "scripts/access-preview-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "notification-feed",
      "claim": "A per-member notification feed derived from the event tail honours notification preferences, deduplicates edits, expires with the read cursor and never grants a wake.",
      "evidence": {
        "unit": [
          "tests/notification-feed.test.js",
          "tests/notification-preferences.test.js"
        ],
        "browser": [
          "scripts/notification-feed-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "telegram-send-preview",
      "claim": "A saved Telegram reply previews its bot and target chat and dispatches only over a matching fixture transport through the shared send journal.",
      "evidence": {
        "unit": [
          "tests/channel-import.test.js",
          "tests/inbox-channel-client.test.js"
        ],
        "browser": [],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "room-usage-summary",
      "claim": "Every member can read a per-room usage summary for a capped period: human seats and agent principals counted separately, sessions started and stopped, spend as reported (unknown, never zero, when unreported) and the store's pilot caps with remaining headroom; non-members are refused and the response carries no secrets or hashes.",
      "evidence": {
        "unit": [
          "tests/usage.test.js"
        ],
        "browser": [],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "pinned-messages",
      "claim": "Any active member can pin or unpin a live message from the keyboard; the Pinned section lists pins in pin order and follows other members' pins live; a deleted message drops out of the pinned list; the pins route re-checks membership on every call and refuses a revoked member.",
      "evidence": {
        "unit": [
          "tests/pinned-messages.test.js",
          "tests/route-auth-table.test.js"
        ],
        "browser": [
          "scripts/pinned-messages-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "room-review-policy",
      "claim": "The room owner can make independent review and/or an owner decision mandatory from the Room instructions dialog (members see the policy read only); altered client fields cannot disable a mandatory gate, earlier work keeps its recorded requirements, and the proposer sees the requirement locked with the reason.",
      "evidence": {
        "unit": [
          "tests/work-actions.test.js",
          "tests/state-machine-invariants.test.js"
        ],
        "browser": [
          "scripts/room-policy-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "room-lifecycle",
      "claim": "An account that administers membership somewhere creates rooms; the owner archives a room (read only afterwards, reading and export kept) and a member leaves one; the switcher lists archived rooms as read-only entries, never as working buttons.",
      "evidence": {
        "unit": [
          "tests/room-lifecycle.test.js",
          "tests/account-rooms.test.js"
        ],
        "browser": [
          "scripts/room-lifecycle-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "message-redaction",
      "claim": "The owner or the author redacts a message: the text leaves the projection, search, both export formats, an import round-trip and a restored backup, and only its SHA-256 remains for verification; deletion stays a tombstone that keeps history.",
      "evidence": {
        "unit": [
          "tests/message-redaction.test.js",
          "tests/message-edit-delete.test.js"
        ],
        "browser": [
          "scripts/message-redaction-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "room-spend-allowance",
      "claim": "The room owner can set a spend allowance over a rolling period; a session start that would commit more than the allowance is refused before anything is written, unknown spend never frees allowance, and every member sees allowance, spent, reserved and headroom from the same ledger the server enforces.",
      "evidence": {
        "unit": [
          "tests/spend-allowance.test.js",
          "tests/route-auth-table.test.js"
        ],
        "browser": [
          "scripts/spend-allowance-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    },
    {
      "id": "report-and-mute",
      "claim": "Any member can report a message to the room owner with a short reason; only the owner can list reports and see who reported. A member can mute another member or agent for themselves, collapsing that author's messages and keeping them out of their mention feed, and can undo it; nothing leaves the room.",
      "evidence": {
        "unit": [
          "tests/moderation.test.js",
          "tests/route-auth-table.test.js"
        ],
        "browser": [
          "scripts/moderation-browser-check.mjs"
        ],
        "agent": [],
        "hosted": []
      }
    }
  ]
}
```

| Claim | Unit/integration | Browser | Actual agent | Hosted |
| --- | --- | --- | --- | --- |
| Accounts, invitations, guests | invitations, invitation-http, share-links, account-rooms | invitation-check, quiet-invites-check, invitation-recovery-check | agent onboarding exercise | staging worker README |
| First-result onboarding (join, contribute, see the outcome) | help-offer-service, work-help-service, help-offer-context | first-result-journey-check | open | open |
| Invite for a purpose (deep-link the invited question or result) | share-link-service, join-link-dialog | purpose-invite-check | open | open |
| Conversation, threads, reactions, search | conversation, work-search, work-discussion | browser-check, work-search-browser-check | open | open |
| Shared work-status model | work-snapshot, work-continuity, agent-handoff | workflow-browser-check, assisted-work-browser-check | agent onboarding exercise | open |
| Exact-version verification | version, work-actions | room-actions-browser-check | open | open |
| Resumable catch-up | return-brief, return-brief-client, draft-feedback | calm-return-browser-check | open | open |
| Tab draft recovery | draft-return, recovery | draft-return-browser-check, session-boundary-check | open | open |
| Combined verification entrypoint | release-evidence | unified-journey-check | open | open |
| Unified inbox connections | channel-connection, channel-import, inbox-channel-client | open | open | open |
| Telegram fixture import | telegram-adapter, channel-import | open | open | open |
| Inbox connection routes | channel-import | open | open | open |
| Room export portability (JSONL and HTML) | room-export, room-client | room-export-browser-check | open | open |
| Owner access review | access-review | open | open | open |
| Live Telegram trigger and card | telegram-live, telegram-adapter | inbox-telegram-check | open | open |
| Telegram send preview | channel-import, inbox-channel-client | open | open | open |
| What this agent can access (pre-run preview) | work-context | access-preview-browser-check | open | open |
| Room review policy | work-actions, state-machine-invariants | room-policy-browser-check | open | open |
| Room spend allowance (owner cap, reserve on start, headroom card) | spend-allowance, route-auth-table | spend-allowance-browser-check | open | open |
| Pinned messages | pinned-messages, route-auth-table | pinned-messages-browser-check | open | open |
| Report a message, mute a member | moderation, route-auth-table | moderation-browser-check | open | open |
| Unified inbox UI (list, reply, connections, needs-you, share) | inbox-unified-routes, inbox-channel-client | inbox-unified-check | open | open |
| Room lifecycle (create, archive, leave) | room-lifecycle, account-rooms | room-lifecycle-browser-check | open | open |
| Notification feed | notification-feed, notification-preferences | notification-feed-browser-check | open | open |
| Message redaction (survives replay, export, import, restore) | message-redaction, message-edit-delete | message-redaction-browser-check | open | open |

Follow-up scope: claims made in docs beyond the README list (per-feature
acceptance docs) can be folded into the same block; the checker format already
carries them.
