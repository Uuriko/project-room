# Project Room design direction

This file says what Room's human side should feel like. Read it before you
change anything a person sees: a page, a control, an empty state, a message
template, an email, or UI copy. Then check the work against the filter in
[.agents/skills/room-antislop/SKILL.md](.agents/skills/room-antislop/SKILL.md).

Precedence, highest first:
1. [AGENTS.md](AGENTS.md) and explicit owner instructions (John, Potter).
2. Mechanical gates in `npm run lint`: the design-token ratchet, the i18n
   harness, and the UI-strings catalog. If prose here disagrees with a gate,
   the gate wins. Fix this file.
3. This file.
4. The room-antislop filter.

The Sep 20 public-face and DM-consent engineering design that used to live at
this path is now [archived in docs/history](docs/history/DESIGN-2026-09-20.md).

## Where this comes from

This file carries forward the direction we already had. It doesn't replace
it.
- [docs/HUMAN-EXPERIENCE-PLAN-20261006.txt](docs/HUMAN-EXPERIENCE-PLAN-20261006.txt):
  "A conversation with your friends and one helpful assistant, where projects
  get done without everyone having to manage the machinery behind the
  assistant." Its five design rules still hold:
  - One room, one main conversation, one assistant voice.
  - Ordinary language is the primary control surface.
  - Work appears inside the conversation and expands only when needed.
  - Show outcomes, important activity and decisions; keep internal
    coordination quiet.
  - Shared context never erases who asked, who agreed or who can authorize an
    action.
  The same plan says to keep the implementation sophisticated and the
  interface small.
- `src/design-tokens.js`: one design system (dark charcoal, Inter, indigo)
  that every surface embeds.
- Instinct-3's consolidated human-use plan (v1.2 in muse-room) is canonical
  for slice-level decisions. The Oct 9 human-side v2 rules below feed it.

The anti-slop filter joins as checks on top of this direction. Adopted
2026-10-09 as an Instinct-3 product decision (muse-room 8634).

## The test

A non-technical friend has an invite link and a phone. Within 30 seconds they
understand what this is. Without help, they ask for something, see it being
worked on, add to a friend's ask, and get a result they can use. Judge every
human-facing change against that.

## Product direction (fixed; don't relitigate in a PR)

- **Chat is home.** Updates, Work, People, and Connections support the chat.
  They don't replace it, and they don't add a second home.
- **One assistant voice.** The humans see one Room assistant. Worker agents
  sit behind it, visible on demand. Room speaks when asked (@Room or Ask
  Room), and silence is a valid end of a turn.
- **Minimal login.** John chose a single compact form on Oct 9: logo and name,
  Google, Email, Password, Log in, Create account and Agent sign in. Signup
  switches in place; recovery opens only when asked. Saved sessions enter the
  room directly. Proof, claims, protocols, and diagnostics stay out of login.
  `tests/landing-hero.test.mjs` pins this entry contract. Adding one line
  that says what Room is would be the owner's call. It isn't a filter
  finding.
- **Shared things are visible by default.** An ask, its additions, and its
  controls never sit behind a collapsed toggle. If no human saw it, it
  doesn't exist.
- **Agents fold. People and questions never do.** Run-linked status and
  receipts fold under their own ask ("Room is working · N updates"). Human
  messages, questions to a person, @mentions, alerts, and results always stay
  visible. A message of unknown kind stays unfolded.
- **Words stay with their author.** Additions are separate, attributed
  messages. Nothing co-edits or rewrites another person's prompt.
- **One owner per thing, shown on its face.** Every ask shows whose it is.
- **One number, one source.** A badge equals the length of the list it opens.
  "34 updates" next to "Nothing needs you" is a bug.
- **Honest states, with a next step, before the commit.** Offline,
  unverified, and no-reviewer states show before Send or Create, not after.
  An empty state says what is hidden and why.
- **Rollups obey the source's privacy.** A fold label, digest, notification,
  or doorway page never shows text the viewer couldn't read raw.
- **Same state on every surface.** Shared operational state is available
  consistently in UI, REST and MCP, subject to each identity's permissions.

## Copy

- Use plain words, one per action. It's "Log in" everywhere. "Agent sign in"
  is the one named exception.
- Never invent numbers, testimonials, customers, or claims. Show a real count
  from real data, or show nothing.
- Money wording must agree with itself on every surface. If payment isn't
  configured, no surface may show a price as if it were payable.
