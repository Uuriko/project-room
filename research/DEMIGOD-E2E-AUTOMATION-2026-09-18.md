# Demigod E2E automation — DIE matching desk

18 September 2026. Folds the 17 September fully-automated
matching-desk design. **Docs only.** Not a live DIE writer, not a
Demigod site edit, and not a Project Room product change.

**Fully automated** here means a **company-OS stage machine**.
Software moves the desk. A human sits only on the kill-switches:
**send ticket**, **consent**, **both-sides intro**, **invoice
send**.

Parents (cite only — do not rewrite):

- [FAQ · Demigod](https://www.trydemigod.com/faq) — software
  compares evidence; a human proposes; both sides approve before
  any intro; no public pile; talent free; startup fee is 10% of
  first-year cash when a hire starts
- [GOAL-AGENT-HUMAN-FIRST-2026-09-06.md](../docs/GOAL-AGENT-HUMAN-FIRST-2026-09-06.md)
  — keep Project Room separate from Desk, Demigod/DIE, and Dasha
- [ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md)
  — Room stays Second · Connect · ledger. DIE is not Room.

Product personal agent (Room) is **Second**. Never Genie.
Compute ≠ Room. DIE matching ≠ Ask.

---

## 0. One line

Observe → packet → brief → queue → consent → intro → trial →
invoice. First slice is **`die-packet-brief-status`**: Lightfield
packet → brief → status, with outbound sends **blocked**. Measure
**one Lightfield hire**, not a shipped stage.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| Demigod FAQ / live matching | **Cite only.** Do not rewrite trydemigod.com. |
| Project Room Ask T0xx briefs | **Not this path.** Different product. |
| dasha-lobby Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / [#262](https://github.com/Uuriko/dasha-lobby/pull/262) / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) / [#274](https://github.com/Uuriko/dasha-lobby/pull/274) | **Hands-off.** Quill owns `dasha-compute.html` + embed. |
| dasha-lobby HTML / Worker / tests | **Hands-off.** |
| Instinct wrangler | **Hands-off.** No tip HTML. No wrangler. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** gemma stays draft. |
| people-data / contact waterfall | **Banned.** Company-only enrichment. |
| Lightfield CRM | Packet **source**. Not a Room object. Not a people dump. |

Paths this fold owns:

- `research/DEMIGOD-E2E-AUTOMATION-2026-09-18.md` (this file)
- `tests/demigod-e2e-automation-docs.test.js`
- index rows on `research/README.md` and `docs/README.md` in a
  **Demigod / DIE matching** section (create it; do not bury next
  to Ask T0xx)

No `client/` · `cloudflare/` · `server/` · `src/` · Worker ·
wrangler · Designer · people-data · `plugin.jup.ag` · Quill login
· Potter keys · dasha-lobby HTML / Worker / tests · `#258`
undraft · `#260` HTML · auto-DM · salary history.

---

## 2. What “fully automated” is (and is not)

A company-OS stage machine. The desk advances company packets
and role briefs without a human writing the research. The human
does **not** leave the loop on irreversible contact or money.

| Kill-switch | Human must | Machine must not |
| --- | --- | --- |
| **Send ticket** | Press send on a named role ticket | Auto-email / auto-DM the company or talent |
| **Consent** | Both sides opt in to the exact company, role, and base-cash band | Infer consent from a click on a public profile |
| **Both-sides intro** | Approve the warm intro | Send the intro because the queue scored high |
| **Invoice send** | Send the 10% invoice after a hire starts | Auto-bill on “shipped” or on intro |

FAQ lock ([trydemigod.com/faq](https://www.trydemigod.com/faq)):
software compares role goals, skills, location, compensation, and
evidence of past work; a human decides what to propose and can
explain why; identity stays private until both sides approve.

---

## 3. Hard bans

| Ban | Why |
| --- | --- |
| **No people-data** | Room already bans it. DIE does not become a contact graph. Company packets only. |
| **No auto-DM** | FAQ: no blast, no cold LinkedIn, no spam sequence. Ticket / intro / invoice are kill-switches. |
| **No salary history** | [California Labor Code §432.3](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=432.3.) — do not seek or rely on prior pay. Band is cheap talk about the **role**, not the person. |
| **SF trial is EOR / W-2, not 1099** | Trial hire in San Francisco is employment (employer-of-record or W-2). Not a contractor dodge. |

---

## 4. Stage machine

```
observe → packet → brief → queue → consent → intro → trial → invoice
```

| Stage | Machine does | Human kill-switch |
| --- | --- | --- |
| **observe** | Watch public company signals (jobs, product, stage). No people scrape. | — |
| **packet** | Build a Lightfield-shaped **company** packet (world model of the firm, not a contact list). | — |
| **brief** | One-result role brief: must-haves, arrangement, base-cash band, first measurable result. | — |
| **queue** | Horton-style **recommend-into-queue**. Scorecard attributes. Citations. | — |
| **consent** | Show exact company / role / band. Wait. | **Consent** — both sides approve |
| **intro** | Draft the warm intro. Do not send. | **Both-sides intro** |
| **trial** | Track SF EOR / W-2 trial. Not 1099. | — |
| **invoice** | Draft the 10% invoice after start. Do not send. | **Invoice send** |

**Send ticket** sits on the packet→brief→queue edge: the desk
may draft; a human sends.

Status is first-class. A stage can be `blocked` (send held),
`ready` (kill-switch armed), or `measured` (Amplitude: shipped
is not the win).

---

## 5. Steal / reject (short)

| Source | Steal | Reject |
| --- | --- | --- |
| Horton [employer_search.pdf](http://john-joseph-horton.com/papers/employer_search.pdf) | Recommend **into a queue**. Recs expand the pool; they do not contact. | Auto-recruit / auto-DM the recommended person. |
| Horton [cheap talk](https://john-joseph-horton.com/papers/hot_towel.pdf) | Role band + “what this hire owns” as searchable cheap talk so both sides sort. | Asking salary history. Babbling bands with no first result. |
| [Greenhouse structured hiring](https://support.greenhouse.io/hc/en-us/articles/360039539772-Structured-hiring-guide) | Scorecard **before** judging. Few attributes. Evidence, not vibe. | Keyword soup JDs. Unstructured “looks like a fit.” |
| [Amplitude Wave](https://amplitude.com/docs/wave/opportunities) | **Shipped ≠ Measured.** Status moves to Measured only on the target metric. | Counting the stage machine as done because the docs shipped. |
| [Ashby AI](https://www.ashbyhq.com/ai) | **Citations** on every claim. Human verifies / flags / overrides. No numeric rank of people. | Black-box shortlist. Auto-rank applicants. |
| [HumanLayer](https://www.humanlayer.dev/blog/12-factor-agents) / [Factory agent controls](https://docs.factory.ai/enterprise/llm-safety-and-agent-controls) | Deterministic **blocklists** + require-approval on send/ticket/intro/invoice. Block has no skip-approvals path. | `DangerouslySkipPermissions`. Soft denylist that auto-approves under autonomy. |
| [Parallel](https://docs.parallel.ai/findall-api/features/findall-enrich) / [Exa company](https://exa.ai/docs/reference/verticals/company-for-coding-agents) + [Clay waterfall](https://university.clay.com/docs/building-a-data-waterfall) | **Company-only** waterfall (domain → firmographics). | People-data waterfall. Phone / personal email / contact-out. |
| [Twenty CRM objects](https://docs.twenty.com/getting-started/core-concepts/data-model) | Company / opportunity / task objects. Packet is a company record. | Dumping People as the matching graph. |
| [Product Talk OST](https://www.producttalk.org/opportunity-solution-trees/) | One outcome at the top (a Lightfield hire). Opportunities under it. Do not jump to a full ATS. | Solution-first “build the marketplace.” |
| [Lightfield](https://lightfield.app) | Packet source: company world-model from public + opted-in company systems. | Treating Lightfield as a people-data CRM for outreach. |

---

## 6. Now / Next / Later

### Now — `die-packet-brief-status`

Lightfield **packet → brief → status**. Sends stay **blocked**.

| In | Out |
| --- | --- |
| Observe one company (Lightfield) | Ticket send |
| company-only packet (no people-data) | Consent UI beyond a private draft |
| One-result brief + base-cash band | Intro send |
| Status: `blocked` / `ready` / `measured` | Invoice send |
| Citations on every brief claim | Queue ranking of people |

Name of the slice: **`die-packet-brief-status`**.

### Next

Recommend-into-queue (Horton) + Greenhouse scorecard attributes +
Ashby-style citations. Consent kill-switch. Still no auto-DM.

### Later

Both-sides intro · SF EOR/W-2 trial tracking · invoice send.
OST stays one outcome: a hire, not a platform.

---

## 7. Anti-patterns

- Auto-DM, LinkedIn blast, or “the queue sent it.”
- People-data scrape, contact waterfall, or a public talent pile.
- Seeking or storing **salary history** (CA Lab. Code §432.3).
- SF trial as **1099**.
- Shipping the stage machine and calling it Measured.
- Numeric rank of people. Ashby: human decides; citations only.
- Skip-approvals on ticket / intro / invoice.
- Burying this note under Ask T0xx. DIE ≠ Compute.
- Touching Quill, dasha-lobby HTML, wrangler, or undrafting `#258`.
- Becoming an ATS or a Room People-rail.

---

## 8. Measure

[Amplitude Wave](https://amplitude.com/docs/wave/opportunities):
**Shipped ≠ Measured.** The first measured outcome is **one
Lightfield hire** — a person starts, on an EOR/W-2 trial if the
role is SF, after both-sides consent and a human-sent intro.

Do not report `die-packet-brief-status` as a win. That slice
only proves packet → brief → blocked status.

---

## 9. Primary URLs

| Claim | Primary |
| --- | --- |
| Structured hiring / scorecards | https://support.greenhouse.io/hc/en-us/articles/360039539772-Structured-hiring-guide |
| Recommend-into-queue | http://john-joseph-horton.com/papers/employer_search.pdf |
| Cheap talk | https://john-joseph-horton.com/papers/hot_towel.pdf |
| Demigod matching rules | https://www.trydemigod.com/faq |
| Opportunity Solution Tree | https://www.producttalk.org/opportunity-solution-trees/ |
| Shipped ≠ Measured | https://amplitude.com/docs/wave/opportunities |
| AI citations, no auto-rank | https://www.ashbyhq.com/ai |
| Human-in-the-loop / require approval | https://www.humanlayer.dev/blog/12-factor-agents |
| Agent blocklists | https://docs.factory.ai/enterprise/llm-safety-and-agent-controls |
| Salary history ban | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=432.3. |
| Company waterfall (Clay) | https://university.clay.com/docs/building-a-data-waterfall |
| Company-only search (Exa) | https://exa.ai/docs/reference/verticals/company-for-coding-agents |
| Company enrich (Parallel) | https://docs.parallel.ai/findall-api/features/findall-enrich |
| CRM objects | https://docs.twenty.com/getting-started/core-concepts/data-model |
| Lightfield packet source | https://lightfield.app |

---

## 10. Done when

- [x] Stage machine named (observe→…→invoice)
- [x] Steal / reject table (short)
- [x] Now / Next / Later
- [x] Anti-patterns
- [x] First slice name: `die-packet-brief-status`
- [x] Primary URLs cited
- [x] Index rows in a Demigod / DIE matching section
- [x] Docs lock test
- [x] No dasha-lobby HTML, no wrangler, no Worker, no people-data,
      no Quill, no `#258` undraft

Stay-outs: Instinct Phase 0 `#8` / `#9` · Muse UI · Quill
`#260` / `#262` / `#266` / `#274` · Designer-publish ·
people-data · `plugin.jup.ag` · **direct wrangler** · dasha-lobby
HTML / Worker · `#258` undraft · `#275` rewrite · auto-DM ·
salary history · calling Second a Genie.

*End. DIE matching desk. Measure one Lightfield hire first.*
