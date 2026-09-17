# Interlateral teardown: design lessons for Project Room

Deep-research brief. September 17, 2026. Based on the live
interlateral.com site, Dazza Greenwood's public writing, LinkedIn
posts, the Stanford event report, third-party coverage, and the
open-source `interlateral_agents` repo. Research and design learning
only; no code.

Docs / research only. Muse stay-outs held. Does not ship a live kit
door, Connect panel, or People-rail change.

Contracts this fold:

- [ROOM-TRUST-HANDOFF-V0.md](../docs/ROOM-TRUST-HANDOFF-V0.md)
- [ROOM-ARTIFACT-MATURITY.md](../docs/ROOM-ARTIFACT-MATURITY.md)
- [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md) (Interlateral Agent
  Interaction Receipt fields)
- Master plan:
  [ROOM-STEALS-FULL-BUILD-2026-09-17.md](ROOM-STEALS-FULL-BUILD-2026-09-17.md)

## TL;DR: top findings

- **Interlateral is the closest live product to Project Room's thesis,
  but with an inverted wedge.** It is event-bounded and docs-first
  (shared markdown "Jots"); Project Room is persistent and chat-first
  with a work-item ledger. Interlateral proves demand for "people and
  their agents in one shared space" with real users (45 verified
  human+agent pairs at Stanford Law, April 13, 2026). It does not
  compete with the room-as-home idea; it validates it.
- **The trust architecture is the real product.** Every agent is bound
  to a publicly attested human principal ("visible delegated agency").
  Their roadmap items — visible authority cards, Agent Interaction
  Receipts as first-class objects, principal attestation, public
  revocation — read like a spec for Project Room's ledger layer. We
  should treat their event report as a free design document.
- **Their published postmortem is a gift.** They list what failed
  (marketplace underuse, quest-board sprawl, emergent stewardship,
  implicit authority scopes, no export/version history) with planned
  fixes. Each failure maps to a decision Project Room will face; we
  can pre-empt all five.
- **Events are their growth engine; rooms could be ours.** Interlateral
  convenes people around high-stakes, time-boxed events (unconferences,
  hackathons) and exports a "post-event packet." Project Room could
  adopt the packet as a room-export feature and the unconference
  mechanics (topic proposal, voting, breakout Jots) as in-room modules.
- **The site is thin and stale.** One founder, brochure site still
  promoting a June event in September, no pricing page, no self-serve
  signup, invitation-only. The gap between the vision and the shipped
  surface is exactly Project Room's opening.

## 1. What Interlateral is

Tagline: "Bring Your Own Agent." Self-description: "a third space for
people and their AI agents to meet, coordinate, and build together
over the web." Founder Dazza Greenwood (MIT Media Lab
lecturer/researcher on trust frameworks, computational law) has worked
toward it for two years; platform first tested live at Stanford
FutureLaw Week, April 13, 2026.

The positioning sits deliberately between two dominant patterns, and
Dazza says so explicitly:

- **Private copilots** (ChatGPT, Claude): one person, one agent,
  private chat. Isolated.
- **Autonomous multi-agent systems** (CrewAI, AutoGen): agents
  coordinating without humans in the loop.
- **Interlateral's third space**: humans and agents from different
  frameworks, in shared spaces, with full visibility into what every
  agent does. "Delegation with visibility, in a shared room" is the
  framing line an actual participant used and Dazza amplified.

Project Room's thesis is the same third pattern, pursued as a
persistent chat product with a work-item ledger instead of as an event
platform. Interlateral's traction (45 verified pairs producing 8
co-authored papers in 3 hours; 25 topics proposed, 107 votes) is
direct evidence the genre works with real, non-technical
professionals.

## 2. Product surface inventory

What the platform actually shipped, assembled from the event report,
launch post, and repo:

- **Agent registration and badge registry** — participants register
  their agent; verified agents get a "green-mark" badge. The badge is
  a visible trust object inside the room, not metadata.
- **Quest Board** — post, claim, and submit quests (tasks). April 13
  telemetry: 62 quests created, 31 claims, 41 submissions, 28 unique
  submitters.
- **Marketplace** — offers of help/services. 30 offers, 1 claim. It
  failed; see section 5.
- **Unconference module** — participants propose topics (25 proposed),
  vote (107 votes), top topics become breakout workspaces (8 winners).
  This is the first reusable "event type"; hackathons, contract
  negotiations, governance reviews, debates are named as next types.
- **Jots** — shared markdown documents with live multi-agent edit and
  comment threads. The core work surface before May 29. One Jot set
  produced about 98,000 characters of content, 19 comment threads, 27
  thread messages.
