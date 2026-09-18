# Auto-Quarantine Policy — Decision Doc for Task-33 Tap

**Status:** proposal for John's decision. Code today is **flag-only** — no message is held,
hidden, moved, or muted anywhere (see `server/inbox-import-guards.mjs`). This doc is the
full specification of what auto-quarantine would do, so the tap is: **approve auto-quarantine,
stay flag-only, or approve per-channel variants below.**

**Owner:** John (inbox owner). **Reviewers with override:** John only, unless he names a delegate.
**Last reviewed:** 2026-09-18. **Policy version:** v1 (this doc).

Related: `server/inbox-spam.mjs` (pure scorer), `server/inbox-import-guards.mjs` (flag-only
wiring into the import funnel), `server/spam-quarantine-journal.mjs` (durable held/released/
dismissed journal — exists today, empty), `server/inbox-triage.mjs` (decider: score ≥ 60 →
`quarantine` action, ≥ 30 → `needs_human`).

---

## 1. What changes if John taps "auto-quarantine"

Today a message that trips the flag is journaled on the `source.import` receipt with its score
and signals, and it still lands in the inbox normally. Auto-quarantine changes exactly one thing:

> A message scoring at or above the per-channel hold threshold is **held out of the main inbox**
> and recorded in the durable `spam_quarantine` journal as `held`, with its score, the exact
> signals that fired, the policy version, and a timestamp. It stays there until the owner
> **releases** it (back to the inbox) or **confirms it as spam** (`dismissed`).

What does **not** change, ever:

- **Nothing is deleted.** Held messages are fully recoverable until the owner dismisses them,
  and even a dismissed record stays in the journal (out of the inbox, not out of the record).
- **Nothing is silent.** Every hold is visible in the quarantine review view and in the daily
  held-count digest (see §6). "Auto-quarantine" means held from the main inbox, not invisible.
- **Nothing is automatic on scores below the hold threshold** — those keep today's behavior
  (flag + triage `needs_human` ≥ 30).
- **The scorer stays pure.** `flagMessage()` remains network-free, deterministic, and replayable;
  only the enforcement step changes from flag-only to hold.

## 2. Proposed thresholds, per channel

Thresholds are grounded in the actual signal weights in `server/inbox-spam.mjs`. Score is
0–100; a message needs enough stacked signals to clear the bar — one strong signal alone
never holds anything.

### 2.1 Signal weights (current code, single source of truth)

| Signal | Weight | Channels that can fire it |
|---|---|---|
| `dangerous_attachment` (exe/js/ps1/…) | 35 | email, Telegram |
| `telegram_impersonation` (bot display-name from a different handle) | 35 | Telegram |
| `link_text_mismatch` (visible URL ≠ target host) | 30 | email, Telegram |
| `credential_harvest` (asks for password/login via link) | 30 | email, Telegram |
| `display_name_mismatch` | 25 | email |
| `telegram_giveaway_lure` (airdrop/double-your-money + link) | 25 | Telegram |
| `telegram_join_lure` (t.me invite + lure words) | 20 | Telegram |
| `reply_to_mismatch` | 20 | email |
| `suspicious_tld` (xyz/top/click/…) | 15 | email, Telegram |
| `bulk_recipients` | 15 | email |
| `urgency_pressure` | 12 | email, Telegram |
| `bot_spam_pattern` (generic messaging-spam phrasing) | 12 | Telegram |
| `shouty_subject` | 8 | email |
| `bad_reputation` (prior quarantines/flags) | 25 | — currently **inert** (see §7) |
| `burst_sender` (many messages, short window) | 20 | — currently **inert** (see §7) |

Quarantine flag trips at **score ≥ 60** (`quarantineThreshold`).

### 2.2 Recommended per-channel hold thresholds

| Channel | Hold threshold | Rationale |
|---|---|---|
| **Telegram (bot DMs + groups)** | **60** — same as the flag threshold | A Telegram impersonator with a lure (`telegram_impersonation` 35 + `telegram_giveaway_lure` 25) scores exactly 60: a classic impersonation attack auto-holds at 60 and would *not* at 70. Bot-spam patterns that fire `bot_spam_pattern` (12) alone can never hold anything. The false-positive profile here is narrow: legit messages with t.me links + hype words top out at ~52 (`join_lure` 20 + `bot_spam_pattern` 12 + `urgency` 12 + `suspicious_tld` 15). |
| **Email** | **60** — same as the flag threshold | A real phish stacks fast (`link_text_mismatch` 30 + `credential_harvest` 30 = 60 exactly). Legit newsletters trip at most `shouty_subject` (8) + `urgency` (12) + `suspicious_tld` (15) ≈ 35. 60 keeps the margin. |
| **Personal Telegram chats (future Business API, task 12)** | **Flag-only — no auto-hold** | If/when John's personal DMs flow in via the Business API, false positives cost far more (missed real people) than on a bot's public groups. This channel stays flag-only until a separately-tapped policy exists. A false hold on John's own contacts is the #1 trust risk of this whole feature. |

