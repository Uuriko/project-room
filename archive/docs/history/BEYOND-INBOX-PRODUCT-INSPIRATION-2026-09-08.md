# Project Room beyond the inbox

## Direction

The most useful lesson from Superhuman is not that Project Room should look like an email client. It is that a powerful product can make people feel fluent: ordinary actions are fast, progress is understandable, and depth becomes discoverable as it becomes useful. Project Room can apply that idea to conversation, creative work, shared knowledge, agent participation and community—not only messaging.

The strongest proposed identity is **a shared studio that remembers its work**. People arrive to something understandable, bring tools or agents they already use, make things together, and leave behind useful results rather than a longer transcript. Conversation alone remains a legitimate reason to be there.

This is a product-inspiration and design document, not a release announcement. It extends the existing inspiration atlas and unified blueprint. New angles in this pass include Raycast's contextual action system, Tana's gradual structure, Slite's maintained knowledge, Cosmos's contextual discovery, Figma's alternatives, Zed's follow mode, Hex's interactive results, Basecamp's uncertainty framing, Partiful's invitations, Peerlist's work profiles, Polis's collective sense-making, and PlayCanvas's shared preview. Some earlier sources are revisited for a different mechanism rather than counted as new discoveries.

Evidence comes from first-party product pages, documentation and founder essays accessed September 8, 2026, Pacific time. Historical essays are design precedents, not descriptions of current plans or proven causal explanations for business success. No authenticated competitor testing, new codebase audit, live integration or customer-retention study was performed. The Stripe Directory discovery query `collaborative workspace`, without filters, could not run because its command was unavailable; no Directory results were used. Public web sources provided the research.

## 1. Make becoming fluent enjoyable

### Current Superhuman: help in context and documents that do things

Superhuman's current Go page describes assistance appearing inline, beside selected content and through configured routines, with specialized agents and connected sources. These are advertised capabilities, not behaviors independently tested here. [22]

**Adaptation:** the room helper should appear beside the thing someone is doing: a source check beside a claim, a comparison action beside alternatives, or a missing-input question beside work. Its visibility and remit should be controllable. A separate chatbot window need not be the primary interface for every kind of help.

Superhuman Docs currently presents text, tables, formulas and buttons as building blocks for interactive team solutions. [23]

**Adaptation:** a room brief can include a useful checklist or controlled calculator; a result can become a reusable tool. Do not reproduce a full document/database builder immediately. Begin with a small set of supported artifacts and actions. The competitive lesson is also important: “humans and AI collaborate” is already a crowded claim. Project Room needs to demonstrate easier multi-party continuity, interchangeable contribution routes and useful persistent outcomes, not just state that it has agents.

### Superhuman: mastery, not a layer of points

Superhuman's founder describes clear goals, responsive controls, playful small interactions and obvious next actions as parts of its design approach. The 2021 essay distinguishes these from simply adding badges and points. Its broader statements about motivation should not be treated as universal scientific findings. [1]

**Adaptation:** make the first room interaction a real small success: share an example, get a useful response, or review one result. Offer an optional guided first action rather than a tour of every capability. Teach a shortcut beside the action someone just used. Make completing a review feel clean and conclusive, without confetti after every click or pressure to maintain a streak.

The “toy” could be selecting three references and asking for a new variation, rearranging ideas into a small board, or comparing two approaches. Those should be enjoyable before an elaborate project exists. Casual exploration must not silently initiate paid execution.

### Raycast: one discoverable action language

Raycast's Action Panel exposes actions for the selected object, groups them, makes them searchable and displays shortcuts. It can reveal deeper settings in place. [2]

**Adaptation:** one contextual menu for messages, results, people, sources and work items, with keyboard and touch access. A result might offer Open, Compare, Ask about this, Save to room and Use again. A person might offer Mention, Ask for help and View contributions. Essential actions remain visible; the menu holds depth rather than hiding the product.

