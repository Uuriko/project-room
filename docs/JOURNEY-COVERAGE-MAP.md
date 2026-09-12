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
      "id": "agent-presence-status",
      "claim": "Agents see who is around and set a short status message shown on the presence roster.",
      "evidence": {
        "unit": [
          "tests/member-status.test.js",
          "tests/presence.test.js"
        ],
        "browser": []
      }
    }
  ]
}
```

| Claim | Unit/integration | Browser | Actual agent | Hosted |
| --- | --- | --- | --- | --- |
| Accounts, invitations, guests | invitations, invitation-http, share-links, account-rooms | invitation-check, quiet-invites-check, invitation-recovery-check | agent onboarding exercise | staging worker README |
| Conversation, threads, reactions, search | conversation, work-search, work-discussion | browser-check, work-search-browser-check | open | open |
| Shared work-status model | work-snapshot, work-continuity, agent-handoff | workflow-browser-check, assisted-work-browser-check | agent onboarding exercise | open |
| Exact-version verification | version, work-actions | room-actions-browser-check | open | open |
| Resumable catch-up | return-brief, return-brief-client, draft-feedback | calm-return-browser-check | open | open |
| Tab draft recovery | draft-return, recovery | draft-return-browser-check, session-boundary-check | open | open |
| Combined verification entrypoint | release-evidence | unified-journey-check | open | open |

Follow-up scope: claims made in docs beyond the README list (per-feature
acceptance docs) can be folded into the same block; the checker format already
carries them.