- **Websocket agent mesh** (May 29 update) — direct real-time
  agent-to-agent comms across machines and frameworks (Claude Code,
  Codex, OpenClaw). Released as open source, usable off-platform.
  Replaced the polling bottleneck of "agents leave notes in shared
  files."
- **Events container** — hosts spin up shared workspaces in minutes.
  Events are the unit of containment: open (public) or closed
  (sponsor/partner only).
- **Special Interest Groups** — Autonomous Businesses; Legal and
  Regulatory; Finance, Accounting, Audit and Insurance; Agent
  Infrastructure and Protocols. A community layer above events.
- **Post-event packet** (defined for Agent Week) — activity telemetry,
  logs, shared-workspace artifacts, selected exports, plus consent
  language. The auditability deliverable.

Notably absent as shipped surfaces: no chat stream, no persistent
rooms, no mobile anything, no feed/social graph. Conversation lives in
Jot comment threads, which the static export literally strips out.

## 3. Trust, identity, and permission architecture

This is the strongest part of the design and the part Project Room
should study hardest.

### The green-mark ceremony (as run at 45 people)

- Condition of attendance: bring a working agent (Claude Code/Cowork,
  Codex, Gemini CLI, OpenClaw with prior compatibility check). Two
  free pre-event teach-in Zooms plus direct email support got
  non-coders running.
- Verification: the convener called each human's name aloud; the human
  raised a hand, publicly, to attest they were the agent's principal.
  Three stated purposes: authenticate the principal-agent binding,
  block prompt injection and impersonation (no verified human in the
  room, no authorized agent), and make the trust foundation visible to
  everyone instead of hidden in platform metadata.
- Explicitly not scalable past about 50 people. The at-scale answer on
  their roadmap: verified email + agent-token binding, public
  revocation, and a principal-attestation flow.

### Design principles they extracted (sections 4.2–4.4 of the event report)

- **Identity, authority, and capability are three different things.**
  A capable agent is not an authorized one; a badge is not blanket
  authority. Future platform: all three layers visible.
- **Ex ante guardrails beat ex post cleanup.** Pre-flight checks,
  delegation ladders, and review channels over after-the-fact QA.
- **Irreversibility is a first-class risk dimension.** Reversible
  drafting and irreversible actions (file, sign, transmit, trigger
  external systems) belong in different design categories with
  different gates.
- **Prompt injection is a legal-procedural object, not just a
  technical one.** When an ethics-trained agent flagged a suspicious
  prompt mid-event, it posted a public "Spot the Injection" quest on
  the record — authority, consent, notice, evidence handling, in
  public, for the room to evaluate. (The flagged prompt turned out to
  be legitimate; the behavior is the finding.)

### Roadmap trust objects worth stealing

- **Visible authority cards** on agent registration: may vote / may
  write / must ask before public action / must ask before irreversible
  action.
- **Tiered participation** for 100+ person events: curated inner ring
  / vetted contributor / public observer.
- **Prompt-injection flagging, evidence preservation, and operator
  review surfaces** as platform features.
- **Lightweight operator dashboard**: event phase, registry,
  anomalies, stewardship visibility.

## 4. Governance primitives as product objects

The April event converged on a vocabulary Interlateral is now
productizing as open-source specs. All five map directly onto Project
Room's ledger wedge:

- **Agent Interaction Receipt** — a chain-of-custody record: which
  agent supplied what, to whom, with what authority, citing what
  sources, with what reversibility. The strongest cross-cutting
  finding of the whole event: structured records (Receipts, Handoffs,
  Manifests, Audit Logs) are the dominant governance primitive. This
  is independent validation of Project Room's "every delegated task
  comes back with evidence attached." Room fold:
  [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md) fields
  `principalId`, `authorityClaimed`, `sourceManifest[]`,
  `reversibility`, `expiration`.
- **Trust Handoff Protocol** — fields: identity, principal, authority
  scope, task scope, source manifest, confidence, known limitations,
  human approvals, data sensitivity, reversibility, expiration. A
  checklist for any agent-to-agent delegation object. Room fold:
  [ROOM-TRUST-HANDOFF-V0.md](../docs/ROOM-TRUST-HANDOFF-V0.md).
- **Source Manifests** — what an agent relied on, enumerated.
- **Legal Agent Harnesses** — testing environments for agent behavior
  (accuracy, source fidelity, citation quality, authority boundaries,
  refusal behavior, injection resistance, reproducibility).
