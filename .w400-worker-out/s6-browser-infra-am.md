## Browser-check infrastructure

- **How checks run:** `npm run test:browser` is the entry point. `scripts/browser-ci.mjs` is the CI wrapper (BUILD-01 B50) — the browser job's only failure signal used to be bare "exit code 1", so the wrapper surfaces which script/test failed plus evidence artifacts. `scripts/browser-ci-reporter.mjs` is a `node --test` reporter turning every failure into a GitHub workflow annotation + one duration line per script (pure output; never changes verdicts).
- **Sharding:** `scripts/browser-shards.mjs` allocates the canonical package script into balanced shards (allocation consumes the canonical script; timing data never selects membership). `browser-shards-check.mjs` validates the sharding. `scripts/unit-shards.mjs` does the same for the unit suite (the unsharded `npm test` ran ~625s on hosted CI, the long pole of every PR).
- **Local invocation:** `node scripts/<name>-browser-check.mjs` runs a single check; `node scripts/browser-check.mjs` is the shared harness (real browser + local HTTP service, disposable fixtures).
- **Failure modes:** non-zero exit on assertion failure; quarantine via `tests/quarantine.json` (a test can `skip` with reason "quarantined: tests/quarantine.json (browser timing flake; repair by <date>)" — e.g. board-browser-check.mjs:478,720).

## Check convention

- **Naming:** `<area>-browser-check.mjs` in scripts/.
- **Structure:** `node:test` `test("...", { timeout }, async t => {...})` blocks; Playwright `chromium.launch({ headless: true })`, overridable via `ROOM_TEST_CHROMIUM_PATH` (browser-check.mjs:55).
- **Fixtures:** all identities, messages, keys are disposable; most checks run against a real local HTTP service with synthetic data. Headers repeatedly stress: "simulated human journeys … not human research" — these are not usability evidence.
- **Exit codes:** 0 = pass; non-zero = fail (node:test default). Quarantined tests skip with reason instead of failing.

## Checks A–M (57 scripts)

