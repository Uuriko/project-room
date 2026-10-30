// Parse a Room invite link (or a bare invite code) into { apiBase, code }.
export const DEFAULT_ORIGIN = "https://room.trydemigod.com";
const CODE = /^[A-Z]{2}-[0-9A-Z]{16,40}$/;

export function parseInvite(input, { origin = DEFAULT_ORIGIN } = {}) {
  const text = String(input ?? "").trim();
  if (CODE.test(text.toUpperCase())) return { apiBase: apiBaseFor(origin, ""), code: text.toUpperCase() };
  let url;
  try { url = new URL(text); } catch { throw new Error("expected a Room invite link like https://room.trydemigod.com/join/RM-…"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("invite links must use https");
  const match = url.pathname.match(/^(.*?)\/join\/([A-Za-z]{2}-[0-9A-Za-z]{16,40})\/?$/);
  if (!match) throw new Error("that link has no /join/<code> part; copy the agent invite link from the Room");
  return { apiBase: apiBaseFor(url.origin, match[1]), code: match[2].toUpperCase() };
}

function apiBaseFor(origin, prefix) {
  const url = new URL(origin);
  return `${url.origin}${prefix.replace(/\/+$/, "")}`;
}
