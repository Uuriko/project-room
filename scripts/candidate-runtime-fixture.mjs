// Test-only packaging of allowlisted working files. Never a release certificate.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimePackage } from './runtime-package.mjs';

export function candidateRuntimeFixture(repository, directory) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const baseline = join(directory, 'head-runtime');
  createRuntimePackage({ repository, commit: head, destination: baseline });
  const paths = new Set(JSON.parse(readFileSync(join(baseline, 'runtime-manifest.json'))).files.map(entry => entry.path));
  paths.add('client/agent-setup.mjs'); paths.add('client/setup-journal.mjs'); paths.add('scripts/connect-room.mjs');
  paths.add('client/host-result.mjs'); paths.add('client/host-subprocess.mjs'); paths.add('client/host-verification.mjs');
  paths.add('src/agent-error.mjs');
  paths.add('client/request-notices.mjs');
  paths.add('src/work-help.js'); paths.add('server/work-help.mjs');
  paths.add('client/help-actions.mjs');
  paths.add('server/action-classes.mjs');
  paths.add('server/inbox.mjs');
  paths.add('server/inbox-stitch.mjs'); paths.add('server/inbox-stitch-store.mjs'); // Task #19 (imported by server/inbox.mjs)
  paths.add('server/inbox-outbox.mjs'); paths.add('server/inbox-transport.mjs'); paths.add('server/version.mjs');
  paths.add('scripts/stamp-version.mjs');
  paths.add('server/email-envelope.mjs'); paths.add('server/graph-email.mjs'); paths.add('server/email-import.mjs');
  paths.add('server/graph-fixture-sync.mjs');
  paths.add('server/graph-reply-draft.mjs');
  paths.add('server/graph-reply-journal.mjs');
  paths.add('server/graph-reply-update-review.mjs');
  paths.add('server/gmail-content.mjs'); paths.add('server/gmail-import-authority.mjs'); paths.add('server/gmail-sync.mjs'); paths.add('server/vendor/gmail-html-sanitizer.mjs'); paths.add('server/vendor/gmail-html-LICENSES.txt'); paths.add('server/gmail-mailbox.mjs'); paths.add('server/gmail-actions.mjs'); paths.add('src/gmail-ui.js'); paths.add('src/account-setup-ui.js');
  paths.add('src/inbox-client.js'); paths.add('src/inbox-ui.js');
  paths.add('src/inbox-send-ui.js');
  paths.add('src/room-roster.js');
  paths.add('src/account-settings-ui.js');
  paths.add('src/auth-signin-ui.js'); // Multi-method sign-in / create-account UI (imported by src/app.js, slice 7)
  paths.add('src/agent-signin-ui.js'); // Agent browser sign-in choice UI (imported by src/app.js, RC-2026-09-23)
  paths.add('src/room-deep-link.js');
  paths.add('src/browser-session.js');
  paths.add('src/session-expiry.js'); // Session-expiry locale rendering (imported by src/app.js + src/join.js)
  paths.add('src/agent-invite-ui.js');
  paths.add('src/share-invite-code.js');
  paths.add('src/room-mcp-join.js');
  paths.add('server/mcp-http.mjs');
  paths.add('deploy/agent-discovery.mjs');
  paths.add('deploy/capabilities.mjs'); // #601: build-time route-family inventory (imported by deploy/agent-discovery.mjs)
  paths.add('deploy/agent-card-key.mjs'); // RC-2026-09-23-105: room card signing key, public half (imported by deploy/agent-discovery.mjs)
  paths.add('deploy/agent-card-signed.mjs'); // RC-2026-09-23-105: build-time card signature (imported by deploy/agent-discovery.mjs)
  paths.add('deploy/room-entry.mjs');
  paths.add('server/guest-agent-links.mjs');
  paths.add('server/agent-invites.mjs');
  paths.add('server/referrals.mjs'); // Referral attribution (imported by server/store.mjs)
  paths.add('server/thread-mutes.mjs'); // Per-thread mutes (imported by server/store.mjs)
  paths.add('join.html'); // Self-serve join page
  paths.add('src/join.js'); // Join page logic
  paths.add('src/referral-board.js'); // Referral board (imported by src/app.js)
  paths.add('src/work-item-session.js');
  paths.add('src/work-recipes.js');
  paths.add('src/board.js');
  paths.add('src/work-templates.js');
  paths.add('src/room-templates.js');
  paths.add('server/diagnostics.mjs');
  paths.add('server/access-review.mjs');
  paths.add('server/membership-delegation.mjs'); // RC-2026-09-18-038: owner-granted membership administration (imported by server/store.mjs)
  paths.add('server/wake-queue.mjs'); paths.add('server/request-runs.mjs');
  paths.add('server/attention.mjs');
  paths.add('server/room-lifecycle.mjs');
