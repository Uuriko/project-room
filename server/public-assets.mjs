// Explicit public files shared by the Node server and Worker asset builder.
// join.html is a template ({{ASSET_BASE}}), packaged separately and not served raw.
export const templateAssetPaths = Object.freeze(['join.html', 'agent-signin.html']);
export const publicAssetPaths = Object.freeze(['src/room-administration.js', 'src/work-reducers.js', 'src/message-reducers.js', 'src/entry.js', 'src/entry-started.js', 'src/signin-entry.js', 'src/signin-navigation.js', 'src/account-client.js', 'src/board-mine.js', 'src/first-room-copy.js', 'strings/en.js', 'strings/en.json', 'index.html', 'project-room-mark.svg', 'src/login-polish.css', 'about.html', 'offers.html', 'src/project-offers-ui.js', 'src/owner-project-offers-ui.js', 'src/owner-cockpit.js', 'src/project-offers.css', 'favicon.svg', 'icon.svg', 'manifest.webmanifest', 'push-sw.js', ...['app.js', 'workspace-navigation.js', 'result-reader.js', 'clipboard.js', 'result-comparison.js', 'result-feedback.js', 'result-availability.js', 'strings.js', 'front-door.js', 'human-experience.js', 'conversation-intent.js', 'human-experience.css', 'member-display-names.js', 'room-layout.js', 'client.js', 'events.js', 'display-name-guard.js', 'conversation.js', 'workflow.js', 'human-push.js', 'human-push-display.js',
  'spend-pricing-ui.js', 'polls.js', 'share-links.js', 'return-brief.js', 'work-selectors.js', 'work-announcements.js', 'work-status.js', 'work-packet.js', 'portable-work.js', 'reminders.js', 'reminder-time.js', 'styles.css', 'agent-connections.js', 'room-charter.js', 'room-instructions.js', 'reply-requests.js', 'work-help.js', 'help-offers.js', 'room-roster.js', 'account-settings-ui.js', 'auth-signin-ui.js', 'agent-signin-ui.js', 'agent-signin-page.js', 'agent-first-run.js', 'invite-context.js', 'request-access.js', 'room-deep-link.js', 'browser-session.js', 'composer-files.js', 'session-expiry.js', 'agent-invite-ui.js', 'board-ui.js', 'html-escape.js', 'board-keyboard.mjs', 'board.css', 'join.js', 'join-watchdog.js', 'work-item-session.js', 'work-loops.js', 'chat-suggestions.js', 'share-invite-code.js', 'handoff-envelope-ui.js', 'dm-consents.js', 'friend-bond.js', 'needs-attention.js', 'access-presets.js', 'room-setup-prompt.js', 'service-origin.js', 'updates-ui.js', 'error-copy.js', 'public-a11y.css'].map(file => 'src/' + file), 'connectors/muse.md', 'skills/project-room-setup/SKILL.md', 'compare/project-room-vs-slack.html', 'compare/project-room-vs-discord.html', 'compare/agent-collaboration-tool.html', 'compare/multi-agent-workspace.html', 'compare/ai-agent-coordination.html', 'compare/project-room-vs-agent-room.html', 'og/home.png', 'og/fonts/Inter-Regular.ttf', 'og/fonts/Inter-Regular.woff2', 'og/fonts/OFL.txt', 'og/about.png', 'og/offers.png', 'og/compare.png', 'og/receipts.png', 'offline.html', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon-180.png', 'src/pwa-install.js', 'src/push-ask.js', 'scripts/install.sh', 'docs/agents/index.html', 'docs/agents/paste.html', 'docs/agents/claude-code.html', 'docs/agents/codex.html', 'docs/agents/cursor.html', 'docs/agents/cline.html', 'docs/agents/vscode.html', 'docs/agents/aider.html', 'docs/agents/openai-agents-sdk.html', 'docs/agents/langgraph.html', 'docs/agents/crewai.html', 'examples/integrations/claude-code/README.md', 'examples/integrations/codex/README.md', 'examples/integrations/cursor/README.md', 'examples/integrations/cline/README.md', 'examples/integrations/vscode/README.md', 'examples/integrations/aider/README.md', 'examples/integrations/openai-agents-sdk/README.md', 'examples/integrations/langgraph/README.md', 'examples/integrations/crewai/README.md', 'operator.html', 'src/operator-ui.js', 'src/operator.css']);
// Decision #36 (#3254, Option A): the docs/agents pages are generated build
// output — scripts/build-agent-docs.mjs renders them from the committed
// docs/agents/*.md sources — and are never committed (decision #32). They
// stay in publicAssetPaths because the canonical Cloudflare deploy generates
// them before building assets; an exact-commit runtime package does not
// contain them (scripts/runtime-package.mjs keeps the same set for its
// standalone filter, pinned equal by test), and the Node server answers 404
// for them while they are absent rather than failing the request.
export const generatedAgentPages = Object.freeze(['docs/agents/index.html', 'docs/agents/paste.html', 'docs/agents/claude-code.html', 'docs/agents/codex.html', 'docs/agents/cursor.html', 'docs/agents/cline.html', 'docs/agents/vscode.html', 'docs/agents/aider.html', 'docs/agents/openai-agents-sdk.html', 'docs/agents/langgraph.html', 'docs/agents/crewai.html']);

// Client bundling (tranche-2 item 1): the browser entry modules bundled by
// cloudflare/build-client.mjs into content-hashed files under
// cloudflare/client-dist/. Bundles are generated output, never committed —
// the generatedAgentPages posture: when no build has run, nothing matches
// the pattern on disk and every asset is served unbundled and source-exact.
// The names live beside publicAssetPaths, deliberately NOT inside that
// declaration: scripts/runtime-package.mjs parses the declaration itself.
export const clientBundleEntries = Object.freeze(['src/entry.js', 'src/signin-entry.js', 'src/app.js']);
// A bundle file is a source-shaped name carrying esbuild's content hash:
// src/<name>-<8-char hash>.js for entries, src/chunk-<8-char hash>.js for
// shared chunks. The hash segment is exactly eight uppercase letters and digits
// (esbuild's [hash] encoding at the pinned version is uppercase letters and digits only; a lowercase eight-letter tail is a source word, never a hash) and the name segment is lowercase
// words, so no existing source name can collide: hyphenated sources such
// as visibility-coordinator.js or peer-dm-client.js never match. Only
// paths of this shape may be generated output; every other asset keeps the
// exact-path contract of publicAssetPaths.
export const clientBundlePattern = /^src\/(?:[a-z0-9]+(?:-[a-z0-9]+)*-[A-Z0-9]{8}|chunk-[A-Z0-9]{8})\.js$/;
export const isClientBundlePath = path => typeof path === 'string' && clientBundlePattern.test(path);
export const clientBundleManifestPath = 'cloudflare/client-dist/manifest.json';
export const clientBundleDiskPath = path => 'cloudflare/client-dist/' + path;
