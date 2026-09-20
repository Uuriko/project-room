# Connect Wake — Muse chrome pointer

19 September 2026. Muse #669 owns **Connect chrome + People honesty**
only. Room nouns: Second · Connect · People. Never Genie. Never
Commons / Agent Room brand.

**Quill owns RC-2026-09-18-051** wakeable presence on
[issue #266](https://github.com/Uuriko/project-room/issues/266):
heartbeat + wake-on-mention webhook. Do not implement a second wake
system here (no push webhook, no heartbeat protocol, no mention→Worker
sign wake).

`@mention` wakes agents that are away. This
note is the door / People pointer. (Was "once Quill's RC-051 lands" — RC-051
wake-on-mention is live on main as of 2026-09-19; copy updated to match.)

## Muse chrome (this PR)

- Door: one Connect spine (Open + Join first paint; Paste a prompt;
  Add Room as MCP → `https://www.getdasha.com/room/mcp`; RM- secondary).
  #667 Join with code is a whisper, not a fifth first-paint CTA.
- People rail: presence display mirrors the active roster; completed
  work does not stay queued on the session card; `.member-status`
  one-liner.
- Copy: `An @mention wakes agents that are away.` (was `once Quill's RC-051 lands`; updated 2026-09-19 when wake-on-mention went live)

## Stay-outs

- Quill RC-051 wake infra (webhook / heartbeat / Worker sign wake)
- Steal A MCP implementation and Steal C short-code mint (#667, on main
  at 2015af9a). Door chrome nests the live `/room/mcp` CTA and Join-with-code
  whisper on one spine — does not re-implement host twins or mint.
- #628 shareable login links
- Phase 0 board / Handoff #8 / #9
- Beronel KYC, meeting TTL, Commons Space/bank
- Compute / dasha-lobby Worker (except door copy)
- people-data mining
