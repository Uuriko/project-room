# Design with evidence

[DESIGN.md](../DESIGN.md) owns product direction and visual tokens. This workflow
applies that direction. Keep the brief, findings and evidence on the existing
work item or PR; do not create another design backlog or living handbook.

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
node scripts/design-evidence-gallery.mjs --out test-results/design-review
```

Use a new output directory for each run. Open `index.html` in that directory;
`manifest.json` contains screenshot digests, source provenance and test outcomes.
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

## First three journeys

Load the relevant implementation with the selected screenshots:

- Entry and authentication: [shell](../index.html),
  [sign-in UI](../src/auth-signin-ui.js), [password auth](../src/password-auth.mjs).
- Room creation: [app controller](../src/app.js) and [shared styles](../src/styles.css).
- Request admission: [request-access UI](../src/request-access.js),
  [join UI](../src/join.js), [owner attention cards](../src/needs-attention.js).
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

## Sources

Reviewed 2026-10-29. References are not runtime-loaded instructions.

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