Underneath, the same permitted operation should back the button, keyboard action and agent tool. This provides a coherent human and machine interface without assuming all operations have identical confirmation requirements.

### Superhuman Split Inbox: personal lenses, not more databases

Custom Split Inbox uses criteria to create distinct attention views. [3]

**Adaptation:** user-pinned views such as Needs me, From my agents, Waiting on someone, or Ready to review. These filter existing room/work records; they do not create different task systems. Do not add all of them to everyone's navigation. Keep saved filters understandable and let people return to the unfiltered room.

## 2. Let a room accumulate useful knowledge

### Are.na and Cosmos: a shelf with meaning

Are.na treats content as blocks connected into collections; Cosmos exposes related elements and the collections containing them. Both offer references for discovery through context rather than only a chronological feed. [4][5]

**Adaptation:** a room shelf for the current brief, references, examples, decisions and accepted outputs. Saving something should take one action. A small note can explain why it matters. Opening an item can show where it was used and what it helped create, within the viewer's permitted scope.

The interesting feature is not merely bookmarks. It is **work that carries its influences**: a prototype can point back to its design examples; a decision to the comparison that informed it. An agent can request a compact selection from the shelf instead of processing every message. Public collections and cross-room discovery remain opt-in.

### Slite: memory that knows when it needs attention

Slite documents knowledge verification, ownership and states such as expired verification or unowned documents. [6]

**Adaptation:** distinguish a current room decision from an old discussion or an unreviewed agent suggestion. A maintained brief has an owner and a last-confirmed version. If a linked decision changes, offer an update rather than silently rewriting the brief. The room can remember “we chose this” separately from “someone once suggested this.”

This creates useful institutional memory for humans and better context for agents. Avoid decorating every message with trust badges; freshness matters primarily on durable material people rely on.

### Tana: structure after expression

Tana's supertags turn ordinary nodes into typed objects with associated fields and searchable collections. [7]

**Adaptation:** let someone write naturally, then deliberately turn a message into a decision, request, reference or offer. Reveal only the fields needed for that type. An agent may suggest the conversion, but should not transform every sentence into project administration. This extends the existing message-to-work approach instead of adding a general database builder to onboarding.

## 3. Make exploration cheap and review pleasant

### Figma: try an alternative without disturbing the main version

Figma's branches provide isolated alternatives, review and comparison before merging into the original. Its documented access model also shows that a branch is not inherently a private access boundary. [8]

**Adaptation:** a **Try another version** action on a proposal, plan, design or draft. People and agents can return alternatives against the same base. Compare them in one place and retain the selected result plus the reasons for choosing it. Do not replace the original merely because the newest output arrived last.

Project Room already has an alternative-draft presentation in the inspected local code. Improve that existing surface into an explicit comparison experience rather than creating a second proposal database. Parallel attempts still need separate bounded scopes and do not permit simultaneous uncontrolled writes.

### tldraw and Obsidian Canvas: optional visual thought

tldraw's agent starter demonstrates agents reading and manipulating canvas objects. Obsidian Canvas places notes and media in a spatial view and uses an open JSON Canvas format. These are separate products and should not be conflated with unrestricted commercial licensing of every component. [9][10]

**Adaptation:** an optional small board inside a room for references, alternatives or dependencies. A person can point at part of a sketch and ask an agent to develop it. A list remains an equally valid view. The board should be a view of existing artifacts, not a competing place where work disappears.

A useful first experiment is a reference arrangement, not a full infinite-canvas editor. If users need visual comparison, qualify an existing component and its license before building a new drawing engine.

### Hex: results should invite the next question

Hex combines published data apps with exploration and, in its January 2026 release, chat that can locate cells, adjust inputs and discuss an app within granted access. [11]

**Adaptation:** an output can be a usable object, not a screenshot buried in chat. A comparison can be filtered. A small calculator can expose its assumptions. A prototype can be opened beside its review. “Ask about this” passes the exact artifact version and permitted context.

