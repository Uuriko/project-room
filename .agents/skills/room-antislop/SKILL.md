---
name: room-antislop
description: Filters generic AI output out of Project Room UI, copy, and code comments. Use when building or reviewing anything a person sees (pages, controls, empty states, message templates, emails, UI strings) or when writing code comments. Read DESIGN.md first for direction.
---

# Room anti-slop filter

This is a filter, not a style guide. [DESIGN.md](../../../DESIGN.md) supplies
Room's direction. This file rejects the generic defaults that make work look
generated. When they disagree, DESIGN.md wins, and AGENTS.md plus the
`npm run lint` gates outrank both.

Adapted from [miqdadbadjuber/anti-slop](https://github.com/miqdadbadjuber/anti-slop)
v3.2.20, commit `388cbe3b6c37d5175b9f460015bb092ef9e34894` (MIT). Upstream
rule numbers (R-xx) are kept so findings can be traced. See
[LICENSE](LICENSE) and THIRD_PARTY.md.

## How to use it

- **While building:** apply the rules as you write. Before you call the work
  done, run the checklist at the end.
- **When reviewing:** list findings, each with its rule, priority,
  `file:line`, and a one-line reason. Hard rules are HIGH, purpose rules
  MEDIUM, and consistency rules LOW. Fix only what is in your claimed scope,
  and post the rest to the owner or the Board.
- **Before flagging,** check DESIGN.md. An intentional choice recorded there
  (the minimal login, dark default, the "Agent sign in" name) isn't a finding.
- **Look for clusters, not single tells.** One em dash, one eyebrow, or one
  short sentence isn't slop by itself.

## Hard rules (HIGH: honesty, function, access)

- **R-17, R-36, R-38. No invented facts.** No numbers, stats, testimonials,
  customer names, security claims, or "trusted by" without a real source.
  Empty beats fake. A placeholder says it is one.
- **Money agrees with itself.** A price, reward, or payout appears only where
  it can actually be paid, and every surface describes it the same way.
  (Room rule.)
- **R-26, C-2. Every control works or is gone.** No buttons that do nothing,
  no Create that silently fails, and no links to pages that don't exist
  (R-24). "Coming soon" only with a visible label.
- **R-27. Honest states.** Every data view has empty, loading, and error
  states, and each one says why and gives the next step. An empty state
  must be true for this viewer. A guest who can't see history must not be
  told the room is empty. First run, filtered-to-nothing, and permission
  denied are different screens.
- **No machine ids for people.** No `ai_`, `pri_`, member ids, seq numbers, or
  internal state names on a human surface. (Room rule.)
- **R-25. Contrast.** Text meets WCAG AA (4.5:1 normal, 3:1 large). Check
  both themes (R-34), since Room ships dark and light.
- **R-32. Keyboard.** Everything is reachable by Tab and works with Enter
  or Space. Dialogs close on Escape. Keep the visible focus outline.
- **R-03. Phone first-class.** No horizontal overflow, and text stays inside
  its container. Primary controls are at least 44px tall. Inline links and
  disclosures get at least a 24px target.
- **R-35. Verify before you say done.** Run it, click every control you
  touched in both themes and at phone width, and report what each one did.
  If you couldn't run it, say so. Scripted or synthetic proof is "tested",
  never "live-verified".

## Purpose rules (MEDIUM: allowed only with a reason you can name)

Gradients, glass, glow, big shadows, badges, eyebrow labels above headlines,
decorative status dots, arrows on every button, icon-in-a-circle feature
cards, background grids, endless pulses, and stacked entrance animations
(R-01, R-04, R-07 to R-14, R-19). Each one needs a reason: hierarchy,
state, or identity. "It looks modern" isn't a reason. An arrow means "leaves
this page", so `↗` on a same-site link is wrong. Color carries state, and
state always comes with words.

## App-surface tells (MEDIUM)

- A default dashboard shell (sidebar, four stat cards, chart, table) chosen
  before anyone named the screen's job. In Room the chat is the page.
- A filler activity feed or demo rows with made-up people.
- Generic columns (Name, Status, Date, Actions) instead of the field the
  person decides on.
- A bare "No data available", a spinner with no label, or a skeleton shaped
  like a layout the data never fills.

## Copy rules (LOW unless they mislead, then HIGH)

- Plain words, one per action ("Log in" everywhere).
- Cut empty AI vocabulary and inflation: "seamless", "unlock", "supercharge",
  "revolutionize", "effortless", "powerful", "cutting-edge", and "in today's
  fast-paced world".
- No chatbot closers ("Let me know if…"), fake-candid openers, or
  signposting ("Here's the thing").
- Watch for staccato drama, rule-of-three padding, and "not X, but Y"
  formulas. Flag them when they stack.
- No emoji bullets or emoji in headings. No all-caps for emphasis (the
  PROJECT ROOM wordmark is identity, not emphasis).
- No new em dashes in user-facing strings (Room's softer version of R-02).
  Upstream's core makes it a hard fail, but its own copywriting skill says
  an em dash alone isn't evidence (see upstream issue #32). We don't churn
  existing strings for it.
- Internal vocabulary (lane, claim, receipt, seq, ledger, harness) stays off
  public pages unless the page is for agents and says so.
- Strings live in `strings/en.json`, one full sentence per key with named
  placeholders. The i18n harness gates this.

## Code comments (from upstream antislop-code)

Delete comments that add nothing: banner separators, restating the line
below, step-by-step narration, "Handle errors here" placeholders, emoji, and
`// end of function` markers. Keep comments that carry a reason, an
invariant, an incident or QA reference, a `// SAFETY:` line, or a
workaround's cause. Room's comments often cite an incident or QA id. Those
are the valuable kind. Never change code to satisfy a comment rule.

## What we deliberately don't adopt from upstream

- **The mode question, the "antislop active" notice, and the
  `~/.config/antislop/settings.json` preference.** Room agents work
  autonomously under AGENTS.md. Don't stop work to ask a mode question.
- **The install wizard, auto-update, and plugin doors.** Nothing writes to
  AGENTS.md or fetches rules at runtime. A rule file you download at runtime
  is fetching your own next prompt. Update by PR, re-pinning the commit
  above after reading the upstream diff.
- **Audit files under `anti-slop/`.** Put findings in the PR, on the Board,
  or in muse-room.
- **R-23 "ask before creating any asset".** Use an honest placeholder, and
  raise owner calls through the normal channel.
- **R-33 "no script patching".** It applies to hand-rolled string-replace
  scripts. The sanctioned generators (`scripts/sync-design-tokens-css.mjs`
  and `scripts/build-ui-strings.mjs`) are how those files are meant to change.
- **The liveliness dials and "would it survive a logo swap" redesign test.**
  Room's identity is set in DESIGN.md. Don't restyle a surface to make it
  more lively inside an unrelated PR.

## Prose now, lint later

A rule that a script can check belongs in `npm run lint` with a baseline
ratchet, like `strings/i18n-baseline.json`. Candidates: no new em dashes in
`strings/en.json`, a minimum size for `.text-button`, and no enabled Copy
button on an empty field. Once a rule becomes lint, delete its prose here.

## Done checklist

- [ ] Read DESIGN.md, and the change fits the product direction.
- [ ] No invented numbers, names, claims, or prices that can't be paid.
- [ ] Every control I touched does something, and I clicked it.
- [ ] Empty, loading, and error states are true for every viewer (owner,
      member, guest).
- [ ] No raw ids or internal words on a human surface.
- [ ] Both themes, phone width, keyboard, and focus checked. Targets are 44px
      for primary controls and 24px for inline links.
- [ ] Strings are in `strings/en.json`, and `npm run lint` passes.
- [ ] I reported what was live-verified versus only tested.
