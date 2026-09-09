# Superhuman and collaborative inboxes: lessons for Project Room

September 8, 2026. Research and product recommendations, not implementation or a live-provider qualification.

## Conclusion

Borrow Superhuman's interaction speed, Missive's collaboration model, Shortwave's contextual assistance, and HEY's willingness to meet users in their own agents. Do not combine their feature lists into a larger email client.

Project Room's proposed distinction is continuity: a private message can become explicitly shared work, people and agents can help, and a reviewed result returns to the original context. Someone should benefit from the product before connecting an agent, creating a formal task, or buying automation.

This is a positioning hypothesis, not proof of uniqueness or demand. Competitors already combine email, collaboration, and AI. Merely offering MCP or an AI sidebar is not a defensible difference.

## Evidence and limits

Reviewed public first-party product pages, design essays and help documentation for seven products. Inspected Superhuman Mail's public page in the browser; did not enter an authenticated inbox, sign up, connect an account, send a message, or measure actual application performance. No new screenshots were captured in this research pass. The linked documentation is the evidence trail.

The service-discovery skill prescribed a directory search. Exact attempted query: `collaborative email`, no filters. The Stripe directory command was unavailable, so it produced no results; discovery continued through public web search. Search themes included collaborative email, shared inbox ownership, command palettes, collaborative drafts, MCP, bring-your-own agents, and product lifecycle changes. No price comparison or purchasing recommendation was attempted.

Vendor claims establish documented behavior or intended functionality, not independent reliability, savings or retention evidence. Recommendations below are our interpretation. Historical design essays are marked as such. Runtime remains unchanged at checkpoint `69bef95`, with previously tested implementation `fcc52b6`; this research does not add a live mailbox connection.

## 1. Superhuman Mail: fast decisions, not just fewer pixels

