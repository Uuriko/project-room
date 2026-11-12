# Design with evidence

[DESIGN.md](../DESIGN.md) owns product direction and visual tokens. This workflow
applies that direction. Keep the brief, findings and evidence on the existing
work item or PR; do not create another design backlog or living handbook.

## Design is part of the task

A finished product change must make the intended task work and make its interface
understandable. Code correctness, visual craft, information architecture, content,
accessibility and recovery belong in the same acceptance decision. An agent tool
is an interface too: discovery, names, schemas, bounded context, errors and safe
retries affect whether its user can complete the task.

For another project, use that project's design direction and components, not
Project Room's visual identity. Keep a small Design document in existing project
Docs, or link its repository equivalent if that is already authoritative. Include
who it serves, its main tasks, a few annotated references, canonical components,
tokens, language and important states. Link live code and revisioned decisions;
do not create a second copy of task status or assume a Figma file syncs itself.
Agents should retrieve this selected context when starting relevant work.

For a new flow, compare distinct structures before polishing one. For a small
repair, use the existing structure. A reference says what to borrow, such as
information density or navigation, and what does not fit this project's audience.
A beautiful screenshot with an unreachable action is unfinished; passing tests do
not establish that a design is coherent or pleasant to use.

## What to automate and what to judge

| Ordinary code and tools | Design judgment |
| --- | --- |
| Render selected actual components/states, capture viewports/themes, retain source and image hashes | Choose the task flow, hierarchy, visual direction and what deserves emphasis |
| Check token use, available component APIs, links, contrast, overflow and applicable interaction contracts | Decide whether a deviation helps the actual task or merely adds decoration |
| Run keyboard/recovery tests and retain failures | Exercise discoverability, wording and recovery without relying on the author's explanation |
| Package selected evidence and known gaps with the work result | Review the rendered product and record accept, changes requested or insufficient evidence |

Use current reference implementations in place of repeated instructions. Add a
mechanical check for a recurring concrete defect when the intended rule is clear.
Do not ban a typeface, color or layout globally just because generated designs
sometimes overuse it. Do not optimize screenshot similarity over usefulness.

## Product integration, using existing objects

1. **Docs** holds or links the project's design direction, annotated examples and
   component references. Existing revision, access and conflict rules apply.
2. **Work** identifies the user, intended outcome and the relevant design context.
   Design work and engineering work share one task/result model.
3. **Checks and runs** produce source-bound previews, screenshots and interaction
   evidence on configured devices. A preview URL or capture stays tied to its
   revision; it is not evidence about whichever deployment happens to be current.
4. **Review** puts specific feedback beside that result: element/state, observed
   problem, task impact, correction and acceptance evidence. Preserve the reasons
   for a decision so the next agent does not reopen a settled choice blindly.

This is an integration direction, not a claim that automated design-context
retrieval, native preview annotations or cross-device capture dispatch are shipped.
The current implementation is the local evidence gallery and review packet below.
Start there before adding a canvas, new navigation destinations or a design queue.
Existing Figma/Storybook projects can link their authoritative assets and tools;
installing either is not required to contribute or use this workflow.

## Scoped brief and agent prompt

Copy the relevant fields into the work description. Small repairs do not need
alternative concepts or a long specification.

```text
Journey and intended outcome:
Person or agent, starting state, and permissions:
Observed problem and reproduction:
Current revision, route, fixture, viewport, and screenshot:
Existing components and token source:
References: what to borrow from each, and what does not apply:
Success: observable completion and recovery behavior:
Constraints and unknowns:

Read DESIGN.md and the relevant implementation. Inspect the running interface.
Distinguish observed defects from assumptions.
For structural problems, compare two or three different flows before coding.
Compare discoverability, steps, recovery, consistency and implementation cost.
Choose the smallest coherent solution. Color variants are not different flows.
For narrow defects, repair directly without needless alternatives.
Reuse existing components, tokens and vocabulary. Preserve useful labels.
Cover applicable empty, loading, error, permission, success and crowded states.
Check both themes, narrow windows, keyboard focus and enlarged text.
Test agent interfaces through structured tools rather than human browser actions.
Run the changed journey, inspect screenshots, exercise recovery and fix defects.
Report the exact revision, fixture, commands, results and remaining uncertainty.
Attach before/after evidence. Simulated users are not a usability study, and
local fixture tests are not live verification.
```