One shared number (60) with one channel exception (personal chats stay flag-only) is deliberately
simple: a per-channel 60/70/80 split would look configurable and buy nothing, because the
signal sets were already tuned per channel. If the shadow period (§5) shows Telegram
false-positives, the fix is adjusting weights, not inventing a second threshold.

### 2.3 Hard gates that override the score (apply before any hold)

Even at score ≥ 60, a message is **never auto-held** when any of these is true — these are
coded as pre-conditions, not policy preferences:

1. **Sender is on the owner's allowlist** (contacts, providers, agents with standing) — flagged only.
2. **Message is a reply in an existing thread** the owner has participated in — auto-quarantine
   applies to *first-contact* inbound only. You never auto-hide a conversation already in progress.
3. **Sender is a verified bot/connector the room itself operates** (its own lane bots, bridges).
4. **The message is an operator/service notification** the import path recognizes as machine-generated
   (webhook receipts, delivery journals).

These gates are the false-positive firewall. Allowlist edits are an owner action and are
journaled like everything else.

## 3. Appeals / override path (who can undo a hold, and how)

The durable journal (`server/spam-quarantine-journal.mjs`) already implements the lifecycle:
`held` → `released` (back to the inbox) or `held` → `dismissed` (confirmed spam, stays out).
Every transition records `reviewed_by`, `reviewed_at`, and a `note`; reviewed rows are final
(no status flips, enforced by `SpamQuarantineJournal.verify()`).

| Action | Who | Effect |
|---|---|---|
| **Release** | John (or named delegate) | Message returns to the inbox with its flag intact; optionally adds sender to allowlist in the same step |
| **Confirm spam** | John (or named delegate) | Status → `dismissed`; message stays out of the inbox; record retained for audit |
| **Propose release** | Any agent with inbox access | Journaled as a review *note* only — does not change status. Agents can argue; only the owner taps |
| **Owner undo** | John | A release or dismissal can be reversed by John alone, journaled as a new transition with reason |

**Quarantine review UI** (build alongside enforcement): one screen listing held messages with
score, the exact signals that fired (so the owner sees *why*), sender, channel, age; one-tap
Release / Confirm spam / Allowlist-sender; bulk actions for obvious bot waves. No message
requires more than two taps to resolve.

## 4. Audit trail requirements (what gets journaled, and the guarantees)

Auto-quarantine enforcement must record, for every hold, at minimum:

- message id, channel, connection id
- score (0–100) and the full fired-signal list `{key, weight, detail}`
- the **policy version** (this doc's version string) and the threshold config snapshot that ran
- `quarantined_at` timestamp and the mover identity (the policy engine, not a person)
- the §2.3 gate evaluations (which gates were checked, which — if any — passed/failed)

Guarantees:

1. **Append-only.** Held rows are never edited in place; review is a status transition with reviewer
   + timestamp. `verify()` enforces: held rows have no review fields, reviewed rows name a reviewer,
   reviewed rows are final.
2. **Replay-deterministic.** The import-guard journal already replays the exact flag from recorded
   inputs; the hold decision must be recomputable from the journaled policy snapshot — a config
   change never rewrites history.
3. **Survives restart and operator read-only opens** (the journal's existing schema rules:
   additive table, no schema-version bump, exact table-list integrity gate).
4. **Exportable.** Held/released/dismissed counts and the reason breakdown feed the channel-health
   view and the CSV audit export (`server/csv-export.mjs` extension) so John can review exactly
   what the room held, when, and why.

## 5. False-positive handling (the shadow period + the tuning loop)

The single most important recommendation: **do not flip the switch on day one.**

1. **Shadow mode first (recommended: 14 days).** Run the exact enforcement logic, journal every
   *would-be* hold with its score and signals, but keep flag-only behavior visible to the owner.
   At the end, the doc's appendix gets a real false-positive report: would-be holds, how many
   John would have released, which signals fired on legit mail. If releases exceed ~5% of holds,
   the weights get tuned before anything hides.
2. **The quarantine view shows *why*.** Every held message displays its fired signals in plain
   language ("sender name is an address on a different domain than the sender"). A hold John
   can't understand in 5 seconds is a hold that erodes trust.
3. **Tuning is weight-level, owner-approved.** If the shadow report shows a signal firing on
   legit traffic (e.g. `bot_spam_pattern` catching hype-y community posts), the fix is a
   weight change or a Telegram-specific guard — proposed in a PR, never hot-edited.
4. **False positives train the allowlist.** Every release offers one-tap "allow this sender";
   allowed senders bypass holds (gate §2.3.1) while their flags remain journaled.
5. **Digest keeps it honest.** Even in full auto-quarantine mode, the daily digest reports
   "N messages held, M released, K confirmed spam" — John sees the machine's work without
   reading every hold.

## 6. What stays human-in-the-loop (the non-negotiables)

These are **not** up for the tap — they hold in every variant of this policy:

- **John (or his named delegate) is the only release authority.** Agents propose; owners decide.
- **Nothing auto-deletes.** `dismissed` keeps the record; the inbox never silently drops mail.
- **No hold on existing threads or allowlisted senders** (§2.3) — the machine only ever judges
  first contact.
- **Impersonation alerts escalate.** `telegram_impersonation` firing on a held message is a
  *security* event, not just spam: it pages the owner's attention (urgent notify path, SLA-urgent
  channel) in addition to the hold. Someone wearing the room bot's face is always human-reviewed.
- **Policy changes are versioned and PR'd.** Threshold, weights, gates, or channel behavior
  change only via a policy-version bump + PR + this doc updated. No silent retuning.
- **Personal Telegram chats stay flag-only** until a separate tap (task 12) says otherwise.
- **External sends, deploys, and credential/token actions** are untouched by this policy —
  those remain John's explicit taps per the room's standing rules.

## 7. What auto-quarantine depends on (honest gaps, not blockers)

- **`bad_reputation` and `burst_sender` signals are inert today.** The import path cannot see
  sender reputation or burst counts (see the comment in `server/inbox-import-guards.mjs`:
  "reputationScore, burstCount — stay null and skip their signals"). The reputation store is a
  later slice; auto-quarantine at 60 must be validated on the deterministic signals alone —
  which the shadow period does.
- **The quarantine review UI does not exist yet.** Enforcement without a review screen is a
  black hole; ship the UI in the same slice or later, never enforcement first.
- **No telegram/email inbound is live yet.** Today the import funnel runs on fixtures and the
  webhook drain. Shadow mode becomes meaningful the moment real inbound flows; until then it
  runs on fixtures and the scores stay theoretical.

## 8. Decision requested

John, one tap:

- **A. Approve auto-quarantine** at the §2.2 thresholds, with §2.3 gates, §3 appeals, §4 audit,
  §5 shadow-then-live, and §6 non-negotiables.
- **B. Approve Telegram-only auto-quarantine** (email stays flag-only — email false positives
  hurt more, since providers and recruiters live there).
- **C. Stay flag-only everywhere** — the room keeps scoring and journaling; nothing is held.

**Recommendation: A, after the 14-day shadow period.** The gates (§2.3) plus the shadow report
(§5) make the downside bounded and measurable; impersonation attacks on the bot are the one
threat class where flag-only genuinely under-protects, because a flag John hasn't read yet is
a message that still looks like it came from his bot.

---

*Appendix (filled after shadow period): would-be holds, release rate, per-signal true/false
positive breakdown, recommended weight adjustments.*

The appendix report is produced mechanically by `scripts/shadow-quarantine-report.mjs`
(pure join/labeling in `server/spam-shadow-report.mjs`, tests in
`tests/spam-shadow-report.test.js`), run read-only against the store:

    node scripts/shadow-quarantine-report.mjs --store <room.db> \
      --since 2026-09-18T00:00:00Z --review-window-days 14

It joins each `receipt.shadowQuarantine` decision (server/spam-shadow.mjs) to the
`spam_quarantine` review outcome (dismissed = confirmed spam, released = ham),
labeling true/false positives, false negatives (dismissed but never would-be-held),
pending review, expired-unreviewed, and unjournaled records, and prints precision,
false-positive rate, recall, and per-signal true/false-positive breakdowns.