- **Artifact Maturity Ladder** — five rungs: Live Note, Discussion
  Paper, Synthesis Memo, Workshop Paper, Working Paper, each with an
  explicit editorial standard. Built after they overclaimed ("working
  papers") and had to publicly correct to "Discussion Papers (rung
  2)." The lesson: label artifact maturity visibly so rooms never
  overclaim. Room fold:
  [ROOM-ARTIFACT-MATURITY.md](../docs/ROOM-ARTIFACT-MATURITY.md). Room
  Done outputs default to Live Note / Discussion Paper honesty.

## 5. Their own postmortem: what did not work

Quoted almost directly from section 6 of the event report, with the
fix they plan and the Project Room implication:

- **Marketplace underuse** (30 offers, 1 claim): offers were not tied
  to demand routing. Fix: attach offers to topics and Jot needs. PR
  implication: any task/help marketplace must be demand-routed from
  day one, or skip it.
- **Quest Board sprawl** (62 quests, power-law contribution): fix is
  bias toward "improve an existing quest" over posting new ones, plus
  categories and duplicate detection. PR implication: work-item
  creation needs dedup and "contribute to existing" nudges.
- **Emergent stewardship failed**: nobody owned summaries, sources,
  cross-links in Jots. Fix: assigned stewards (Summary, Source,
  Cross-link, Action, Risk, Synthesis) in every workspace. PR
  implication: assign stewardship roles on work items; do not let them
  emerge.
- **Implicit agent authority scopes**: fix is visible authority cards.
  PR implication: make each agent's grant a visible card in the room,
  not a hidden config. Docs only this PR — not People-rail chrome.
- **No export, no Jot version history**: "the value claim of auditable
  collaboration requires both." Fix: export tooling plus the
  post-event packet. PR implication: room/work-item export and version
  history are not nice-to-haves; they are the auditability claim
  itself.
- **Overclaimed framing** ("working papers"): corrected publicly with
  the maturity ladder as the structural fix. PR implication: maturity
  labels on artifacts prevent credibility damage.

## 6. Onboarding and growth motion

- **Invitation-only, host-approved.** Request an invite via the site;
  attendance at live events is curated. Distribution is entirely
  founder-led: LinkedIn posts (the April 15 post drew 182 reactions),
  a Substack, a YouTube retrospective, and institutional
  collaborations (Stanford CodeX, law.MIT.edu) that lend legitimacy.
- **The teach-in ritual.** Two free pre-event Zoom sessions plus
  direct email support to get each participant's agent installed and
  running. It worked: an AGC at a venture firm who "never coded before
  in my life" left saying "All of a sudden I had an army behind me."
  Lesson: the onboarding rite matters more than onboarding UX polish
  when the ask is "bring your own agent."
- **The event is the demo.** Every event produces artifacts (papers,
  telemetry, videos, a retrospective report) that become the marketing
  for the next one. A flywheel: convene, produce public artifacts,
  publish honestly, attract the next cohort.
- **Narrative worldbuilding as brand.** Dazza published "Three
  Rooms," a piece of near-future fiction (written with Claude Code,
  Codex, and Grok CLI, credited) dramatizing a day lived across work,
  civic, and social rooms with agents. It is the most original
  marketing asset in the genre: it sells the feeling, not the feature
  list.

## 7. Pricing and packaging

No public pricing. The commercial model is three partner tracks, terms
worked out per agreement:

- **Open Event Sponsor** — brand in front of participants; can fund a
  named infrastructure track (e.g. Receipt v0.1 spec, injection-drill
  module, operator dashboard).
- **Private Event Host** — custom private convenings for companies,
  customers, portfolio companies; includes custom event design, agent
  onboarding, and post-event packet generation. Dazza's May 29 post
  calls this "the door I'm most excited about."
- **Core / open-source funding** — fund governance-primitive
  development "that no single company should own and no single event
  should define."

Longer-term roadmap item 14: white-label enterprise platform-as-a-service
for in-house AI governance programs. Open-source tracks subsidized to
zero for research/nonprofit, at-cost otherwise; the commercial side
underwrites the open side. Also noteworthy: explicit disclaimers that
sponsorship is not MIT/Stanford endorsement — careful
institutional-boundary hygiene.

## 8. Copy tone and brand voice

- Plain, first-person, warm, and unusually honest for a launch: "I'm
  not sure yet where this might go, but this is a great time to share
  more." Admits the marketplace failed. Corrects its own overclaim in
  the same document that presents the findings.
- Telemetry is published with the caveat "platform telemetry — not a
  quality measure." Numbers are used to show life, not to claim
  success.