Use synthetic fixture content in shared evidence, including long names and
crowded lists. Never export real conversations, credentials, cookies or customer
data into public artifacts or third-party design tools.

## Capture and review

Generate the local gallery with the existing Playwright installation:

```sh
node scripts/design-evidence-gallery.mjs --out test-results/design-review --journey entry
```

The optional `--journey` selects `entry`, `access`, `signup`, `room-create`,
`permissions`, `admission`, `results` or `continuation`. Omit it for the existing complete gallery. A selected
journey avoids dumping unrelated screens into the agent's context.

Use a new output directory for each run. Open `index.html` in that directory;
`manifest.json` contains screenshot digests, source provenance and test outcomes.
`review.json` is a compact agent context with the selected states, source,
failures and coverage gaps; `review.md` is the copyable review prompt. Both start
with design review **not reviewed** and no decision. Passing captures cannot set
that decision. Record the actual review on the existing work item or PR.

The command runs selected existing browser journeys against disposable local
stores. It neither contacts production nor updates visual baselines. Its overall
result describes capture/test completion; inspect accessibility findings separately.
Agent discovery and handoff have a direct tool check:

```sh
node --test tests/agent-handoff.test.js tests/agent-discovery-transport.test.js
```

Reuse existing browser checks and the [visual helper](../scripts/visual-regression-helper.mjs).
Record commit and dirty-tree status, browser/version, viewport, theme, fixture and
command. Keep source fixtures with code and generated captures in test artifacts.
A failed capture must remain failed or incomplete; never substitute an old image
without its original provenance. A screenshot proves appearance at its revision,
not current behavior or usability.

A component gallery shows actual app components in reproducible states, not
hand-copied lookalikes. Link states to their renderer and journey. Give agents
only the selected journey and relevant component states, not the entire archive.

Review task completion first, then permissions and honest state, recovery,
navigation and terminology, accessibility, and visual polish. Each finding names
the task impact, concrete evidence and smallest useful correction. An independent
reviewer should exercise the task without accepting the implementer's conclusions.
Screenshot differences indicate change, not improvement; inspect before approving
new baselines. Supplement axe with keyboard, focus return, zoom and screen-reader
checks. See [QA](QA-SYSTEM.md), [testing](HOW-TO-TEST.md), and
[collaboration experiments](COLLABORATION-EXPERIMENTS.md).

## Compare revisions without rebuilding the evidence

After capturing baseline and candidate into separate directories, use:

```sh
node scripts/design-evidence-gallery.mjs --baseline /path/to/baseline-gallery --candidate /path/to/candidate-gallery --out /path/to/new-comparison
```

The comparison writes a side-by-side `index.html` and bounded `comparison.json`
for agents. It verifies screenshot hashes and matches state IDs, fixtures,
components, tests, viewports, themes, browser and environment. Different or
unknown conditions, unstable source, failed captures and missing states remain
explicit. It copies evidence images into the output without changing either
input, running new tests, refreshing baselines or approving design.

Use the comparison to ask what became clearer, what can be removed, and whether
the task and recovery still work. A changed image or lower axe count is not a
usability result. Keep the hypothesis, interaction results and review decision
with the existing task or PR. Pair screenshots with task completion, wrong turns,
recovery and human effort; keep failed attempts. Stop when another iteration has
no concrete expected benefit. The first real comparison used the existing
result-reading accessibility repair; it is not a new participant study.

## Journey coverage

Load the relevant implementation with the selected screenshots:

- Entry and authentication: [shell](../index.html),
  [sign-in UI](../src/auth-signin-ui.js), [password auth](../src/password-auth.mjs).
- Room creation: [app controller](../src/app.js) and [shared styles](../src/styles.css).
- Request admission: [request-access UI](../src/request-access.js),
  [join UI](../src/join.js), [owner attention cards](../src/needs-attention.js),
  [human-account browser journey](../scripts/human-account-admission-browser-check.mjs).
- Agent discovery and handoff: [client](../client/room-agent.mjs),
  [real transport journey](../tests/agent-handoff.test.js).