Mail advertises Split Inbox, reminders, snippets, keyboard shortcuts, shared conversations, internal comments and reply-collision indicators. The useful pattern is a short decision loop around a message, with deeper tools available when needed. Its productivity savings are marketing claims, not measurements made here. [Product page](https://superhuman.com/mail).

Its 2021 command-palette essay recommends one consistent entry point, shortcut discovery, forgiving search and aliases, and separating command execution from presentation. It explicitly retains ordinary buttons and menus. This is not an argument for hiding every control. [Design essay](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/).

Shared conversations provide history and subsequent updates. Browser guests can view and comment without becoming full Mail users, but cannot reply externally or forward from that guest view. Internal collaborators and external email recipients are different audiences. [Sharing documentation](https://help.superhuman.com/hc/en-us/articles/46005593675917-Shared-Conversations-and-Team-Comments).

Superhuman also offers a Mail MCP server for external assistants: search, drafts, sending and calendar work. Its product FAQ says sending requires approval by default. This documents the offered behavior; we have not tested enforcement across clients. [Mail MCP](https://superhuman.com/mail/features/email-mcp).

The detailed guide lists Business-plan-or-higher access, setup prerequisites, client-specific instructions and reusable skills. MCP-created drafts appear in Mail, while draft synchronization with other email clients is explicitly limited. Connection success and cross-client continuity are separate qualification questions. [MCP guide](https://help.superhuman.com/hc/en-us/articles/46005696690317-Superhuman-Mail-MCP-Server).

**Our design implication:** make reading, deciding and returning feel effortless. Use a shared action contract beneath visible controls, shortcuts and agent tools, with the same authorization rules. Keep source, audience and next action legible. Do not reproduce its whole suite or treat an empty inbox as the purpose of a collaborative room.

## 2. Missive: the clearest model for collaboration state

Missive distinguishes shared team-queue handling from personal inbox handling. Assignment or closing can remove a conversation from the team queue; personal inbox read/archive state is independent. Active members and observers can receive different notifications without losing access. [Account-sharing options](https://missiveapp.com/docs/core-features/connected-accounts/sharing-options).

Its collaborative drafts support simultaneous editing and review across channels. Crucially, those drafts do not synchronize with ordinary Gmail or Outlook drafts. This is an explicit interoperability tradeoff, not a minor implementation detail. [Draft documentation](https://missiveapp.com/docs/core-features/conversations/drafts).

**Our design implication:** model access, attention and responsibility separately. A room member may be allowed to inspect work without being responsible for it or notified about every edit. A personal archive action must not silently complete shared work. For agent drafting, named alternatives and explicit adoption should precede unrestricted simultaneous rewriting of the same text.

## 3. Shortwave: collaboration and tools close to the message

Shortwave documents comments, assignments, shared threads and typing indicators. Mentioning a collaborator shares the complete thread, including history and future messages; that is materially broader than quoting a selected passage. [Team guide](https://www.shortwave.com/docs/guides/team/).

Its assistant can connect to local and remote MCP servers; local servers require its desktop app. This is the product acting as an MCP client, bringing outside tools into the inbox assistant. It is a different direction from offering mailbox tools to outside agents. [MCP guide](https://www.shortwave.com/docs/how-tos/using-mcp/).

**Our design implication:** support both integration directions eventually, but disclose them separately. “Bring your agent” grants an outside agent specific room capabilities. “Connect a tool” lets an authorized room agent use an external service. Neither should imply the other, nor give every participant access to every connected account.

## 4. Front: durable responsibility and structured handoffs

Front documents real-time collision indicators and visibility into a teammate's draft while replying. That is useful human coordination evidence, not a guarantee of exclusive execution by independent agents. [Collision detection](https://help.front.com/en/articles/2403).

Its current Autopilot documentation describes structured playbooks, connected-system actions, approvals and handoffs across supported channels. It distinguishes autonomous workflows from Copilot assistance and says Autopilot applies to shared, not individual, inboxes. [Autopilot guide](https://help.front.com/en/articles/4890624).

**Our design implication:** reuse one underlying work lifecycle for “help me now” and “repeat this bounded workflow.” Do not make playbooks or an operations dashboard prerequisites for ordinary messaging. Agent writes need real ownership and revision checks, not merely avatars that appear to be typing.

## 5. HEY: attention categories and a bring-your-own-agent route

HEY separates important conversations, newsletters and transactional records, and provides an explicit Reply Later queue. It is a distinct email service, not simply a skin over an existing Gmail account. [How it works](https://www.hey.com/how-it-works/).

Its August 31, 2026 agent guide describes a CLI, browser sign-in, setup discovery, diagnostics and an MCP mode. It says an agent normally receives the user's broad read/write access, with a read-only MCP option and logout for revocation. [Agent guide](https://help.hey.com/article/1189-using-ai-agents-with-hey).

**Our design implication:** make connection setup understandable and diagnosable, and support an agent the user already trusts. For Project Room, prefer room- or task-scoped grants over account-wide impersonation. A connected agent should have a visible identity, purpose and access boundary. Its owner should see what succeeded, what is waiting, and how to disconnect it.

## 6. Spark: restrained defaults with optional depth

Spark offers priority grouping, sender filtering, reminders, a command center, shared drafts and team comments. Its feature set illustrates that personal focus and team collaboration can coexist without making every message a formal ticket. [Feature reference](https://sparkmailapp.com/features).

**Our design implication:** begin with a useful default arrangement. Add filters and saved views when repeated use justifies them. Avoid a first-run questionnaire about an elaborate taxonomy. Keep the sender and channel obvious even when the surrounding interface is minimal.

## 7. Notion Mail: a current portability lesson, not a proven failure diagnosis

Notion's official notice says its Mail inbox shuts down September 22, 2026. Existing Gmail mail remains, and Gmail-related agent tools continue; some app-specific drafts, schedules and settings require export or migration. Certain views and reminders do not transfer. [Official transition notice](https://www.notion.com/en-gb/help/notion-mail-inbox-is-going-away-what-to-do-next).

The notice does not establish why the business made this decision, nor show that customizable inboxes are inherently unsuccessful.

**Our design implication:** separate provider facts, local drafts, shared work and UI preferences. Make meaningful user-created work portable. A disconnected provider or replaced interface must not strand unsent drafts, accepted results or the reasoning behind a decision. This supports our existing durable-draft approach; it does not justify abandoning the unified Inbox.

## Synthesis: resolve the design tensions

### A. What should the product organize around?

Not email alone, and not autonomous agents alone. Organize around a conversation and its optional work. Inbox is where personal attention lands; Rooms are where people and agents collaborate. The same source can be linked to shared work without turning private data into room data.

### B. How do we provide more capability without more noise?

Put routine actions beside the relevant object. Use selection to reveal “Ask room,” the composer to reveal drafting help, and a contextual menu or palette for uncommon actions. Prefer expanding capability through existing surfaces over adding navigation destinations.

Minimal copy is not zero information. Sender, destination, state and consequence should remain explicit where mistakes matter. Remove explanatory paragraphs, repeated headings, empty panels and promotional AI nudges before removing those facts.

### C. Should internal comments and external replies share a composer?

They may share components, but the audience must remain unmistakable. A mode switch must not invisibly change where already-written text will go. Keep private drafts, room comments and external replies as distinct intents; changing mode should preserve text without authorizing its publication.

For room chat, Enter sends and Shift+Enter adds a line, with composition-aware keyboard handling. For long-form external email, keep ordinary newline behavior and an explicit send shortcut/action. One consistent visual system need not force identical gestures onto different communication conventions.

### D. What should sharing mean by default?

Selected content, an explicit audience, and a receipt of exactly what was shared. A live conversation grant can be an advanced option with a clear future-message scope and revocation. Do not make an innocent mention export the original source's whole history by default.

Revocation prevents future access; it cannot promise to erase information a recipient already read or copied. The product should be honest about this distinction.

### E. How should agents collaborate on a reply?

A bounded request should name its source revision, permitted context, requested deliverable, owner and expiry. Let agents return attributed alternatives or proposed edits. A reviewer adopts one exact version. Approval to use a result is separate from approval to send externally.

Concurrent thinking is desirable; concurrent irreversible execution needs coordination. Use existing claims, revisions and replay-safe operations. A presence indicator communicates activity but must never be the lock. Do not multiply agents merely to generate more text.

### F. How can we feel faster while staying truthful?

Immediately acknowledge local navigation and typing; preserve the draft and selected row. Do not label a network operation successful before its outcome is known. “Saved locally,” queued work and confirmed external delivery are distinct facts even when routine success indicators remain quiet.

No latency measurement was taken in competitor apps. Our performance targets should be established and verified on our own ordinary journeys, not copied from marketing.

### G. What makes users return?

Our hypothesis: dependable relief. The product remembers what is waiting, returns useful results, and makes the next action obvious. Prefer a requested reminder or completed-result notification over streaks, manufactured urgency or a stream of agent progress chatter.

Free use should include a genuinely useful communication and collaboration core. Optional managed agent execution can have clear limits and paid expansion. Bringing one's own agent should not require buying our compute merely to participate. This is a proposed product policy, not a financial viability finding.

### H. What would make agents prefer this environment?

Clear tasks, compact relevant context, stable identifiers, discoverable capabilities, reliable state transitions and unambiguous completion evidence. Provide a short connection diagnostic and a first successful read/proposal journey before presenting every tool. Avoid requiring an agent to infer ownership or completion by rereading a chat transcript.

Treat connection instructions and skills as useful onboarding, not authorization. Grants come from the account/room authority; an imported prompt cannot expand them. External content remains task data even when it contains imperative language.

## Proposed sequence for Project Room

This refines, rather than replaces, [the current email qualification plan](EMAIL-QUALIFICATION-NEXT.md). No step below is newly implemented by this research.

1. **Finish the existing Inbox journey.** Show fixture-imported plain-text mail with truthful channel/account identity, private draft continuity, compact recipient details and honest attachment availability. Do not add a separate Mail destination. Qualify exact excerpt sharing and the return of a reviewed room result. Keep real sending unavailable until separately qualified.
2. **Make the common loop fast.** Preserve navigation and selection, reduce repetitive labels, and make keyboard and mobile behavior coherent. Check interrupted edits, reloads and return-from-room flow before introducing more features.
3. **Separate my attention from shared work.** Reuse existing reminder/work primitives where possible. Add personal Later or waiting views only when the underlying state is sound. Archiving for one person cannot clear another person's responsibility.
4. **Unify action entry points.** Audit existing controls first, then introduce or consolidate a contextual command registry and palette. Buttons and agent tools should invoke the same domain operations, not parallel implementations with different checks.
5. **Improve agent arrival.** One scoped connection flow, readable permissions, a diagnostic check and a small useful first task. Support review-only participation before unattended execution. Test supported hosts rather than claiming compatibility from protocol names.
6. **Offer collaboration depth contextually.** Introduce explicit shared-draft alternatives, opt-in live conversation grants and bounded repeatable workflows only where they improve observed journeys. Reuse room review, ownership and evidence, rather than creating separate “AI workflow” machinery.
7. **Qualify provider connections and portability.** A dedicated authorized mailbox, provider-specific sync/send behavior, clear disconnect handling and exportable local work are separate release gates. Browser fixtures and local tests do not prove a real deployment works.

## What to test next

These are acceptance scenarios, not completed tests or claims of human research:

- A first-time person reads and drafts a reply without learning Rooms, tasks or agents.
- Someone selects a passage, asks an existing room for help, and returns without losing their draft or location.
- A collaborator sees only the shared excerpt, not private recipients or future source updates.
- Two agents return separate usable contributions without overwriting the human's draft or one another's ownership.
- A user's archive action leaves other participants' assignments and attention intact.
- Account switching or an unavailable connection cannot relabel a draft as belonging to another sender.
- A narrow mobile screen keeps the audience and main action clear without instructional paragraphs.
- An ordinary task remains useful after the managed-AI allowance runs out.
- Reopening the app shows genuinely actionable changes, not every background event.
- Disconnecting a provider preserves recoverable local work and truthfully explains which capabilities stopped.

Compare journeys against our baseline for navigation effort, interruptions and errors. Record simulated human walkthroughs separately from actual agent execution. Later human sessions are needed to validate ease, trust and demand; neither a polished screenshot nor a passing agent test proves them.

## What not to build from this research

Do not add seven competing inbox modes, an always-open AI sidebar, compulsory workflow setup, or a new feature for every competitor checkbox. Do not promise full synchronization of collaborative drafts merely because received mail synchronizes. Do not call a generic MCP connection unique, conflate read access with sending authority, or advertise autonomous work before its permissions and recovery are qualified.

The ambition is substantial capability with a short everyday loop: read, respond, involve help when useful, and continue.
