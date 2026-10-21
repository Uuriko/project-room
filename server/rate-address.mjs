// Per-address rate keys for IPv6 (research r175; account-login form r176).
// An IPv6 client normally holds a whole /64, so keying a per-address limit by
// the full /128 lets one caller rotate through 2^64 fresh budgets. Rate ids of
// the form "<family>:<IPv6 address>" are keyed by the /64 instead. IPv4,
// IPv4-mapped IPv6 and every non-address id (account ids, credential hashes,
// "<family>:<address>:<suffix>") are returned unchanged.
import { isIP } from "node:net";

function expandIPv6(address) {
  const [head, tail = null] = address.split("::");
  const part = text => (text ? text.split(":") : []);
  const left = part(head), right = tail === null ? [] : part(tail);
  const fill = tail === null ? [] : new Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map(group => group.padStart(4, "0").toLowerCase());
}

export function ipv6RatePrefix(address) {
  if (isIP(address) !== 6 || address.includes(".") || address.includes("%")) return null;
  const groups = expandIPv6(address);
  if (groups.length !== 8) return null;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

// The rate-key form of one client address: an IPv6 address (bare or in URL
// brackets) becomes its /64; anything else is returned unchanged. Call sites
// that put more than the address in a rate id ("<family>:<address>:<suffix>")
// use this directly, since rateAddressKey only reads "<family>:<address>" (r176).
export function rateAddressPart(address) {
  if (typeof address !== "string") return address;
  const prefix = ipv6RatePrefix(address.replace(/^\[(.*)\]$/, "$1"));
  return prefix ?? address;
}

export function rateAddressKey(id) {
  const colon = id.indexOf(":");
  if (colon <= 0) return id;
  // cloudflare/room.mjs hands IPv6 visitors over as URL hostnames ("[2001:db8::1]").
  const address = id.slice(colon + 1);
  const part = rateAddressPart(address);
  return part === address ? id : `${id.slice(0, colon + 1)}${part}`;
}
