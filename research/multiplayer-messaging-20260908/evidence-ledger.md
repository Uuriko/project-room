# Evidence ledger

Access date throughout: 2026-09-08. Exact titles, authors, dates and direct URLs reside under the matching source IDs in canonical report-source.md. No private messages accessed. Product and academic lanes independently researched by multiplayer_research and academic_research; parent reviewed consequential provider and architecture sources. Confidence refers to supported claim, not production reliability.

| Claim family and IDs | Evidence and type | Confidence | Contradictions or limits |
| --- | --- | --- | --- |
| Personal broad messaging B1 B2 B3 | Beeper official Desktop API, auth, MCP, send reference | High for documented APIs | Personal-use recommendation, running desktop, incomplete history, macOS iMessage; commercial integration and version tests unresolved |
| Front channel architecture F1 F2 F4 | Current provider docs and user help | High for docs | Legacy Custom Channels not recommended; delegated inbox access not sender impersonation; presence is not locking |
| Missive F3 | Product features, collaboration/task sections | Medium | Vendor feature claims, no hands-on or outcome validation |
| Chatwoot F5 F6 | Official channel/inbox guide and API/bot docs | High for contract | Customer-support model, not arbitrary personal inbox access |
| Gmail C1 C2 C3 | Official scope, push, sync documentation July2026 | High | Restricted-data requirements, lost pushes, expired history; no account provisioning or test |
| Microsoft C4 C5 C6 | Graph send, webhook and delta docs | High | 202 accepted not completed delivery; subscriptions expire |
| WhatsApp C7 C8 C15 | Official current policy and legal terms | High for text, conditional for application | AI-primary restriction and EEA/Brazil exceptions; Sept23 future changes; provider/legal classification unresolved |
| Telegram C9 C10 | Official FAQ and connected-business-bot specification | High | Bot FAQ has older wording; connected bot docs show non-Premium and one-bot limit; no general full-inbox assumption |
| Signal C11 C12 | Official linked-device support and third-party CLI's own README | High for status | Unofficial CLI, no verified public general-purpose inbox API; absence claim scoped to review |
| SMS C13 C14 | Twilio official delivery/opt-out documentation | High | No personal phone-inbox coverage; opt-out behavior does not itself establish legal compliance |
| Downstream data policy C16 | Google official developer policy and AI clarification | High | Implementation configuration and subprocessors must be reviewed |
| QM P1 P2 | README plus security policy | High for documented design | Experimental internal organization, not hardened public tenancy |
| Delta P3 P4 | Founder engineering announcements | High for announcement | Private beta; full-transcript preference conflicts with quiet UI |
| Amp P5 P6 | Current operation manuals | High | Mentions expand multiplayer, broad workspace secret access; reject those rules for private-inbox system |
| Slack P7 | Official help and launch article | High for help | Gradual availability; provider claims differ between pages |
| Kandev P8 P9 P10 | Coordination, communication, security and feature-status docs | High for docs | UUID-based wording incomplete relative to scope docs; team security experimental; release may lag main |
| Patchwork P11 | README and implementation plan | High for stated intent | Explicit not-recommended experiment, thin trusted-member permissions |
| Collivo P12 | Product and governance pages | Medium | Beta, simplified illustrations, no independent performance evidence |
| Agentic Workspace P13 | Draft spec and RFC | High for draft | Unsigned-token demo not production; no standard adoption evidence |
| AI Sidekicks P14 | README and implementation status | High for status | Many plans not implemented; distinguish session rollback from filesystem restore |
| Engineering E1 E2 E3 | Primary expert essays | Medium | E2 vendor engineering; E3 exploratory and lacks cost accounting |
| Awareness A1 | Full author-hosted 2002 CSCW paper | High | Descriptive, primarily groups2–5; not causal gain evidence |
| Grounding A2 | Full author-hosted1991 chapter | High | Conceptual/historical, not modern implementation test |
| Mixed initiative A3 | Full CHI1999 paper | High | Design/prototype; not LLM confidence validation |
| HAI guidelines A4 | Publication record and full paper via Stanford course copy | High | Applicability/clarity evaluation, not retention uplift |
| Synergy A5 | Full Nature open-access paper in academic lane, PDF/search corroboration parent | High | Humans+AI not superior to stronger constituent; creation estimate not significant |
| Interruptions A6 | Full CHI2007 field paper | High | Observational, desktop-era, association not causation |
| Contextual integrity A7 | Publisher abstract and bibliographic record | Medium | Full PDF403/unavailable; no claim full-text reviewed |
| MAST A8 | NeurIPS record and full arXivv3 | High | Initial150 vs expanded1642; latter not all human annotated; no universal taxonomy |
| Scaling A9 | Full preprintv2 and authors repo | Medium | Under review not Nature-published; benchmark-specific architecture effects |
| Current state L1 L2 | Local handoff and relevant source reads | High for recorded checkpoint | Prior tests not rerun; no current live verification; schema14 fallback still pending |

Novel recommendations are labeled as proposed design. No product growth or retention estimates used. Optional fresh harness preprint2609.00006 was reviewed in academic lane but excluded from the core report because its descriptive methodology and proprietary-source provenance did not strengthen the decision beyond the selected primary engineering evidence.

## Source review extension

All pinned URLs and file paths are retained in canonical report-source.md K1–K15. No external repository code or tests executed.

| Evidence | Source type | Confidence | Boundaries |
| --- | --- | --- | --- |
| QM K1–K3 | Pinned source plus representative tests | High for inspected contracts | Memory run-store tests not proof of Postgres; mocked Slack recovery not universal exactly-once |
| Agentic Workspace K4 | Pinned reference implementation | High for demo status | Inject unsupported, demo auth, transcript persistence not durable execution queue |
| Chatwoot K5–K9 | Pinned ingress, models, listeners, composer, tests | High for inspected paths | Private notes may reach integrations by design; no live sends or concurrent tests run |
| Beeper K10–K12 | Pinned generated SDK/MCP and message tests | High for client code | Pending ID not delivery; retry safety unqualified; client tests not actual network behavior |
| Mautrix Go K13 | Pinned portal and message model | High for inspected paths | Some echo correlation in memory; no crash-proof outbox inference; limited relevant test evidence |
| Mautrix WhatsApp K14 | Pinned adapter send/receive/receipt/capability paths | High for inspected paths | Unofficial bridge not default business API; no Go test files found in snapshot, no full validation claim |
| Licenses K15 | Pinned license texts | High for identifiers | MIT exclusions, MPL and AGPL differ; actual copying/distribution requires review, not legal clearance |

QA checkpoint: 23-page final DOCX, 9,440 source words including bibliography, 113 hyperlinks, four tables with repeat headers; all rendered pages inspected, final changed pages reinspected. Missing citation IDs: none. No live or source-runtime changes. Deep Research skill supplied the evidence/limitation structure and independent research lanes.
