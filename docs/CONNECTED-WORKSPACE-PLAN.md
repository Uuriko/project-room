# Connected workspace: web, desktop, and fast agents

Owner: Codex, at John's request. Baseline: production `83746c5b`, October 10, 2026 Pacific time.

## Product outcome

People work in one conversation on web or desktop. One assistant assembles useful progress and results from multiple agents. Agents receive compact context and use direct machine tools rather than navigating a human interface. A connected Mac supplies local execution and computer tools; the conversation can remain open in a browser elsewhere.

Keep the login page minimal. Put connection setup after sign-in. Do not make people select runtimes, protocols, or agent IDs before they can chat. Keep individual-agent targeting available, not mandatory.

## What exists, and what does not

| Existing component | Reuse | Missing connection |
| --- | --- | --- |
| Web UI embedded in native WKWebView | Same conversation, work, results and controls | Native host setup and status |
| Shared assistant runs and public draft/final publication | Group input, Stop, continuation, one result | Authenticated continuously running coordinator |
| `get_room_context` and its version cursor | Compact structural reads; unchanged responses | Assistant requests omitted from current agent resume |
| Hosted MCP and RoomAgentClient | Typed actions and existing authorization | Host installation/discovery and useful defaults |
| Wake long-poll/SSE | Quick transport where host supports it | Transport does not itself start a provider runtime |
| LocalTools + owner-only native IPC | Files, process execution, pause and operation journal | Native observation, host configuration path, remote device binding |
| `machine/` daemon and relay | Separate leased VM execution use case | Not the personal Mac's native-app access engine |

Pending source checkpoints must not be described as installed: PR2603 cube icon, PR2609 truthful assistant status, PR2611 explicit local connection path, PR2612 continuous Codex pickup, PR2614 native observation. Hosted CI and production rollout are separate from local tests.

Live audit: muse-room has agent members and collaboration but no configured shared coordinator. Grok and Fo report that a Room mention cannot start their idle provider sessions today. Heartbeat, membership, provider sign-in, and successful execution are different facts.

## Research decisions