- Taglines are short and invitational: "Bring Your Own Agent." "A
  third space for people and our agents." "The demo is the sixty of
  you."
- Everything is attributed: speakers, support team, participant
  agents ("particularly Joel Kauffman's Judge Joel v2"), and even the
  public critic "whose critique sharpened the language." Generosity as
  a brand asset.

## 9. What is deliberately absent

- **No self-serve signup, no pricing page.** Every door is a
  conversation. Scarcity and curation are the strategy, at the cost of
  top-of-funnel volume.
- **No chat surface.** Jots and comment threads carry all
  communication. There is no persistent conversational layer at all —
  the single biggest structural difference from Project Room.
- **No persistent rooms.** Spaces exist for events; between events the
  platform is a brochure. (The homepage still promotes the June 19–26
  Agent Week as "coming up" in mid-September — either stale or
  genuinely quiet since June.)
- **No agent autonomy without a principal.** BYOA is mandatory; an
  agent without a verified human cannot act. The opposite of
  agent-social-network plays (Moltbook), which Dazza positions
  against: "Most agent platforms are social or financial. Nobody is
  building where agents can do professional work with recognition that
  matters outside the agent bubble."
- **No mobile, no integrations marketplace, no API docs on the site.**
  The only developer artifact is the open-source mesh repo.
- **No team page, no company page.** Single-founder bootstrap; "brand,
  IP, and editorial direction remain with the founder."

## 10. The open-source mesh: interlateral_agents

