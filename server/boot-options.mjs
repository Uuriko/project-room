import { readFile, mkdtemp, cp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { googleConfig } from './google-oauth.mjs';
import { githubConfig } from './github-oauth.mjs';
import { gmailConfig } from './gmail-mailbox.mjs';
// The default boot path wires its HTTP server arguments here so both the
// local/staging entry point (server.mjs) and any test can build the exact
// same server the boot would. The ChannelWebhookInbox is constructed next to
// the store: without it the webhook route answers 409 channel_webhook_unavailable
// and Telegram inbound deliveries never land. Cloudflare's entry point
// (cloudflare/room.mjs) passes an equivalent value itself.
import { ChannelWebhookInbox } from "./channel-import.mjs";
import { createMagicLinkMailer } from "./magic-links.mjs";
import { magicLinkMailerFromEnv } from "./resend-mailer.mjs";

// A self-hosted checkout never ran the hosted deploy that creates
// room-acp.tgz, and the service unit keeps the checkout read-only. Build the
// archive from the reviewed room-acp/ sources in a private temp directory,
// keep it in memory, and serve it. A host without npm, or without those
// sources, keeps answering 404 (ENOENT) as before. Node only: the Worker entry
// point never imports this module.
export function roomAcpPackFallback(assetRoot) {
  let pending = null;
  return () => {
    pending ??= (async () => {
      const root = fileURLToPath(assetRoot), source = join(root, "room-acp");
      const missing = cause => Object.assign(new Error("room-acp.tgz is not available", { cause }), { code: "ENOENT" });
      const builder = join(root, "scripts", "build-room-acp-pack.mjs");
      try { await access(join(source, "package.json")); await access(builder); } catch (error) { throw missing(error); }
      const work = await mkdtemp(join(tmpdir(), "room-acp-serve-"));
      try {
        await cp(source, join(work, "room-acp"), { recursive: true, filter: file => !/(^|\/)(node_modules|tests?)(\/|$)/.test(relative(source, file)) });
        const { buildRoomAcpPack } = await import(pathToFileURL(builder).href);
        return await readFile(buildRoomAcpPack(work));
      } catch (error) {
        console.warn(`room-acp.tgz could not be built for serving: ${error?.message ?? error}`);
        throw missing(error);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    })();
    pending.catch(() => { pending = null; });
    return pending;
  };
}

export function defaultServerArgs({ store, env = process.env, ...rest }) {
  const send = magicLinkMailerFromEnv(env);
  const magicLinkMailer = send
    ? createMagicLinkMailer({ send, baseUrl: rest.origin ?? null })
    : createMagicLinkMailer();
  const googleAuth = rest.origin ? googleConfig(env, rest.origin) : null;
  const githubAuth = rest.origin ? githubConfig(env, rest.origin) : null;
  const gmailAuth = rest.origin ? gmailConfig(env, rest.origin, googleAuth) : null;
  return {
    googleAuth, githubAuth, gmailAuth,
    mcpOAuthClients: env.ROOM_MCP_OAUTH_CLIENTS ? JSON.parse(env.ROOM_MCP_OAUTH_CLIENTS) : [],
    mcpOAuthLoopback: /^(1|true|yes)$/i.test(String(env.ROOM_MCP_OAUTH_LOOPBACK ?? "").trim()),
    publicAgentPages: env.ROOM_PUBLIC_AGENT_PAGES === "1",
    assetFallbacks: { "room-acp.tgz": roomAcpPackFallback(rest.assetRoot ?? new URL("../", import.meta.url)) },
    ...rest, store, channelWebhooks: store ? new ChannelWebhookInbox(store) : null, magicLinkMailer,
  };
}