1. Browser service workers may be terminated. Use them for notifications and bounded synchronization, not as the always-running local agent host. [MDN background operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation).
2. macOS supports native login/background services through SMAppService. First qualify an app-owned host with correct shutdown; then package the same host as a login service with a stable signed identity. Do not introduce a second execution journal. [Apple SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice).
3. Reuse MCP typed tool schemas and structured results. Tool execution errors belong in tool results, not invented chat success messages. Do not add another universal command language. [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
4. Use native accessibility data for app structure and targeted screenshots for visual evidence. Screen capture and app control are distinct macOS grants. [Apple Accessibility](https://developer.apple.com/documentation/applicationservices/axuielement_h), [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit).
5. Dedicated provider configuration explicitly names the native MCP helper and its connection path. An isolated HOME must not silently discover the wrong broker. [Codex MCP configuration](https://developers.openai.com/codex/mcp/).

## Implementation order and acceptance

### 1. Complete the local execution connection

- Reuse the continuous shared-run supervisor: one journal and one owned runtime profile, sequential dependent work, recovery before new work.
- Add bounded preflight/status/stop commands. Preflight distinguishes protocol support, account configuration, and an actual completed model turn. Never call a protocol handshake model-ready.
- Write a private, atomic status artifact containing only bounded operational fields. No prompts, credentials, model reasoning, tool arguments, or raw stderr.
- Native app selects one host configuration file, starts/stops the supervisor, and shows actual status. Keep path details out of the default view.
- App-lifetime execution is the first working mode: closing a room window is different from quitting the app. Quitting must settle or explicitly report unresolved execution and clean up its process tree.
- Existing Mac-tools enable/pause remains separate from provider sign-in. Starting a host does not implicitly grant screen or file access.

Acceptance: native host controls a real child; duplicate host rejected; stopped child cannot remain green; invalid config is actionable; stop is bounded; restart does not rerun completed work; no ambient provider credentials imported.

### 2. Make agent resume complete and cheap

- Extend the existing resume packet with an explicit assistant focus. Return own assigned runs, status/revision, pending inputs and the next context-read reference.
- Preserve existing default output and read-only behavior. No implicit acknowledgement, claim, execution or permission changes.
- Reuse context versions/cursors. Read changed work first, fetch large bodies only when needed.
- Keep per-operation IDs and results for direct actions. Parallelize independent reads/work; preserve ordering for dependent writes. Audit existing batch support before adding any new batch endpoint.

Acceptance: foreign runs excluded; fresh authorization enforced; bounded output; Stop/deleted-source state retained; repeated resume performs no mutations.

### 3. Prove the shared human journey

- Browser user posts a public ask; the already-running supervisor discovers it without a manually supplied run ID.
- One result appears in the same conversation. A second participant can contribute; shared continuation uses the same ownership/journal mechanisms.
- Stop targets the actual running turn. Network interruption and restart preserve uncertain outcomes rather than guessing success or replaying side effects.
- Test web UI and backend with a deterministic provider subprocess. Label this transport/integration evidence, not authenticated model qualification.
- Separately qualify an authenticated provider with a small real task once its dedicated profile is signed in.

Acceptance: no manual run-ID selection, exactly one public final result, bounded pickup time in a local fixture, no duplicate on restart, UI shows an actionable waiting/error state when host is absent.

### 4. Connect computer tools to useful tasks

- Land tested app-state and selected-window screenshot tools, with secure fields omitted and bounded local capture retention.
- Add semantic app actions and keyboard commands next; use coordinates only when semantic access is unavailable. Return observed state after actions, not only an injected-event acknowledgement.
- Add local repository/workspace operations, development servers, file watching and artifact previews through existing file/process tooling.
- Expose capabilities by observation: available, needs permission, paused, unavailable. Do not infer Full Disk Access from an unrelated successful file read.
- Keep captures local unless a task authorizes sharing them. A room member's membership alone must not select or authorize this Mac.

Acceptance: actual fixture app observation/action, denied-permission recovery, pause during an operation, target-window validation, bounded outputs/artifacts, actual native broker connection from an isolated agent home.

### 5. Allow the web to direct the connected Mac

- Audit existing relay and host registration before adding routes. Use one outbound authenticated connection from the Mac; avoid an unauthenticated localhost web bridge.
- Bind a selected device, room, acting identity, task and current local grant to every execution request. Preserve operation IDs and result receipts across reconnects.
- Add destination selection to existing work controls: automatic when unambiguous; Cloud / connected device when a meaningful choice exists.
- Web and desktop consume the same run events and results. Losing the web tab does not cancel work; explicit Stop does. Device sleep/offline must be visible.
- Native app provides the local pause/revoke control even if the website is unavailable.

Acceptance: web-created task executes in a fixture device host, foreign room/device requests denied, grant revocation stops new work, duplicate delivery does not repeat effects, local pause works offline.

### 6. Reduce interface noise and add native conveniences

- Human default: conversation, compact progress, results, essential navigation. Operational evidence stays in details.
- Agent console: current work, incoming requests, available tools and actionable connection failures. Keep participant directories, generic onboarding and raw operational feeds secondary.
- Machine clients should not need this console; publish one accurate connection/setup packet and discoverable tool catalog.
- After host qualification: launch at login using SMAppService, menu-bar status/pause, global “Ask Room about this” shortcut and Finder handoff of explicitly selected files.
- Do not duplicate cloud connectors in native code: Gmail/calendar/GitHub APIs should work from either interface. Native integrations serve capabilities unavailable through those APIs.

Acceptance: keyboard-accessible controls, stable focus after updates, compact narrow-window layout, no human signup nudges for authenticated agent identities, no room-wide claim noise in a focused conversation.

## Delivery and evidence

Each checkpoint records source revision, tests, PR, deployed revision and live proof separately. Merge only exact green heads through the shared merge slot. Install a qualified native build with a stable app location; do not silently replace the user's running signed-in app during a demonstration.

This plan is complete when both a browser and desktop user can initiate the same useful task, the assigned host automatically executes it with the configured tools, the result appears once in the shared conversation, and Stop/reconnect/revocation work end to end. A collection of tools or green presence badges is not that outcome.


## Reuse decisions and React revision (October 11 research)

Decision: qualify a React conversation surface using assistant-ui. A framework change is justified if it improves the actual experience and removes custom maintenance. Keep Room's canonical messages, authorization, run ownership, operation receipts and native broker. Replace presentation in a bounded surface first, then remove the superseded implementation after parity. Do not maintain two permanent chat implementations.

### Source inspection and limits

Inspected repository metadata, READMEs and available root licenses for 19 repositories (a twentieth Cua repository URL returned 404 and is not treated as verified). Inspected selected implementation paths in assistant-ui, ACP, Peekaboo, AG-UI and Zulip. This is targeted inspection, not a claim that every line of every repository was reviewed or that upstream behavior was executed locally. Source snapshots are dated; pin versions before adoption and recheck package-specific licenses.

Project Room currently has no React production dependency. Its `src/app.js` is 7,871 lines at the reviewed baseline, including keyed message DOM reuse, scroll anchoring, focus restoration and interleaved work cards. Size alone is not proof of poor code. These existing behaviors are migration requirements, not disposable scaffolding. Playwright, axe, property testing and visual comparison tooling already exist; reuse them.

### Ranked reuse map

| Priority / project | What to reuse | Room integration and decision |
| --- | --- | --- |
| Now: [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Existing runtime's session, turn, streamed events and interruption | Continue current adapter. Do not recreate a coding-agent harness. Room owns group orchestration, Codex owns its execution session. Apache-2.0 repository. |
| Now: [assistant-ui](https://github.com/assistant-ui/assistant-ui) | React conversation primitives, external-store runtime, structured message parts, viewport behavior | Build conversation pilot against Room state. MIT. Custom multiplayer attribution/actions still needed; no migration of Room backend to a demo chat endpoint. |
| Now: [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Structured browser interaction through existing Playwright tooling | Add a supported optional tool connection rather than implement our own DOM automation engine. Apache-2.0. Separate agent browser profile from human browsing unless explicitly connected. Existing Room QA already uses Playwright. |
| Next: [Peekaboo](https://github.com/openclaw/Peekaboo) | Mac app observation, semantic actions, snapshot/target validation, permissions UX | Evaluate executable/library boundary behind native broker before extending custom action code. MIT. Current upstream requires macOS15+/Swift6.2; Room targets macOS14/Swift5.9, so it is not a drop-in dependency. Keep actual grant and process identity visible. |
| Next: [ACP](https://github.com/agentclientprotocol/agent-client-protocol) | Standard client-to-agent session, capabilities, prompt/cancel and permission exchange | Implement one adapter for compatible runtimes instead of a bespoke adapter for each. Apache-2.0. ACP does not supply Room membership, multiplayer arbitration or remote wake by itself. |
| Next: [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Protocol validation, transports and interoperability fixtures | Compare against existing hand-written MCP surface, then adopt boundary-by-boundary if it reduces custom protocol code. Current upstream is in MIT/Apache licensing transition; pin package/version. Do not replace Room tool semantics. |
| Next: [Zulip](https://github.com/zulip/zulip) | Read/unread model, message-list navigation, history loading, keyboard interaction and regression cases | Borrow focused behaviors and tests. Apache-2.0. Do not transplant its whole backend. Useful counterweight to single-user AI-chat component assumptions. |
| Voice: [LiveKit Agents](https://github.com/livekit/agents) | Media transport integration, voice agent sessions and interruption | Candidate for shared human/agent voice, browser and native clients. Framework Apache-2.0; turn-detector models have a separate model license. Do not implement an SFU or voice turn detector ourselves. |
| Shared artifacts: [Yjs](https://github.com/yjs/yjs) | Concurrent document editing and offline merge | Use for editable shared plans/documents when that feature is built. MIT root license verified despite GitHub metadata reporting NOASSERTION. Keep ordered chat events outside the CRDT. |
| Quality: [Promptfoo](https://github.com/promptfoo/promptfoo) | Repeatable provider/task evaluations and adversarial fixtures | Use to compare task outcomes and tool choices; retain existing deterministic authority/recovery tests. MIT. Run explicit finite suites, not paid evaluation loops by default. |
| Observability: [Langfuse](https://github.com/langfuse/langfuse) | Optional trace/evaluation UI | Export through a bounded adapter rather than build another trace product. Repository has mixed licensing; review exact edition/package before adoption. Do not export raw room content by default. |
| Compatibility: [AG-UI](https://github.com/ag-ui-protocol/ag-ui) | Portable streamed agent UI event format | Add only where an integration needs it; map to Room events. MIT. Avoid a second canonical run state machine or exposing raw internal agent deliberation. |
| Alternate engine: [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk) | Existing coding execution engine, workspace and conversation APIs | Optional runtime adapter rather than another Room-native agent loop. MIT SDK; review other OpenHands repositories independently. |
| Alternate engine: [Goose](https://github.com/aaif-goose/goose) | Extensible local agent runtime | Candidate provider/host, not an orchestration rewrite. Apache-2.0. Compare with ACP support before writing a direct adapter. |
| Specialized browser agent: [Browser Use](https://github.com/browser-use/browser-use) | Higher-level autonomous browsing engine | Optional hosted/local runtime when semantic Playwright tools alone are insufficient. MIT. Adds another agent loop and model cost, so not the default browser tool. |
| Integration platform: [Nango](https://github.com/NangoHQ/nango) | OAuth lifecycle, refresh, external service integration | Evaluate as a separate service integration. Root license is Elastic License2.0, not permissive despite marketing language; do not copy it into our Apache distribution on assumption. Existing Gmail/account auth should not be rewritten just to add it. |
| Durable workflows: [Temporal TS SDK](https://github.com/temporalio/sdk-typescript) | Durable workflow recovery patterns | Study or use for a demonstrated future cross-service workflow need. MIT SDK. Current Room already has run/attempt journals and leases; adding a parallel workflow authority now increases complexity. |
| Memory: [Graphiti](https://github.com/getzep/graphiti) | Temporal knowledge graph retrieval | Research option for evidence-backed long-lived memory; Apache-2.0. Not a prerequisite for compact context or current room history. Measure retrieval improvement before adding graph infrastructure. |
| Editor reference: [Zed](https://github.com/zed-industries/zed) | Collaboration and agent/editor interaction patterns | Study behavior and ACP integration. Repository licensing is mixed; inspect exact files before copying. Do not migrate our native shell or product to an editor framework. |

### What source inspection changed

assistant-ui snapshot `55fb0cbda237605b2af43f934abec00c79493182` contains a 561-line viewport auto-scroll hook with a 1,765-line test file. Its cases include content growth without DOM mutation, expanded disclosures, user gestures cancelling queued scrolling, and maintaining the reader's anchor while earlier history settles. These are concrete reusable behaviors, not evidence that React itself is automatically faster.

Its [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store) accepts externally owned messages and action callbacks. This is the appropriate boundary: Room remains authoritative. However the runtime uses conversation-level running state and user/assistant roles; Room must retain member identity and per-run control state independently. Do not concatenate messages from unrelated agents merely because both have assistant role. Do not use a demo edit handler that truncates shared history. A failed Stop must not be represented as a successful local cancel.

Peekaboo snapshot `5afcafb5ca7e4f3fe524ce1139d624e811cf3043` separates snapshot validation/mutation coordination and bridge/runtime handling. Compare these with our native broker before creating more action plumbing. First measure a minimal integration with our target macOS version; do not absorb the entire app and its model runner.

ACP snapshot `3fbe4a546e13c9b59241acef80f38f9a08f64610` supplies versioned schema artifacts. Negotiate actual capabilities and test cancellation/resume semantics for each connected agent; protocol compatibility is not proof an idle agent can be started.

Zulip snapshot `d7c57ed15b82b0bc8aefe2007f5ee2abeebd0ea2` separates unread bookkeeping and message-list behavior. Use its multiplayer concerns to supplement AI-chat component tests.

### React conversation implementation and qualification

1. Finish the current execution host and exact-attempt Stop recovery first. A polished renderer cannot make an absent host execute work.
2. Add a React conversation entry point with a pinned assistant-ui version, existing Room design tokens and an external-store adapter. Keep signup, room selection, settings and native shell in place during this checkpoint.
3. Define the adapter explicitly: stable message ID, author member ID/name, source run/attempt, revision, public content parts, delivery status and permission-derived available actions. Room events update this store; rendering does not initiate agent execution.
4. Render a group transcript, not alternating single-user bubbles. Multiple humans may post consecutively. One visible assistant result can aggregate several agents with attribution in details; direct agent mentions remain possible.
5. Wire send/edit/reply/reaction/files and exact-run Stop to existing endpoints. Never let external-store callbacks rewrite another participant's message or truncate canonical shared history. Disable unsupported branch/regenerate controls.
6. Test two human browser sessions plus agent runtime: concurrent sends; streamed result while another person types; participant name change; edit/delete; reconnect duplicates; Stop conflict/review; room switch during pending operation; stale permission after revocation.
7. Exercise reading during streaming, image resize, older-history prepend, expanded tool details, keyboard focus, IME composition, mobile keyboard and native WKWebView. Run existing axe/visual/browser checks. Measure bundle cost, input delay and update/render cost against the old view on the same fixture.
8. Promote when functional parity and measured experience improve. Remove the old conversation renderer and duplicate event listeners as part of promotion. A staged migration is a route to replacement, not an excuse to keep two systems indefinitely.

The first qualification task is a working Room-backed conversation pilot, not a static component gallery. If assistant-ui's single-assistant assumptions require more adapter code than they save, keep React for the conversation and replace only the unsuitable primitives; record that decision with evidence.


### Independent multiplayer adapter review

The runtime source's `cancelRun()` calls `onCancel` without awaiting the server result; when `setMessages` is provided it can also remove a trailing user message and restore its text into the composer. Room must therefore retain a custom exact-run Stop control and must not expose a generic array-replacing `setMessages` callback. A server rejection must leave the canonical transcript intact. This was independently checked against the installed package, not inferred from screenshots.

Refined migration seam: mount the React transcript at the existing `renderMessages()` boundary using the already-scoped Room projection. Keep the existing composer controller first: its submit path includes operation IDs, Ask Room/contribution scope, upload gates, generation checks and failure recovery. Extract that controller before replacing its view. Do not introduce another SSE stream, history database or execution engine. Key runtime lifetime to session generation plus room/channel/thread, and discard late completions after scope changes. Visibility is determined by Room authorization and projection, never just user/assistant role.

Stop recovery regression discovered during qualification: queued UI can lag a newly claimed provider attempt. Exact-attempt rejection is correct, but explicit Review previously refreshed revision without refreshing the reviewed attempt, making retries fail repeatedly. A failing regression and surgical patch have been prepared; the shared source lane is currently held by another agent, who received the patch for coordination. Do not count that production fix as landed until its carrier passes.


### Initial React feasibility result

An isolated prototype with React19.3.0 and assistant-ui0.15.27 passed against a real local Room HTTP server and disposable identities: two human browser sessions sent concurrently, both received persisted messages, consecutive messages from two agents retained distinct attribution, and an incoming update preserved a typed draft. No browser page errors. Its minimal production-mode bundle measured573,553 bytes raw /173,872 gzip; this is prototype overhead, not a comparison proving it faster than the current app. Dependencies remain outside production.

This initial harness uses polling and fixture HTTP credentials solely to qualify rendering/state compatibility. Production integration must use Room's existing scoped event stream and session controller. Streaming, Stop, edit/reactions, private-content boundaries, history, accessibility, native WebKit and comparative performance remain unqualified in the prototype. The screenshot is an engineering fixture, not the proposed final design.

Current connected-workspace acceptance independently passes browser ask → automatic supervisor pickup → one result → exact-attempt Stop → restart without duplicate execution. The provider subprocess is deterministic test code; this does not establish a real authenticated model turn. 228 affected checks and repository lint passed; full-suite results are tracked separately.


### Combined checkpoint qualification

After integrating the status CLI and native host, the browser acceptance still passes. Its deterministic provider explicitly requires no external authentication; a missing real account remains blocked. Fixture state is atomically replaced to avoid partial JSON reads.

Native Swift → actual host CLI → real fixture Room server → owned status → actual Stop passed6 integration checks; native process lifecycle passed18 checks. No real model turn or installed-app qualification is implied.

Full npm test completed with9,368 pass /28 fail /10 skip. An independent isolated checkout of unchanged baseline83746c5b reproduced all28 failures in the same9 files. These include Linux-only configured-host sandbox checks on Mac, canonical temporary-path fixture assumptions, a compressed-image golden and a same-millisecond timestamp assertion. Keep Linux sandbox enforcement; improve the relevant portability/fixture checks separately. This establishes that these28 failures are not introduced here, not that the whole release is qualified.
