# Room steals trio — 2026-09-17

Sources:
1. Warp Scorers — https://x.com/warpdotdev/status/2100623731294978243 · https://www.warp.dev/blog/using-llm-as-a-judge-scoring-to-measure-your-software-factory
2. Kitze Skillbox MIT — https://x.com/thekitze/status/2100645617181532598 · https://github.com/kitze/skillbox
3. 0xSero harness-bridge — https://x.com/0xSero/status/2100643846086389857 · https://github.com/0xSero/harness-bridge

## Warp Scorers → Project Room
**What:** LLM-as-judge agents grade *past* coding sessions on Quality / Efficiency / Compliance / custom. Sampled (~3% tokens). Classifications + pass threshold (not vanity 1–10). Observer loop proposes factory/skill PRs from failing patterns. Needs full traces (tools + artifacts + human comments).

| Steal | Room mapping | Don’t |
|-------|--------------|-------|
| Trace-as-Receipt | Work Item Done already wants receipts — store agent trace + Cua screenshot/shell as judge input | Fake scores without traces |
| Scorer = Work Item type “Grade” | Optional kit: scorer agent member with rubric skill; samples Done chips | Stuff into Compute Start |
| One dimension per scorer | Compliance / Efficiency / people-data-safe / used-right-kit | One mega-judge |
| Sample rate | Score 5–25% of agent sessions; on-demand re-score for kit testing | Score every chat turn |
| Self-improve → PR on Room instructions/skills | Observer proposes patch to ROOM kits / agent instructions (human merge) | Auto-merge skill changes |
| Failure click-through | Open scorer run + original Work Item thread side-by-side | Opaque “72% quality” badge |

**Fits CUA Phase 2:** Fleet/Driver receipt + trajectory is exactly the artifact Warp wants for judges.

## Skillbox → Project Room kits
**What:** Self-hosted versioned skills library — Markdown revisions, profiles/grants, revocable client keys, HTTP MCP + stdio bridge, optional **Jev** skill routing, Docker setup. README is agent-first (“ask your agent to set it up”). Never executes skill code.

| Steal | Room mapping | Don’t |
|-------|--------------|-------|
| Agent-first install copy | kits.txt / Connect: “paste packet into your agent” already — lean harder | Human marketplace shelf |
| Versioned immutable skill revisions | Room kit cards with checksum + restore | Silent overwrite of Connect packet |
| Scoped client keys + usage | Aligns with Add agent digest keys | Share one key across agents |
| Jev recommends skills from query | Room “which kit?” using TypeSafe Jev (already noted) instead of 30-turn search | Require Jev SaaS |
| Import scattered markdown → library | Port Grok/Muse skills into Room skill door later | Fork Skillbox into Room Worker cold |

**Use vs fork:** Prefer *steal shape* + optional self-host Skillbox beside Room; don’t collapse into Compute.

## harness-bridge → Room agent hosts
**What:** MIT local bridge — any harness (Claude Code, Codex, OpenCode, Pi, Grok…) → any OpenAI/Anthropic/Responses endpoint. Core + CLI + macOS tray + localhost web. Discovers live models; doesn’t edit ~/.claude.json etc.

| Steal | Room mapping | Don’t |
|-------|--------------|-------|
| Provider once · pick model · pick harness | Room Connect “bring your agent” panel: endpoint + model + harness | Force one vendor |
| Live model discovery | Honesty: list what the Room Mac / Compute endpoint actually serves | Invent Astra if offline |
| Inert harnesses when dialect missing | Show why a harness can’t run (visible reason) | Hide broken options |
| Keys never on argv / never logged | Matches Room import connection.json rules | Paste keys in chat |
| Local-first tray | Optional companion for enrolled agents on laptop | Drive Potter laptop unrestricted |

**Roy ladder fit:** default fast model via bridge; quality ladder is a separate pin — same as earlier steal.

## Priority for Room (no-collide)
1. **Docs only** — research note + tip Muse (this file). No client/door HTML.
2. **Kits catalog** — optional later rows: Scorer kit, Skillbox-shaped library, Harness bridge (after CUA Connect card).
3. **Receipt schema** — extend Cua Fleet receipt with `traceRefs[]` so Scorers can judge.
4. **Jev skill router** — when TypeSafe key exists, “recommend kit” on Work Item ask.
5. Skip hosting Skillbox/Warp Factories now — steal contracts first.

## Stay-outs
People-data in traces/screenshots · Phase 0 #8/#9 · Muse People rail / Connect HTML · Compute Start blob · Auto-billing Fleet without delete

## Cross-link — Scorers need Cua/Fleet receipts as judge input

`docs/ROOM-CUA-DESKTOP.md` and `research/CUA-FLEET-SPIKE-2026-09-17.md` are not on `main` yet; they live on [#454](https://github.com/Uuriko/project-room/pull/454). Scorers need those Cua/Fleet receipts (screenshot path + shell log + later `traceRefs[]`) as judge input. Do not invent Quality / Efficiency / Compliance scores without a trace. When #454 lands, add the same one-paragraph pointer on the desktop contract or Fleet spike — this note is the source until then.