- Never show `ai_`, `pri_`, raw member ids, or internal state names to a
  person. Use display names and plain verbs.
- Write for the person in front of the screen. Lane names, seq numbers,
  receipts jargon, and QA vocabulary belong in docs and muse-room, not on
  /offers or /receipts.
- Every user-facing string goes in `strings/en.json` and is read by key. One
  full sentence per entry, with named placeholders. The i18n harness enforces
  this.
- Don't add new em dashes to user-facing strings. Use a period, comma,
  colon, or parentheses. Don't churn existing strings just to remove one.

## Visual system

Canonical values live in [src/design-tokens.js](src/design-tokens.js). The
marked blocks in `src/styles.css` are generated by
`node scripts/sync-design-tokens-css.mjs`, so don't hand-edit them. Dark is the
product default, and light is opt-in through `[data-theme="light"]`. Don't
auto-switch on `prefers-color-scheme`.

| Role | Token | Dark | Light |
|---|---|---|---|
| Page background | `--bg` | `#202127` | `#f4f3f8` |
| Panel / card | `--panel`, `--card` | `#191a20` | `#fffbff` |
| Raised surface | `--panel-raised` | `#292b33` | `#e8e7ef` |
| Rules and borders | `--line`, `--border` | `#393b45` | `#c9c8d4` |
| Body text | `--text` | `#eeedf1` | `#1c1b22` |
| Secondary text | `--muted` | `#aaaab7` | `#5c5b6a` |
| Links and focus | `--blue` | `#a9b9ff` | `#33339a` |
| Primary action fill | `--blue-strong` | `#5555bd` | `#3f3fad` |
| Warning / stalled | `--amber` | `#ffbf69` | `#8a4b00` |
| Success / included | `--green` | `#4fd09b` | `#0f6b45` |
| Error / failed | `--red` | `#ff7b7b` | `#a32020` |

- **Type:** `--font-sans` (Inter, then system UI). Sizes come from
  `--text-xs` (.75rem), `--text-sm` (.875rem), `--text-md` (1rem), and
  `--text-lg` (1.25rem), and the wordmark uses `--text-wordmark`.
  `scripts/lint-design-tokens.mjs` fails on any new raw `font-size` or hex
  literal.
- **Space:** use `--space-1` through `--space-6` (.25rem to 2rem).
- **Radius:** `--radius-sm` .35rem, `--radius-md` .45rem, `--radius-lg`
  .85rem, `--radius-xl` 1rem. Not everything is a pill.
- **Elevation:** use one `--shadow`, for overlays only.
- **Accent discipline:** indigo marks the action and the link. Amber, green,
  and red carry state, and never decoration. Pair state color with words,
  because color alone isn't enough.
- **Focus:** keep the 2px `--blue` outline from `src/styles.css`. Never remove
  it without a visible replacement.
- **Targets:** a primary control is at least 44px tall on touch screens, and
  an inline link or disclosure has at least a 24px target (WCAG 2.5.8).
- **Motion:** use motion only for state changes the person caused or must
  notice. Nothing loops forever.

## Slop we have already shipped (don't repeat it)

From the Oct 9 QA and first-run click-through. Each item has a filter rule.

| Seen | Why it's slop | Do instead |
|---|---|---|
| /receipts and /offers read like internal QA output | Internal vocabulary on a public page | Say what a visitor can do there, in their words |
| An offer shows a cash amount while the detail says payment isn't configured | Money wording contradicts itself | Show the amount only when it can be paid. Otherwise say plainly that it's unpaid |
| Raw `ai_…` ids in the room assistant's answer (fixed in #2309) | Machine ids on a human surface | Use display names |
| A guest sees "No messages yet" in a 35-message room | An empty state that lies | Say "Earlier messages aren't shared with guests here" |
| "Log in" on the landing page, "Sign in" on the form (fixed in #2303) | Two words for one action | One word everywhere |
| Sign-up and login links use `.text-button` at .69rem (about 11px), with targets the QA click-through measured at about 8px | Text and tap target too small | Body-size text. At least 24px for inline links, 44px for primary controls |
| New work's Create silently does nothing without a reviewer | A dead control | Show the reason and the choice before Create |
| A multiplayer ask hidden under a collapsed Activity toggle | Shared state behind a disclosure | Show the card in the stream |

## When this file is wrong

If a product decision changes, update this file in the same PR as the change,
and name who decided. Don't let a stale direction stand.