- Shared visual values: [design tokens](../src/design-tokens.js).

| Journey | Completion evidence | Failure and recovery |
| --- | --- | --- |
| First login to first room | A person with no memberships finds create and join/discovery; creation enters the intended room; invite survives login | Invalid invite, no public results, private room excluded, pending approval, expired session, delayed sign-in; input and destination preserved |
| Owner reviews a join request | Owner discovers the request, understands whom it admits, approves or declines; both parties see the result | Non-owner cannot decide; repeated click is safe; competing decision refreshes truthfully; failed action remains recoverable |
| Agent discovers capabilities and hands off | Fresh agent discovers tools, reads authorized task context, performs a bounded task and leaves a verifiable handoff | Missing scope, stale source, unavailable tool, rejected write, lost response and exact retry; no invented capabilities |

Capture actual available paths. An absent desired path is a product gap, not an
opportunity to fabricate a successful screenshot. Distinguish an agent permission
request from human account admission. Local auth fixtures do not verify Google's
external OAuth service or the desktop callback.

Collect unassisted completion, wrong turns, errors, recovery and elapsed time.
Separate model runs, scripted tests and real-person sessions. Compare the same
starting state and task; retain failures. A few formative trials do not establish
productivity improvements.

## Tools and adoption

| Tool | Use | Decision |
| --- | --- | --- |
| Playwright, pixelmatch, axe | Browser behavior, screenshots, visual comparison, accessibility | Already dependencies; extend existing fixtures |
| Excalidraw (MIT) | Sketch alternative flows | Optional portable diagram; no app dependency |
| Penpot (MPL-2.0) | Editable canvas, tokens, components, MCP | Evaluate one synthetic journey before maintaining a service |
| Storybook | Component states and agent access | Defer installation while existing fixtures suffice; MCP is preview |
| Lucide (ISC) | Consistent SVG assets | Reuse current icons first; add missing assets with attribution |
| Lighthouse | Performance auditing | Use for relevant performance changes; scores are not usability proof |

Penpot evaluation: recreate one synthetic screen using existing tokens, test
responsive behavior, editing/export and agent access, then compare the round-trip
effort with editing the actual app fixture. Adopt if it removes work or enables
useful designer collaboration. Code tokens stay authoritative until synchronization
is verified. Self-hosting, enterprise features and model calls may have costs.
Do not migrate frameworks just to adopt a component kit or install overlapping
prompt packs. The existing [room-antislop skill](../.agents/skills/room-antislop/SKILL.md)
remains the local filter.

## Research update — 2026-11-12

These sources support workflow choices, not a claim that a tool produces better
customer outcomes in Project Room. Product documentation establishes capability;
maintainer examples and community reports are weaker evidence of effectiveness.

