// Per-agent connect link.
//
// Every agent invite gets its own link. The link carries the invite code, so
// the consent screen can open on the right connection instead of asking the
// person to pick one. The link never carries a credential: the code is single
// use, expires, and only names which connection the sign-in is for.

const HOSTED_ORIGIN = "https://room.trydemigod.com";
const CODE = /^RM-[A-Za-z0-9_-]{4,120}$/;

export const CONNECT_PARAM = "connect";

export function validConnectCode(code) {
  return typeof code === "string" && CODE.test(code);
}

function base(origin) {
  return String(origin || HOSTED_ORIGIN).replace(/\/$/, "");
}

// The two addresses an agent needs for one connection: the readable page and
// the MCP URL that binds sign-in to this invite.
export function connectLinkFor({ origin, code }) {
  if (!validConnectCode(code)) throw new TypeError("connect code must look like RM-...");
  const root = base(origin);
  const encoded = encodeURIComponent(code);
  const mcpUrl = `${root}/mcp?${CONNECT_PARAM}=${encoded}`;
  return Object.freeze({
    pageUrl: `${root}/a/${encoded}`,
    mcpUrl,
    commands: Object.freeze({
      claude: `claude mcp add --transport http project-room '${mcpUrl}'`,
      codex: `codex mcp add project-room --url '${mcpUrl}'`,
      chatgpt: `Add a connector with this URL: ${mcpUrl}`,
    }),
  });
}

// Reads the connect hint from an /mcp or /oauth/authorize URL. Anything that
// is not a well-formed code is ignored rather than echoed.
export function connectHintFrom(url) {
  let parsed;
  try { parsed = url instanceof URL ? url : new URL(String(url), HOSTED_ORIGIN); }
  catch { return null; }
  const direct = parsed.searchParams.get(CONNECT_PARAM);
  if (validConnectCode(direct)) return direct;
  const resource = parsed.searchParams.get("resource");
  if (resource) {
    try {
      const inner = new URL(resource).searchParams.get(CONNECT_PARAM);
      if (validConnectCode(inner)) return inner;
    } catch { /* not a URL */ }
  }
  return null;
}

const PERMISSION_WORDS = Object.freeze({
  chat: "chat in the room",
  contribute: "take tasks",
  review: "review work",
  collaborate: "do everything except manage people",
});

function clean(value, max) {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[^\P{C}]/gu, "").trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

// What the consent screen shows for a hinted sign-in. A dead, used or
// malformed code returns null, and the caller shows the ordinary screen, so
// the screen never reveals whether a room exists.
export function consentContextFor(preview, code) {
  if (!validConnectCode(code) || !preview || typeof preview !== "object") return null;
  if (Number.isFinite(preview.expiresAt) && preview.expiresAt <= Date.now()) return null;
  const room = clean(preview.title, 120) || clean(preview.roomId, 120);
  if (!room) return null;
  const can = PERMISSION_WORDS[preview.profile] || "use the permissions on the invite";
  const agent = clean(preview.displayName, 80);
  return Object.freeze({
    code,
    roomId: String(preview.roomId ?? ""),
    heading: agent ? `Connect ${agent} to ${room}` : `Connect this agent to ${room}`,
    line: `This sign-in is for one invite. The agent will be able to ${can}.`,
  });
}