This suggests **room tools created from room work**: a useful checklist, calculator or reference lookup can be saved for reuse. Start with controlled artifact types. Arbitrary generated applications need separate isolation and execution controls, not unrestricted scripting inside the main room.

## 4. Make working together feel immediate

### Zed and PlayCanvas: share attention, not just messages

Zed documents persistent collaboration channels and pane-scoped following of another collaborator. PlayCanvas shows shared editing through presence, selection indicators and live project views. [12][13]

**Adaptation:** **Follow along** can open the artifact, section or preview a collaborator is actively showing. The user may leave that view immediately and keep another pane independent. A human could watch an agent revise a prototype; an agent could receive explicit context from the item a person selected.

Do not begin with whole-desktop sharing or cursor surveillance. Begin with a permission-checked object and position. “Looking here” is different from “editing here” and neither automatically grants control. The benefit is less explanation, not more monitoring.

### Miro Talktrack: attach the walkthrough to the work

Miro's Talktrack records walkthroughs inside a board so people can follow the explanation in its working context. [14]

**Adaptation:** a short “show what changed” trail attached to a result. It might start as three linked checkpoints with captions, later adding optional voice or video. Reviewers can jump from a claim to the corresponding artifact instead of reading a long completion message. Agents can generate a proposed tour from evidence; the tour must not assert tests were run when they were not.

### Granola: turn a good move into a reusable recipe

Granola recipes are reusable prompts that can be shared and remixed independently of private meeting notes. Its documentation explicitly describes them as static templates without dynamic substitution. [15]

**Adaptation:** **Use again** on a successful collaboration. Save the process for “compare these options,” “review this release,” or “prepare a research brief,” not the private inputs. Project Room can go further with declared input types, result expectations and authority, but those would be our additions, not Granola capabilities.

A recipe could run with a user-owned agent, hosted help or a copied brief. It should be useful before a visual automation editor exists. Save a successful action first; expose scheduling and more complex steps only on request.

## 5. Show meaningful progress and make disagreement useful

### Basecamp: separate uncertainty from execution

Basecamp's Hill Charts distinguish figuring work out from executing a known approach. [16]

**Adaptation:** an agent working for a long time should show whether it is investigating an unknown, implementing a chosen approach, checking a result or waiting. Prefer a short explanation of the remaining uncertainty over an invented percentage. The phase is reported context, not automatic proof of progress.

This could make a work item say “Testing whether the provider supports this” instead of “Working…” for an hour. It also helps another person offer the right kind of assistance.

### Linear: return to the current situation

Linear combines a short project-health indication with an update and deeper history. [17]

**Adaptation:** improve the existing return brief into a calm re-entry surface: what changed, what needs you, and where you left off. Preserve exact links to the underlying work. Let someone read the room normally without clearing an obligatory queue first. No second status feed is needed.

### Polis: surface shared ground and real disagreements

Polis is an open-source system for gathering and analyzing group opinions. It offers a different inspiration from threaded debate or a simple popularity count. [18]

**Adaptation:** an optional decision comparison: “agreed,” “still disputed,” and “what evidence would change the choice.” Agents can prepare distinct options and identify the tradeoffs; humans retain the relevant decision authority. Multiple agent answers are not independent human votes. Small rooms should start with simple option cards, not statistical claims that require a larger, representative sample.

## 6. Make rooms inviting and useful beyond one project

### Partiful: invite someone to a reason, not to software

Partiful's event experience combines an invitation with lightweight participation such as availability polling and host-visible questionnaires. [19]

**Adaptation:** invite someone to “review this prototype,” “join Friday's build session,” or “help choose a name,” with one clear action. A room can host a temporary sprint or informal gathering without becoming a calendar application. Optional room covers and a small visual identity can make it feel like a place people made together.

