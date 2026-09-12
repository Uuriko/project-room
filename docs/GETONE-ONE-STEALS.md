# getone.one → Project Room steals

Source: https://getone.one/ v0.1.25 · kyzo (@ky__zo) · Amore ship · YouTube Xq7jUy7dch4  
Researched 2026-09-11. Folded into Room 2026-09-12. Live site only — no binary screenshots in this repo.

## What it is

Siri-style macOS toolbar for terminal coding agents. Local Mac. Not a collaboration desk.

Room is the opposite product: a shared human + agent ledger (Work Items, next actions, receipts). Steal the *face* (handles, Done, Works-with, quiet paper/ink, hover-teach). Do not port the Mac.

## Tokens

ground `#f7f7f7` · paper `#fff` · ink `#262523` · muted `#5c5c5c` · quiet `#8b8985` · line `#ebebe9` · rule `#e7e4df` · hover `#4d4a46` · dark `#171715` · green `#48a16b` · Inter · pill CTAs · max-w ~1180

Workspace mirrors these as optional `--room-paper`, `--room-ink`, `--room-quiet`, `--room-rule` (and the rest) in `src/styles.css`. They are not the live theme. The getdasha public door keeps black / acid.

## Screens (link the live site; do not commit PNGs)

| Shot | Live | What to steal |
| --- | --- | --- |
| Hero | https://getone.one/ | Left: “Toolkit for talking to your agents in terminal.” Pill CTA. Tiny platform line. Quiet **Works with** runtime marks (Claude Code, Codex, OpenCode, Pi / herdr). Right: a black stadium pill with a hand-drawn “hover over me” — teaching without a lecture. |
| Product UI (OG) | https://getone.one/ (Open Graph / social card; typically `/og.png` on that origin) | Dark floating composer. Loud handle `@codex-12` in the header. Thread + reply field. Green **Done** chip: “Header button is blue.” Trailing `@claude-7` receipt: “Done. The logo pop now.” Right rail: traffic-light dots, chat, mic, camera, gear — attributed activity, not a settings dump. |
| Video | https://getone.one/ and https://www.youtube.com/watch?v=Xq7jUy7dch4 | Full-bleed still, yellow type (“i miss the times when AI was easy”), kyzo on the terrace. Maker voice, not a feature tour. |

OG UI in one line: a docked black capsule that makes the *agent handle* and the *Done receipt* the only loud things.

## Steal into Room

1. `@agent` handles louder (`@codex-12` style) + Done chips
2. Agent status toasts / activity strip attributed to Members
3. People rail: presence dots + one-line “what they’re on”
4. Connect an agent: Works-with runtime logos (Claude Code, Codex, OpenCode, Pi) → packet; no keys
5. Quiet paper/ink chrome for workspace (getdasha public door may keep acid)
6. Hover-reveal teaching without lecture
7. Honest beta permission/join matrix (packet / guest / enrolled)

## This PR shipped

- This map.
- getdasha `PUBLIC_ROOM_DOOR_HTML`: calmer Connect copy (handles + Done receipts) and a text **Works with** row (Claude Code · Codex · OpenCode · Cursor) → `/room/llms.txt`. No fake logos. No One / Amore claim.
- Optional `--room-*` tokens + a `.member-status` placeholder on the People rail (one-line status, not a redesign).

## Still for Instinct (after merge)

- People-rail one-line “what they’re on” (presence dots + live status, not just kind).
- Handoff **Done** chips next to loud `@agent` handles.
- Workspace paper/ink chrome if/when a quiet theme is wanted. Door stays acid.

## Non-steals

Voice/mic/screen capture web, Mac Accessibility, One/Amore affiliation claims, Compute fold, people-data, Phase 0 ledger rewrite (#8/#9).