Dazza's public repo
([github.com/dazzaji/interlateral_agents](https://github.com/dazzaji/interlateral_agents),
Apache-2.0) is the off-platform cousin: a local multi-agent starter
that boots a Claude Code + Codex duo on a shared tmux socket with an
init skill, direct peer messaging with identity stamping, and a
`comms.md` session ledger ("audit ledger, not the wake-up channel").
Design ideas worth noting:

- **Process levels 0–4 as guides, not gates**: solo task, peer
  collaboration, team roles (Lead/Reviewer/Breaker/Verifier), overseen
  sprint, gatekeeper sprint for irreversible work. The risk test for
  escalating: would a wrong action affect production users, mutate
  live data, spend money, expose credentials, or be hard to reverse?
- **The concierge pattern**: one capable agent as "personal project
  concierge… a majordomo," with deliberately light prompting because
  "current frontier agents are already well adapted to this kind of
  judgment-heavy coordination, and too many instructions can make them
  worse."
- **Honest security notice**: the launcher runs agents with permission
  prompts disabled and says so at the top of the README. Trust through
  disclosure.

## 11. Lessons for Project Room

### Steal directly

- **Visible authority cards per agent member.** Render each agent's
  grant (may write / may vote / must ask before public action / must
  ask before irreversible action) as a card on its room profile.
  Interlateral's roadmap confirms the demand; Project Room's
  owner-issued API keys already hold the data. **This PR: contract
  only. Not People-rail HTML.**
- **Receipt field checklist.** Adopt their Receipt/Handoff field list
  (principal, authority scope, task scope, sources, confidence,
  limitations, approvals, sensitivity, reversibility, expiration) as
  the schema for ledger receipts. Folded into
  [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md) and
  [ROOM-TRUST-HANDOFF-V0.md](../docs/ROOM-TRUST-HANDOFF-V0.md).
- **Irreversibility as a ledger column.** Different gate paths for
  reversible vs irreversible actions, visible on the work item.
- **Artifact Maturity Ladder.** Five labeled rungs on room artifacts
  prevent overclaiming and give rooms a "how done is this" language.
  Room Done defaults to Live Note / Discussion Paper.
- **Post-event packet as room export.** Telemetry + logs + artifacts +
  consent language, exportable per room or per work session. This is
  the auditable-collaboration claim made tangible; they explicitly
  flagged missing export/version history as a credibility gap.
- **Assigned stewards.** Summary, Source, Cross-link, Action, Risk,
  Synthesis roles assigned on significant work items rather than left
  to emerge.
- **Public prompt-injection flag surface.** A room-level, on-record
  flag with evidence preservation and operator review — treating
  suspicion as a procedural event the room can evaluate.
- **Unconference mechanics as room modules.** Topic proposal + voting
  + breakout workspaces is a proven 3-hour format that needs only
  their existing surfaces; it would differentiate Project Room's
  launch events or early-adopter hunts.
- **Telemetry honesty.** Publish numbers with the "activity, not
  quality" caveat. Fits how weekly traction updates already land.

### Adapt

- **BYOA as a connector, not the foundation.** Interlateral requires
  bring-your-own-agent; Project Room issues agent membership. A BYOA
  bridge (MCP/CLI surface) would let a user's existing Claude
  Code/Codex join a room directly — Interlateral proves users love
  this ("take your agent with you" is the praised feature).
- **The verification ceremony, scaled.** The hand-raise works to about
  50; their scaled answer (verified email + agent-token binding +
  public revocation) matches Project Room's rotatable/revocable keys.
  Add the public attestation moment as a room ritual when an agent
  first joins: visible, on-record, attributable. **Not this PR.**
- **Teach-in onboarding.** A guided "bring your agent online" rite
  with human help available, aimed at non-technical owners. Their
  evidence: it converted a never-coded lawyer into a power user.
- **Events as the demo flywheel.** Project Room is persistent, but
  time-boxed events inside rooms (a governance jam, a hackathon)
  generate the public artifacts that market the product.

### Avoid / where Project Room is already ahead

- **Don't be docs-first.** Interlateral's comment threads got stripped
  in its own export — conversation is second-class there. Project
  Room's chat-first shape with one-tap message-to-work-item is the
  stronger daily-driver design.
- **Don't ship a marketplace without demand routing.** Their
  30-offers-1-claim failure is the cautionary tale.
- **Don't leave the site stale.** The Interlateral homepage still
  sells a June event in September; a persistent product cannot afford
  a brochure that freezes between events.
- **Don't go invitation-only forever.** Curation builds signal but
  their top of funnel is one person's LinkedIn. Project Room's
  unlisted `/room` door plus a request flow can keep signal high
  without capping growth.

### Relationship note

Dazza is also a live placement candidate (Alpha Compute PM seat;
asked for the brief and a Chris intro after his September 17 call
with Jonathan) and explicitly compared notes on Interlateral and
Project Room on that call. Any public use of this teardown should
assume he will read it: the honest, attributed tone above is
deliberate. Nothing here came from private sources — every claim is
grounded in public pages and posts listed below.

## 12. Sources

- Interlateral homepage — https://interlateral.com/
- Partner page (sponsor/host/funding tracks) — https://interlateral.com/partner.html
- Media and participant reflections — https://interlateral.com/media.html
- Discussion Papers, Stanford April 13 — https://interlateral.com/discussion-papers.html
- Visible Delegated Agency at Stanford FutureLaw 2026 (retrospective
  report, telemetry, postmortem, roadmap, Artifact Maturity Ladder) —
  https://interlateral.com/2026-04-13-event-report.html
- "Bring Your Own Agent" launch post, May 29 2026 —
  https://www.dazzagreenwood.com/p/bring-your-own-agent
- "Three Rooms" (near-future fiction, brand asset) —
  https://www.dazzagreenwood.com/p/three-rooms
- New Claw Times coverage of the websocket mesh —
  https://newclawtimes.com/articles/interlateral-multi-agent-collaboration-platform-stanford-law-websockets/
- LinkedIn: first announcement (Feb 2) —
  https://www.linkedin.com/posts/dazzagreenwood_interlateral-a-third-space-for-people-and-activity-7424210579864608768-XPx2
- LinkedIn: April 15 event recap (182 reactions, "delegation with
  visibility" quote) —
  https://www.linkedin.com/posts/dazzagreenwood_interlateral-the-first-ai-agent-professional-activity-7450327541816680448-2lXV
- LinkedIn: May 29 BYOA invitation post —
  https://www.linkedin.com/posts/dazzagreenwood_bring-your-own-agent-activity-7466063181392580609-wVIO
- LinkedIn: Agent Week post (Jun 22) —
  https://www.linkedin.com/posts/dazzagreenwood_agent-week-2026-interlateral-lawmitedu-activity-7474770533268500480-dg9F
- Moltbook posts by the Interlateral agent account —
  https://moltbook.com/post/3f05a1ad-b8f2-4ad4-801a-772674b08fde and
  https://moltbook.com/post/2b496d16-f104-41b2-89ac-29e11c6da0ca
  (note: comment sections contain spam and one fake "security notice";
  ignored)
- Open-source mesh repo — https://github.com/dazzaji/interlateral_agents
- law.mit.edu event announcement (fetch failed; referenced from the
  Moltbook and LinkedIn posts) —
  https://law.mit.edu/pub/interlateral-event/

## Stay-outs (this fold)

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Phase 0 #8 / #9 · Quill
trees · Compute Start · people-data · Potter keys · live writer.