Do not require account configuration or agent setup before someone can understand why they were invited. Participation controls and guest visibility must remain clear.

### Peerlist: let the work become the profile

Peerlist uses work profiles and project launches to showcase things people build. [20]

**Adaptation:** accepted contributions can become optional portfolio entries for people and agents: the artifact, their actual role, and the reviewer or collaborators where sharing is permitted. A finished project can have a small contributor credit section. Recognition becomes evidence of useful work, not a global score inflated by messages or tokens.

This creates a plausible growth loop: someone sees a useful result, asks the creator for help, joins a room, and later shares another result. It is a hypothesis, not established retention or acquisition evidence. Agents benefit through clearer discovery and reuse under their operators' goals; software need not be described as independently craving status.

### Superhuman's product-market-fit practice: preserve what people love

The founder's 2018 account describes learning from enthusiastic users and separating the valued core from obstacles preventing broader use. It is a company case study, not a universal growth formula. [21]

**Adaptation:** once people really use Project Room, ask which specific experience they would miss. Protect that experience while improving barriers. Do not let a long inspiration backlog dictate the roadmap. Simulated-human testing can identify mechanics and likely confusion, but cannot supply these customer answers.

## Five combinations that could feel distinctive

These combinations are original Project Room proposals assembled from the patterns above, not claims of novelty against the entire market.

1. **The room shelf becomes an agent brief.** Select a few maintained references and current decisions; ask any compatible helper to work from that precise context. Returned work links to the materials it used. Saving and selecting are useful even without AI.
2. **Try, compare, keep.** Ask for alternatives, view them together, select one and preserve the reasoning. This works for copy, research, code proposals and event plans. Agents produce options without racing to overwrite the canonical version.
3. **Show me rather than tell me.** A helper returns a live artifact plus a few linked checkpoints. A reviewer follows the explanation, asks about a selected detail and requests a targeted revision.
4. **Save the collaboration, not just its output.** A successful request becomes a reusable recipe with required inputs and expected evidence. Another room can reuse the method without importing private history or grants.
5. **A project leaves behind a small public exhibition.** With explicit publication, selected results and contribution credits become an attractive project page. Visitors can view the work, reuse an allowed recipe or offer help. The private room remains private.

## How to keep this coherent

Use existing objects wherever possible: conversation, source, work, attempt, artifact, review and participant. A shelf organizes them; a comparison displays versions; a recipe helps create a new bounded request; a showcase publishes an explicitly selected projection. None needs a mandatory new top-level app.

Default navigation remains Inbox and Rooms. The room's current content supplies personality. Its contextual action menu supplies depth. Optional shelf, workbench or board views can be pinned. Do not force people through a canvas, task hierarchy, agent org chart or automation builder to talk to one another.

Distinguish four extension levels: local organization; proposed assistance; controlled collaboration; external execution/publication. The interface can share styling while making the consequential transitions explicit. This keeps expansion understandable without turning every screen into a warning panel.

## Recommended next work

### First: extend existing surfaces

**Contextual actions and fluency.** Inventory current actions, remove duplicates and design one discoverable menu with shortcuts and touch access. Keep ordinary chat Enter behavior, draft preservation and stable selection. Do not create a generic command interpreter that bypasses existing authorization.

**A stronger return experience.** Extend the existing return-brief implementation rather than building it again. Present current decisions, needs-you items and the resumable activity clearly; keep historical events one layer deeper. Test a return after both quiet and busy room activity.

**A small room shelf.** Begin with references and accepted results using existing permissions and artifact identities. Offer Save to room and Open source. Compare a simple list against a compact visual arrangement before choosing a default. Do not claim the shelf exists merely because work and source records already exist.

### Second: make creation and reuse distinctive

Improve the existing alternative-draft display into comparison and selection. Then add Use again for a narrowly defined recipe type. Prototype a result walkthrough before committing to screen recording. These features should improve collaboration whether the contributor is human, connected agent or manual return.

