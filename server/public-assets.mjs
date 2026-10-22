// Explicit public files shared by the Node server and Worker asset builder.
// join.html is a template ({{ASSET_BASE}}), packaged separately and not served raw.
export const templateAssetPaths = Object.freeze(['join.html', 'agent-signin.html']);
export const publicAssetPaths = Object.freeze(['src/work-reducers.js', 'src/message-reducers.js', 'src/entry.js', 'src/signin-entry.js', 'src/signin-navigation.js', 'src/account-client.js', 'src/board-mine.js', 'src/first-room-copy.js', 'strings/en.js', 'strings/en.json', 'index.html', 'project-room-mark.svg', 'src/login-polish.css', 'about.html', 'offers.html', 'src/project-offers-ui.js', 'src/owner-project-offers-ui.js', 'src/owner-cockpit.js', 'src/project-offers.css', 'favicon.svg', 'icon.svg', 'manifest.webmanifest', 'push-sw.js', ...['app.js', 'workspace-navigation.js', 'result-reader.js', 'clipboard.js', 'result-comparison.js', 'result-feedback.js', 'result-availability.js', 'strings.js', 'front-door.js', 'human-experience.js', 'conversation-intent.js', 'human-experience.css', 'member-display-names.js', 'room-layout.js', 'client.js', 'events.js', 'display-name-guard.js', 'conversation.js', 'workflow.js', 'human-push.js', 'human-push-display.js',
  'spend-pricing-ui.js', 'polls.js', 'share-links.js', 'return-brief.js', 'work-selectors.js', 'work-announcements.js', 'work-status.js', 'work-packet.js', 'portable-work.js', 'reminders.js', 'reminder-time.js', 'styles.css', 'agent-connections.js', 'room-charter.js', 'room-instructions.js', 'reply-requests.js', 'work-help.js', 'help-offers.js', 'room-roster.js', 'account-settings-ui.js', 'auth-signin-ui.js', 'agent-signin-ui.js', 'agent-signin-page.js', 'agent-first-run.js', 'invite-context.js', 'request-access.js', 'room-deep-link.js', 'browser-session.js', 'composer-files.js', 'session-expiry.js', 'agent-invite-ui.js', 'board-ui.js', 'board-keyboard.mjs', 'board.css', 'join.js', 'join-watchdog.js', 'work-item-session.js', 'work-loops.js', 'chat-suggestions.js', 'share-invite-code.js', 'handoff-envelope-ui.js', 'dm-consents.js', 'friend-bond.js', 'needs-attention.js', 'updates-ui.js', 'error-copy.js', 'public-a11y.css'].map(file => 'src/' + file), 'connectors/muse.md', 'compare/project-room-vs-slack.html', 'compare/project-room-vs-discord.html', 'compare/agent-collaboration-tool.html', 'compare/multi-agent-workspace.html', 'compare/ai-agent-coordination.html', 'compare/project-room-vs-agent-room.html', 'og/home.png', 'og/fonts/Inter-Regular.ttf', 'og/fonts/Inter-Regular.woff2', 'og/fonts/OFL.txt', 'og/about.png', 'og/offers.png', 'og/compare.png', 'og/receipts.png', 'offline.html', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon-180.png', 'src/pwa-install.js', 'src/push-ask.js', 'scripts/install.sh', 'docs/agents/index.html', 'docs/agents/paste.html', 'docs/agents/claude-code.html', 'docs/agents/codex.html', 'docs/agents/cursor.html', 'docs/agents/cline.html', 'docs/agents/vscode.html', 'docs/agents/aider.html', 'docs/agents/openai-agents-sdk.html', 'docs/agents/langgraph.html', 'docs/agents/crewai.html', 'examples/integrations/claude-code/README.md', 'examples/integrations/codex/README.md', 'examples/integrations/cursor/README.md', 'examples/integrations/cline/README.md', 'examples/integrations/vscode/README.md', 'examples/integrations/aider/README.md', 'examples/integrations/openai-agents-sdk/README.md', 'examples/integrations/langgraph/README.md', 'examples/integrations/crewai/README.md', 'operator.html', 'src/operator-ui.js', 'src/operator.css']);
// Decision #36 (#3254, Option A): the docs/agents pages are generated build
// output — scripts/build-agent-docs.mjs renders them from the committed
// docs/agents/*.md sources — and are never committed (decision #32). They
// stay in publicAssetPaths because the canonical Cloudflare deploy generates
// them before building assets; an exact-commit runtime package does not
// contain them (scripts/runtime-package.mjs keeps the same set for its
// standalone filter, pinned equal by test), and the Node server answers 404
// for them while they are absent rather than failing the request.
export const generatedAgentPages = Object.freeze(['docs/agents/index.html', 'docs/agents/paste.html', 'docs/agents/claude-code.html', 'docs/agents/codex.html', 'docs/agents/cursor.html', 'docs/agents/cline.html', 'docs/agents/vscode.html', 'docs/agents/aider.html', 'docs/agents/openai-agents-sdk.html', 'docs/agents/langgraph.html', 'docs/agents/crewai.html']);

// Static-asset cache policy, shared by the Cloudflare edge
// (cloudflare/edge-public.mjs) and the Node server (server/http.mjs) so both
// paths answer identical Cache-Control/ETag behaviour for the same asset
// (#4065). Scripts, styles, SVG and the web manifest keep unhashed names, so
// they revalidate on every load (no-cache) against a content ETag and an
// unchanged file costs a 304. Other images and fonts get a one-day cache.
// Anything else (HTML, text, JSON) gets no asset policy: null.
const REVALIDATED_ASSET_TYPES = ['text/javascript', 'text/css', 'image/svg+xml', 'application/manifest+json'];
export function assetCachePolicy(type) {
  const base = String(type).split(';')[0].trim();
  if ((base.startsWith('image/') && base !== 'image/svg+xml') || base.startsWith('font/')) return 'public, max-age=86400';
  if (REVALIDATED_ASSET_TYPES.includes(base)) return 'no-cache';
  return null;
}
// The ETag for an asset: the first 16 bytes of its SHA-256 digest, hex,
// quoted. `digest` is the full SHA-256 as a Uint8Array (crypto.subtle at the
// edge, node:crypto in the Node server) so both paths format it identically.
export function assetEtagValue(digest) {
  return `"${Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('')}"`;
}
export function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  return header.split(',').some(tag => {
    const value = tag.trim().replace(/^W\//, '');
    return value === '*' || value === etag;
  });
}
