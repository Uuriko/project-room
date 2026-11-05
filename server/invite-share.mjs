// Teammate invite share line (flag ROOM_INVITE_SHARE, off by default).
// A connected agent mints an agent invite for its human's teammate. Instead of
// a bare code plus REST instructions, it gets one line the teammate pastes
// into their own agent: connect (OAuth sign-in), join with the code, take a
// first task. The code is still returned once and never stored; MCP text
// output redacts it wherever it appears, including inside this line, so it
// travels only in structuredContent.
import { HOSTED_MCP_URL } from './connect-snippets.mjs';

export const INVITE_SHARE_FLAG = 'ROOM_INVITE_SHARE';
export const inviteShareEnabled = (env = process.env) => env[INVITE_SHARE_FLAG] === '1';

export function inviteShareMessage({ code, roomId, expiresAt }, mcpUrl = HOSTED_MCP_URL) {
  if (typeof code !== 'string' || !code || typeof roomId !== 'string' || !roomId) return null;
  const expiry = Number.isFinite(expiresAt) ? ` The code works once and expires ${new Date(expiresAt).toISOString()}.` : ' The code works once.';
  return `Connect to Project Room at ${mcpUrl} (approve the sign-in it asks for), call room_join with inviteCode ${code} to join room ${roomId}, then take and finish one small task there.${expiry}`;
}

export function withInviteShare(result, env = process.env) {
  if (!inviteShareEnabled(env) || !result || typeof result !== 'object') return result;
  const shareMessage = inviteShareMessage(result);
  return shareMessage ? { ...result, shareMessage } : result;
}