| Source | Useful mechanism | Decision here |
| --- | --- | --- |
| [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/mcp-vs-agent/) and [Code Connect](https://help.figma.com/hc/en-us/articles/42495296821911-Code-Connect-and-MCP) | Structured frames, layout, variables and links to real component implementations, alongside screenshots | Retrieve selected project context; use existing assets when supplied. A connection alone does not provide design judgment. |
| [Vercel design-system workflow](https://vercel.com/blog/ai-powered-prototyping-with-design-systems) | Reusable components, consistent APIs and tokens make design constraints available to generation | Reuse actual components and runnable examples; avoid a parallel screenshot-only implementation. |
| [Builder engineering account](https://www.builder.io/blog/how-to-make-ai-agents-follow-your-design-system) | Reference code plus checks catch deprecated imports and invalid styling that prose can miss | Keep instructions short and point to code; extend existing deterministic checks for repeated observed defects. |
| [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview) | Component documentation, state examples, interaction and accessibility tooling; current AI features are preview | Adopt its component/state context pattern through existing fixtures; no framework migration or installation for this slice. |
| [Impeccable](https://github.com/pbakaus/impeccable) and [gstack design review](https://github.com/garrytan/gstack/tree/main/design-review) | Targeted critique, simplification/hardening passes and rendered-browser review | Use focused operations and evidence-linked findings. No wholesale prompt-pack installation or invented aesthetic pass score. |
| [Practitioner discussion](https://www.reddit.com/r/ClaudeCode/comments/1xfumto/how_are_you_handling_uxui_with_claude/) | Reported use of constrained components, tokens, visual references and screenshot critique | A source of testable tactics, not controlled evidence or a universal recipe. |
| [Duan et al., 2024](https://arxiv.org/abs/2403.13139) | Study of heuristic feedback on 51 interfaces and a study with 12 design experts; useful findings coexisted with false positives and missed issues | Use critique as assistance. Keep expert/user judgment and task behavior separate from model approval. The older-model result does not estimate today's models. |

For one consequential changed flow, compare the existing approach with a selected
brief/components/state packet and independent review. Keep the task, audience and
starting state comparable. Record unassisted task completion, wrong turns,
recovery, time, agent calls and reviewer rework. Ask for a reasoned paired visual
preference separately from functional correctness. Keep failed trials; a small
pilot does not establish causation. Stop iterating when remaining changes have no
clear task or visual benefit; repeated model critique can produce busywork.

## Practical setup choices — 2026-11-12

The surrounding tools should reduce repeated work rather than create another
project operating system. These are researched mechanisms, not measured Room
productivity gains or instructions to install every tool.

| Setup | Borrow or reuse | Decision and qualification |
| --- | --- | --- |
| [Agent Skills](https://agentskills.io/specification) | Small discoverable entry, optional scripts, selected references | Keep project guidance versioned and load references on demand. A skill is not a permission grant or proof that a host loads it. |
| [gstack design review](https://github.com/garrytan/gstack/tree/main/design-review) | Inspect rendered screens, concrete findings, responsive checks and paired screenshots | Reuse this review pattern through our gallery. Do not import its full runtime, onboarding, telemetry or weighted design scores. No upstream code copied in this change. |
| [Playwright CLI](https://github.com/microsoft/playwright-cli) and [Trace Viewer](https://playwright.dev/docs/trace-viewer) | Concise browser commands for shell agents; step/DOM/network evidence for a failed journey | Existing Playwright scripts remain the deterministic owner. Evaluate CLI only for a host lacking adequate browser tools; trace one reproducible failure before adding permanent capture overhead. Traces may contain sensitive page/network data. |
| [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview) | Real component states and structured usage context | Keep existing real-app fixtures first. Its AI APIs remain preview and component-manifest support varies by framework; installation is not automatically useful for this app. |
| [Git worktrees](https://git-scm.com/docs/git-worktree) | Independent checkouts for parallel changes | Continue isolated source-pinned work; reconcile ownership and review before composition. Do not create a checkout for every thought or delete unpushed work as cleanup. |
| [Diátaxis](https://diataxis.fr/) | Separate learning tutorials, task how-tos, technical reference and explanation | Use the existing handbook index to route readers by need. Preserve stable links and useful history; no wholesale directory migration is necessary. |

The preferred current setup is the existing Room task and Docs, an isolated
checkout, selected project instructions, actual-app browser fixtures, the paired
review gallery and existing local checks/CI. Keep their results attached to the
same work/result/PR. Add a new tool only for an observed gap, with source/license,
installation and maintenance cost, a bounded trial and a removal condition in the
existing [source library](SOURCE-LIBRARY.md). Workflow documentation establishes
what a setup does, not how much faster it makes our contributors.

## Sources

Earlier review 2026-10-29. References are not runtime-loaded instructions.

- [GenUI study](https://arxiv.org/abs/2606.13843): 24 designers and product managers;
  structured input, broad exploration and fidelity have tradeoffs, not a universal winner.
- [Frontend design guidance](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md):
  deliberate choices, restrained decoration, screenshot critique and clear copy.
  Room's identity takes precedence over generic novelty advice.
- [Penpot](https://github.com/penpot/penpot), [Excalidraw](https://github.com/excalidraw/excalidraw),
  [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview), [Lucide](https://github.com/lucide-icons/lucide).
- [Visual comparisons](https://playwright.dev/docs/test-snapshots),
  [accessibility and manual assessment](https://playwright.dev/docs/accessibility-testing),
  [axe-core](https://github.com/dequelabs/axe-core), [Lighthouse](https://github.com/GoogleChrome/lighthouse).