paths.add('server/attachment-schema.mjs');
  paths.add('server/moderation.mjs');
  paths.add('scripts/release-evidence.mjs');
  paths.add('server/usage-summary.mjs');
  paths.add('server/notifications.mjs');
  for (const path of ['server/channel-connection.mjs', 'server/channel-import.mjs', 'server/channel-adapters/index.mjs', 'server/channel-adapters/email.mjs', 'server/channel-adapters/telegram.mjs', 'server/channel-adapters/telegram-rotation.mjs', 'server/channel-adapters/gmail.mjs', 'server/channel-adapters/whatsapp.mjs', 'server/mime-message.mjs', 'server/email-routing-inbound.mjs', 'server/channel-journal.mjs', 'server/room-export-html.mjs']) paths.add(path);
  for (const path of ['server/channel-adapters/telegram-config.mjs', 'server/channel-adapters/telegram-transport.mjs', 'scripts/telegram-set-webhook.mjs', 'scripts/telegram-rotate-webhook.mjs']) paths.add(path);
  paths.add('server/spend-allowance.mjs');
  paths.add('server/pins.mjs');
  paths.add('server/account-login-methods.mjs'); // Multi-method login model (imported by server/store.mjs)
  paths.add('server/account-deletion.mjs'); // RC-2026-09-19-078: deletion executor (imported by server/http.mjs)
  paths.add('src/account-deletion.mjs'); // RC-2026-09-19-078: pure purge planner (imported by server/account-deletion.mjs)
  paths.add('server/account-passkeys.mjs'); // Passkey auth wiring (slice 5; imported by server/http.mjs)
  paths.add('src/passkey-login.mjs'); // WebAuthn logic (imported by server/account-passkeys.mjs)
  paths.add('src/password-auth.mjs'); // Email+password crypto (imported by server/http.mjs, slice 2)
  paths.add('server/magic-links.mjs'); // Magic-link mail sender seam (imported by server/http.mjs)
  paths.add('server/resend-mailer.mjs'); // Resend-backed magic-link sender (imported by server/boot-options.mjs)
  paths.add('server/webhook-dispatch.mjs'); // RC-2026-09-19-064: signed dispatch engine (imported by server/agent-plugin-store.mjs)
  paths.add('server/agent-key-registry.mjs'); // Integration map slice 9 (imported by server/store.mjs and server/agent-identities.mjs)
  paths.add('server/signed-evidence.mjs'); // Integration map slice 5: canonical signed external evidence for work.completed (imported by server/store.mjs)
  paths.add('server/github-oauth.mjs'); // GitHub sign-in (imported by server/http.mjs)
  paths.add('server/retention-run.mjs'); // dry-run retention caller (imported by cloudflare/room.mjs)
  paths.add('server/retention.mjs'); // analytics retention planner (imported by server/retention-run.mjs)
  paths.add('server/audit-retention.mjs'); // audit retention planner (imported by server/retention-run.mjs)
  for (const path of ['server/sla-clocks.mjs', 'server/sla-urgent-notify.mjs', 'server/sla-sweep.mjs', 'server/sla-sweep-hooks.mjs', 'server/sla-breach-journal.mjs', 'server/morning-digest.mjs', 'server/digest-mode.mjs', 'server/inbox-triage.mjs']) paths.add(path); // Tasks 21/24/26 (imported by server/inbox.mjs)
  paths.add('server/inbox-handoff.mjs'); // Task 23 (imported by server/inbox.mjs and server/store.mjs)
  for (const path of ['server/inbox-assign.mjs', 'server/inbox-internal-notes.mjs', 'server/inbox-collision.mjs', 'server/inbox-approval.mjs', 'server/inbox-agent-routing.mjs', 'server/inbox-collab-store.mjs', 'server/inbox-collab-routes.mjs']) paths.add(path); // Lane C inbox collaboration (task RC-2026-09-18-011)
  paths.add('server/room-activation-pack.mjs'); // Room activation pack (quill lane, RC-2026-09-18-040; imported by server/http.mjs)
  for (const path of ['server/work-claims.mjs', 'server/work-claim-routes.mjs']) paths.add(path); // RC-2026-09-18-041: work-claim state machine + HTTP routes (imported by server/http.mjs)
  for (const path of ['server/bounty-escrow.mjs', 'server/bounty-escrow-routes.mjs', 'server/bounty-disputes.mjs', 'server/dispute-arbiters.mjs', 'server/bounty-reputation.mjs', 'server/reputation.mjs', 'server/bounty-receipts.mjs']) paths.add(path); // agent work exchange slice 1: escrowed bounties (imported by server/http.mjs) + slice #4 bounty -> reputation + receipts slice #1: Ed25519-signed movement receipts (imported by server/bounty-escrow.mjs)
  paths.add('server/spam-shadow.mjs'); // Shadow-mode auto-quarantine instrumentation (imported by server/inbox.mjs)
  paths.add('server/dm-consents.mjs'); // Directional DM-consent journal (imported by server/store.mjs)
  paths.add('src/dm-consents.js'); // DM consent browser view-model + API helpers (imported by src/app.js)
  paths.add('server/web-fetch.mjs'); // RC-2026-09-23-102: room-side web fetch (imported by server/http.mjs + server/store.mjs)
  paths.add('server/owner-attention.mjs'); // #662: owner "needs your attention" rollup (imported by server/http.mjs)
  paths.add('src/room-layout.js');
  paths.add('src/needs-attention.js'); // #662: owner attention card (imported by src/app.js)
  paths.add('server/mention-lifecycle.mjs'); // #658: mention lifecycle state machine + schema (imported by server/store.mjs)
  paths.add('server/public-face.mjs'); // Opt-in public read-only face (imported by server/store.mjs)
  const candidate = join(directory, 'synthetic-source'); mkdirSync(candidate);
  // No private state, credentials, docs or real checkout Git metadata.
  for (const path of paths) {
    mkdirSync(join(candidate, path, '..'), { recursive: true });
    cpSync(join(repository, path), join(candidate, path));
  }
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'init.templateDir=', '-c', 'user.name=Room fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd: candidate, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('add', '--', ...paths); git('commit', '-qm', 'Synthetic candidate packaging fixture');
  // packagedPaths is the exact file set committed to the synthetic fixture.
  // Tests derive expected package counts from it (intersected with the
  // runtime-package allowlist) so registering a new module never requires a
  // hand-bumped count (regression guard for #590/#592/#606).
  return { repository: candidate, commit: git('rev-parse', 'HEAD').trim(), packagedPaths: paths };
}
