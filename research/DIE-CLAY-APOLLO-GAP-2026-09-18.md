# DIE ← Clay + Apollo company-only gap map

**Date:** 2026-09-18 (PT)  
**Scope:** Company firmographics / technographics / hiring signals only.  
**Hard red line:** NO PEOPLE-DATA. Apollo people search, email finders, mobile numbers, LinkedIn `/in` scrapes, ContactOut, PDL, ZoomInfo people — all FORBIDDEN. Steal Clay/Apollo **company** enrichment patterns only.

**Honesty score (Clay company tables today):** **28/100**  
DIE has a real per-field waterfall with cite provenance (`die-slice4`) and a thin packet fetch harness, but lacks Clay-style multi-provider firmographic columns (industry, headcount range, funding, tech stack), scheduled enrich across the watchlist, and a filled operational research catalog (`DEMIGOD-COMPANY-RESEARCH.json` → `companies: []` on this box).

---

## 1. Steal table — Clay feature → DIE today → gap → Now/Next

| Clay company feature (cite) | DIE equivalent today | Gap | Now (1–2 wk) / Next |
|---|---|---|---|
| Company table keyed by **domain** + Enrich Company waterfall (employee_count, annual_revenue, industry, locations, funding, business_stage) — [Clay University: Enrich Companies (Waterfalls)](https://university.clay.com/lessons/enrich-companies-waterfalls-clay-101), [Clay waterfall enrichment guide](https://clay.com/guides/waterfall-enrichment), [marketplace Enrich Company](https://marketplace.clay.com/skills/enrich-company) | `watchlist.json` domain rows; `die-slice4/demigod-company-waterfall.mjs` fields: `website`, `description`, `stage`, `teamSize`, `inceptionYear`, `jobsUrl`, `atsSource`, `openRoles` (+ `openRolesAt`) | No structured firmographics table (industry / headcount_range / funding_stage / HQ / tech_stack) written into packet or SoR research catalog | **Now:** extend waterfall schema + packet.md firmographics section; bridge via `die-waterfall-bridge.mjs`. **Next:** optional Monid/YC + public registry fill |
| Multi-provider waterfall: stop at first hit; test 10 rows; reorder by cost/coverage — [Clay University](https://university.clay.com/lessons/enriching-company-data) | `SOURCE_ORDER = first_party → yc → wikidata → ats_json`; empty never overwrites verified; every fill has `source` + `url` + `retrievedAt` | Only 4 public sources; no IntelliSense/PitchBook/DealRoom-class providers; no credit accounting | **Now:** keep public order; add column-shaped `firmographics.json` per slug. **Next:** plug OpenCorporates / SEC / more ATS hosts as optional providers |
| Careers / job openings as company signal | `jobsUrl`, `atsSource`, `openRoles`; Greenhouse/Lever/Ashby/Workable host allowlist in slice4; local `fetch-company-packet-waterfall.mjs` pulls home/careers/blog/about | Careers URL often watchlist-manual; no scheduled refresh of openRoles into firmographics table | **Now:** cite ATS JSON in packet.md; scheduled enrich over watchlist. **Next:** Greenhouse Job Board API board_token discovery ([docs](https://docs.greenhouse.io/job-board.html)) |
| Tech stack / technographics | Partial via first-party HTML / observe heuristics only | No `technology_names`-style column | **Next:** public BuiltWith-less fingerprint (script hosts / DNS) — never people |
| HTTP API / recipes as columns | CLI scripts + Monid MCP (operator-run); no Clay HTTP recipe surface | No UI table; MCP not callable from Node on box | **Now:** document operator steps in `docs/CLAY-COMPANY-WATERFALL.md`. **Next:** fixture ingest from Monid GTM JSON |
| Conditional “run if” / ICP gate before expensive enrich | Kill-switches + people-broker refuse; no ICP column gate | No employee/industry gate before enrich | **Now:** gate on `domain` present + not people-broker. **Next:** ICP filter columns after firmographics exist |
| **Clay email / phone / people find waterfalls** | Explicit `FORBIDDEN_FIELDS` in slice4; `PEOPLE_BROKER` refuse in packet waterfall | N/A — **DENY forever** | Do not build. Document in Apollo NEVER list below |

---

## 2. Apollo allow vs deny matrix

Primary docs: [Organization Search](https://docs.apollo.io/reference/organization-search), [Organization Enrichment](https://docs.apollo.io/reference/organization-enrichment), [People API Search](https://docs.apollo.io/reference/people-api-search), [People Enrichment](https://docs.apollo.io/reference/people-enrichment), [Apollo docs index](https://docs.apollo.io/llms.txt).

### ALLOW (company / organization surfaces — mirror **shape** only; do not wire live Apollo without explicit Potter gate)

| Surface | Endpoint / product | Company fields DIE may mirror (public/OSS substitutes preferred) |
|---|---|---|
| **Organization Search** | `POST /api/v1/mixed_companies/search` | Domain list, employee ranges, HQ locations, revenue range, technologies, keyword tags, funding amount/date, job posting title/count/date, headcount growth windows |
| Organization Enrichment (shape only) | `GET /api/v1/organizations/enrich?domain=` | industry, estimated_num_employees, funding_events / latest_funding_stage, technology_names, HQ address, founded_year, short_description — **strip** phones and any people IDs |
| Bulk org enrichment / get org / org job postings / news | Company DB siblings | Firmographic + hiring signals only |

**DIE policy today:** treat Apollo **Organization Search field vocabulary** as the ICP schema to steal. Prefer Monid tinyfish/YC + first-party + ATS + Wikidata over calling Apollo APIs from this slice. Packet waterfall already **refuses** `apollo.io` host URLs as people-broker pattern.

### DENY (people database — NEVER mirror, NEVER “finish” with these)

| Forbidden Apollo / broker surface | Why |
|---|---|
| People API Search (`/mixed_people/api_search`) | Net-new people prospecting |
| People Enrichment / Bulk People Enrichment | Emails, phones, person identity |
| Get Complete Person Info | Person record |
| Retrieve mobile phone numbers | People phones |
| Email/phone waterfall enrichment | Contact enrichment |
| Convert people → contacts; sequences; LinkedIn `/in` retrieve | Outbound people stack |
| ContactOut, PDL, ZoomInfo people, Hunter people, Lusha, RocketReach | People brokers |
| Clay “Find email” / “Enrich Person” / owner-name → email waterfalls | People |
| Monid `search_founders` / `get_person_detail` / ContactOut / PDL people endpoints | Explicit stay-out |
| LinkedIn `/in` or `/pub` scrapes; Wellfound people | People |

**Do not “finish” the firmographics gap by scraping people.** Empty cells stay `unknown` with a reason code.

---

## 3. Open-source / public company enrichment alternatives (company-only)

| Source | Use for DIE | Cite |
|---|---|---|
| First-party site + careers | Domain resolve, description, jobsUrl | Already `SOURCE_ORDER[0]` |
| YC directory / Monid `ycombinator` `/search_companies` (`is_hiring`) | stage, teamSize, one-liner — **never** `/search_founders` | [MONID-WATERFALL.md](die-packet-brief-status/docs/MONID-WATERFALL.md) |
| Wikidata SPARQL | inceptionYear, aliases | Already in slice4 |
| Greenhouse / Lever / Ashby / Workable public JSON | openRoles, atsSource | [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) |
| OpenCorporates company endpoint | Registry name, jurisdiction, incorporation_date, status — **do not ingest officer PII into packets** | [Fetching a company](https://knowledge.opencorporates.com/knowledge-base/fetching-a-company/) |
| Monid `tinyfish` `/search` + `/fetch` ($0) | Public page markdown cites → packet.md | MONID-WATERFALL |
| SEC EDGAR / CompanyLens-style multi-source (optional later) | Firmographics without people email | Public filings only |

---

## 4. Local gold (do not reinvent)

| Artifact | Role |
|---|---|
| `/workspace/die-slice4/demigod-company-waterfall.mjs` | Clay-useful slice 4: `SOURCE_ORDER`, `WATERFALL_FIELDS`, `FORBIDDEN_FIELDS` |
| `/workspace/phase0-publish/die-packet-brief-status/scripts/die-waterfall-bridge.mjs` | Prefer slice4 over thin E2E fetch |
| `/workspace/phase0-publish/die-packet-brief-status/scripts/fetch-company-packet-waterfall.mjs` | Watchlist → home/careers/blog/about → packet.md + citations; people-broker refuse |
| `/workspace/demigod-ops/DEMIGOD-COMPANY-RESEARCH.json` | Operational catalog — **`companies: []` empty hole** on this box |
| Spec | `DEMIGOD-DIE-SPEC.md` — DIE ≠ Clay clone; company research with evidence |

---

## 5. Concrete Now slice (1–2 weeks)

Point of leverage: **extend packet waterfall columns + bridge die-slice4 + cite sources in packet.md**. Operator doc: `die-packet-brief-status/docs/CLAY-COMPANY-WATERFALL.md`.

### Now build list (actionable for next executor)

1. **Schema `firmographics.v1`** under `die-packet-brief-status/schemas/firmographics.schema.json`  
   Fields (company-only): `domain`, `industry`, `headcountRange` \| `teamSize`, `fundingStage` \| `stage`, `hqLocation`, `techStack[]`, `careersUrl` \| `jobsUrl`, `openRoles`, `inceptionYear`, `description`, per-field `{value, source, url, retrievedAt, confidence}`.  
   Forbid: email, phone, mobile, linkedin `/in`, persona, firstName, lastName, workEmail.

2. **Extend `WATERFALL_FIELDS` (or parallel firmographics map)** in slice4 / bridge to emit `companies/<slug>/firmographics.json` without writing people.

3. **Packet.md section** `## Firmographics` rendered from firmographics.json with citation list (reuse packet-meta citations pattern).

4. **Wire `die-waterfall-bridge.mjs`** to `--slug` apply path (today: `--check` / `--selftest` only) → dry-run then write firmographics + patch packet.

5. **Scheduled enrich:** weekday watchlist loop already exists for observe — add `fetch-company-packet-waterfall.mjs --slug` + bridge for active matching slugs (Lightfield first). No Apollo people; Monid YC/tinyfish company-only per MONID-WATERFALL.

6. **Fill research hole:** when firmographics confident, append row to local research export candidate (do not invent into empty SoR without review) — keep `DEMIGOD-COMPANY-RESEARCH.json` human-gated.

7. **Assert:** extend `assert-no-people-domains.mjs` / `assert-gtm-company-only.mjs` to refuse firmographics files containing forbidden keys.

### Out of Now

- Live Apollo Organization Enrichment API calls (shape only until Potter opens a key + spend gate).  
- Any people enrichment.  
- Claiming Clay parity.  
- Wrangler Access / live email.

---

## 6. Honesty score breakdown (28/100)

| Dimension | Score | Note |
|---|---|---|
| Domain-keyed company rows | 7/15 | watchlist + packets exist |
| Per-field waterfall + stop-on-hit | 8/15 | slice4 gold; thin E2E is page-fetch only |
| Firmographic column breadth (industry/funding/tech/HQ) | 2/20 | stage/teamSize only |
| Multi-provider coverage | 3/15 | 4 public sources vs Clay hundreds |
| Cite / evidence drawer | 5/15 | URL + retrievedAt; not full Clay cell drawer |
| Scheduled enrich | 2/10 | observe cron-shaped; packet waterfall not cron-proven |
| SoR research catalog filled | 1/10 | `companies: []` |

**Not Clay-parity.** Goal of Now: move toward ~40–45/100 on company tables without crossing people red line.

---

## 7. Top 5 Now steals

1. **Clay Enrich Company column set** (industry, headcount, funding/stage, locations) keyed by domain — schema + packet section.  
2. **Waterfall stop-on-first-confident** already in slice4 — bridge it into every watchlist slug’s firmographics.json.  
3. **Apollo Organization Search filter vocabulary** as ICP schema (employee ranges, tech UIDs, funding, job counts) — implement via public/Monid sources, not people APIs.  
4. **Greenhouse/ATS JSON openRoles + jobsUrl** as careers enrichment (already partial).  
5. **Cite-every-fill** pattern (source URL + retrievedAt) into packet.md Firmographics — Clay-useful evidence without Clay credits.

---

## Stay-outs (repeat for every executor)

No people enrichment calls · no Monid `search_founders` / `get_person_detail` · no live email · no wrangler Access · no inventing Clay pricing · no Apollo People * · empty research cells stay unknown.