| Script | One-line purpose | Header? |
|---|---|---|
| a11y-composer-browser-check.mjs | Q011: axe-core sweep of the message composer | yes |
| a11y-login-browser-check.mjs | Q011: axe-core sweep of the login/join entry points | yes |
| a11y-room-browser-check.mjs | Q011: axe-core sweep of the signed-in room view | yes |
| access-preview-browser-check.mjs | Simulated human journeys (access preview surface) | yes |
| account-deletion-browser-check.mjs | QA2 P2-11: Settings → Sign-in & security → Advanced account deletion | yes |
| account-settings-browser-check.mjs | Account settings UI coverage (slice 7, RC-2026-09-17-016) | yes |
| accountless-join-restore-browser-check.mjs | Account-less join restore via invite-redeemed room session | yes |
| acquisition-browser-check.mjs | Templates, template page, public room page, agent directory at phone width | yes |
| action-dialog-focus-scroll-browser-check.mjs | NR-B: action dialog async exact-text load must not strand focus | yes |
| action-recovery-browser-check.mjs | Simulated human flows in disposable loopback rooms | yes |
| activity-feed-browser-check.mjs | Activity feed, Later (saved messages), Mark unread | yes |
| agent-connect-browser-check.mjs | (no header — skim: agent connect flow) | no |
| agent-pause-browser-check.mjs | C6: owner Pause/Resume/Remove for agent members in People | yes |
| agent-signin-browser-check.mjs | (no header — skim: agent sign-in flow) | no |
| agent-work-access-browser-check.mjs | H4: agent joining via room link gets no permissions | yes |
| assisted-work-browser-check.mjs | Real browser commands against disposable loopback rooms only | yes |
| auth-return-browser-check.mjs | Welcome, sign-out, return-to-room for new human account | yes |
| board-browser-check.mjs | Tasks › Board: claim actions, linked work, return journeys, 390px, axe | yes |
| calm-return-browser-check.mjs | Simulated human return journeys (not retention evidence) | yes |
| channels-browser-check.mjs | Simulated human journey, channels surface | yes |
| chat-performance-browser-check.mjs | Observable chat cost contract: arrivals leave historical DOM alone | yes |
| chat-suggestions-browser-check.mjs | Chat suggestions above composer ("short or detailed?") | yes |
| claim-overlap-browser-check.mjs | Claim overlaps on work card when claims cover another's paths | yes |
| composer-browser-check.mjs | Synthetic fixtures; not a substitute for device/AT runs | yes |
| credit-question-browser-check.mjs | Simulated browser + real scripted MCP subprocess, no AI inference | yes |
| decision-register-browser-check.mjs | Decision register (F2): human with decide promotes a decision | yes |
| deleted-message-browser-check.mjs | Deleted-message rendering: message.deleted tombstones | yes |
| design-cohesion-browser-check.mjs | Computed-style regression for shared tokens + regrouped Settings | yes |
| desktop-google-browser-check.mjs | Real desktop consent through Google cross-origin browser return | yes |
| discovery-contribution-browser-check.mjs | Scripted MCP participants and simulated people, no native model | yes |
| dm-consent-browser-check.mjs | DM consent UI journey under default-open DMs | yes |
| dogfood-return-browser-check.mjs | Synthetic journeys in disposable rooms, no real users | yes |
| draft-return-browser-check.mjs | Simulated human journeys: disposable rooms only | yes |
| email-password-browser-check.mjs | Real local email/password journeys through contextual email step | yes |
| fallback-draft-browser-check.mjs | Local qualification of packaged runtimes, never live services | yes |
| friend-bond-browser-check.mjs | People Friend chrome: Friend → Proposed → Accept → Friends + peer DM → Revoke | yes |
| gmail-setup-browser-check.mjs | (no header — skim: Gmail setup flow) | no |
| gmail-workspace-browser-check.mjs | (no header — skim: Gmail workspace flow) | no |
| growth-invite-browser-check.mjs | Invite kit: one Invite entry, copyable link and message | yes |
| help-contribution-browser-check.mjs | Simulated accountable human + scripted MCP helper and reviewer | yes |
| help-invitation-browser-check.mjs | Simulated human UI + scripted MCP, disposable rooms | yes |
| help-offer-browser-check.mjs | Simulated humans + scripted MCP over disposable local room | yes |
| human-experience-browser-check.mjs | (no header) | no |
| human-push-browser-check.mjs | Human push: one button behind the browser permission prompt | yes |
| inbox-browser-check.mjs | Simulated human journeys against real local service + disposable data | yes |
| inbox-conversation-browser-check.mjs | Two-message email conversation with attachment, rendered in inbox | yes |
| invitation-note-browser-check.mjs | Disposable synthetic journeys; not retention/human-study evidence | yes |
| join-next-browser-check.mjs | Join page follows `next` only when it's one relative path on this origin | yes |
| layout-simplification-browser-check.mjs | (no header) | no |
| lazy-boards-browser-check.mjs | (no header — skim: lazy board loading) | no |
| live-upgrade-draft-browser-check.mjs | Exact pre-release live client → candidate upgrade, disposable data | yes |
| loop-warning-browser-check.mjs | Simulated human journeys in real browsers, isolated synthetic rooms | yes |
| magic-link-browser-check.mjs | Magic-link one-tap sign-in via /?magic=<code>&email=<addr> | yes |
| member-perms-browser-check.mjs | MEMBER-PERMS PR2: simulated journeys against disposable real server | yes |
| message-preview-browser-check.mjs | Authoring gate: Chromium owns disclosure accessibility + retained DOM | yes |
| mobile-signin-history-browser-check.mjs | Mobile sign-in history is a real navigation boundary (Back behavior) | yes |
| moderation-browser-check.mjs | Simulated human journey, moderation surface | yes |

### Behavioral notes
- 7 of 57 A–M checks have no header comment (agent-connect, agent-signin, gmail-setup, gmail-workspace, human-experience, layout-simplification, lazy-boards) — the convention (header explains what's simulated) isn't enforced.
- Headers are admirably honest about what the checks are NOT (not human research, not retention evidence, not device/AT runs) — good epistemic hygiene.
- Quarantine is per-test skip with a repair-by date, not a separate skip list — visible in-file.

### Stale flags
- None found in this slice.

### Suspected bugs
- None found in this slice.

DONE: 57 check scripts + 8 infra files, 0 stale flags, 0 suspected bugs