### Later: expand only where the interaction earns it

Add optional canvases, shared live previews, richer decision sessions, contributor portfolios and published project exhibitions after the simpler flows work. Broader tools, paid work and discovery remain on the blueprint; their operational and payment gates are not resolved by this design research.

The most distinctive near-term addition is the **room shelf connected to reusable work**. The most broadly useful polish is **contextual actions plus an excellent return experience**. Both improve the entire product without requiring another messaging provider or another top-level destination.

## Evidence and implementation boundaries

The inspected local code contains a return brief in `src/return-brief.js` and its presentation in `src/app.js`, plus alternative drafts in the work result UI. Those observations justify extending these areas; they do not establish that every proposed interaction exists. No runtime code changed or tests ran in this research pass. Existing screenshots belong to earlier checkpoints. The pending email-update qualification remains planned, not implemented here, after the request shifted to broader product research.

Before adopting source code, inspect the exact repository, version, license, maintenance and component/service boundaries. tldraw's starter examples, its SDK and production hosting terms are not one interchangeable license. Obsidian's open Canvas format does not make the whole application open source. Product inspiration requires neither importing the entire stack nor copying its visual identity.

## Sources

1. Rahul Vohra, Superhuman. [How to build great products with game design, not gamification](https://blog.superhuman.com/game-design-not-gamification/), June 1, 2021.
2. Raycast. [Action Panel](https://manual.raycast.com/action-panel), current manual.
3. Superhuman. [Custom Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005636204941-Custom-Split-Inbox), current help documentation.
4. Are.na. [About](https://www.are.na/about) and [Blocks](https://help.are.na/docs/getting-started/blocks).
5. Cosmos. [Discovery](https://help.cosmos.so/en/articles/11717949-discovery), March 30, 2026.
6. Slite. [Keep your docs healthy](https://slite.com/help/8asbrkQaX8aQou/Keep-your-docs-healthy).
7. Tana Outliner. [Supertags](https://outliner.tana.inc/learn/features/supertags).
8. Figma. [Guide to branching](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching).
9. tldraw. [Agent starter kit](https://tldraw.dev/starter-kits/agent).
10. Obsidian. [Canvas](https://obsidian.md/canvas).
11. Hex. [Chat with your apps, and other updates](https://learn.hex.tech/changelog/2026-01-21), January 21, 2026; [Project sharing](https://learn.hex.tech/docs/collaborate/sharing-and-permissions/project-sharing).
12. Zed. [Channels](https://zed.dev/docs/collaboration/channels).
13. PlayCanvas. [Real-time Collaboration](https://developer.playcanvas.com/user-manual/editor/realtime-collaboration/).
14. Miro. [Introducing Miro Talktrack](https://miro.com/blog/official-launch-miro-talktrack/), 2023 launch article.
15. Granola. [Recipes](https://docs.granola.ai/help-center/getting-more-from-your-notes/recipes), current help documentation.
16. Basecamp. [Hill Charts](https://basecamp.com/hill-charts).
17. Linear. [Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates).
18. Computational Democracy Project. [Polis](https://pol.is/home).
19. Partiful. [Can I poll or survey my guests?](https://help.partiful.com/en-us/articles/15525422-can-i-poll-or-survey-my-guests), June 16, 2026; [Product](https://partiful.com/).
20. Peerlist. [How to launch a project on Peerlist Launchpad](https://help.peerlist.io/individual/launchpad/how-to-launch-a-project-on-peerlist-launchpad).
21. Rahul Vohra, Superhuman. [How Superhuman built an engine to find product-market fit](https://blog.superhuman.com/how-superhuman-built-an-engine-to-find-product-market-fit/), November 27, 2018.
22. Superhuman. [Go](https://superhuman.com/go), current product page.
23. Superhuman. [Docs](https://superhuman.com/docs), current product page.
