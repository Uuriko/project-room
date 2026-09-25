// Shared SSRF IP blocklist (RC-2026-09-25, H-1/M-1).
//
// One canonical place for "is this IP literal in a range we never dial":
// private, loopback, link-local, multicast, reserved, documentation, CGNAT,
// benchmarking space, plus every IPv4-embedded-in-IPv6 form (mapped, NAT64
// incl. local-use /48, 6to4, deprecated v4-compatible) and Teredo. Used by
// the web-fetch path (server/web-fetch.mjs) and the webhook path
// (server/outbound-webhooks.mjs, server/webhook-dispatch.mjs) so a
// hardening fix can never land in one and miss the other again — that is
// exactly how the webhook IPv6 bypass shipped while web-fetch was safe.
//
// Also home to pinnedLookup (the dns.lookup-compatible function that only
// answers with already-checked addresses) and isWorkersRuntime (pinning is
// a Node-only defence; on Workers the egress sandbox is the backstop).
// Pure: no I/O, no imports, safe on Node and Workers.

// Strict dotted-quad -> uint32, or null.
export function parseIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

// Parse IPv6 (with :: compression and embedded IPv4) into a 128-bit BigInt,
// or null when it is not valid IPv6. Brackets are stripped so "[::1]" works.
export function parseIpv6(host) {
  let h = host.replace(/^\[|\]$/g, "");
  // IPv4-mapped tail: ::ffff:1.2.3.4
  let tail = null;
  const lastColon = h.lastIndexOf(":");
  if (lastColon !== -1 && h.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(h.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    h = h.slice(0, lastColon + 1) + "0:0";
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (left.length + right.length > 8) return null;
  const groups = [...left, ...new Array(8 - left.length - right.length).fill("0"), ...right];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail) n = (n & ~0xffffn) | BigInt(tail[0]) << 16n | BigInt(tail[1]);
  return n;
}

const IPV4_BLOCKS = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata lives here)
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 documentation (TEST-NET-1)
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 documentation (TEST-NET-2)
  [0xcb007100, 24], // 203.0.113.0/24 documentation (TEST-NET-3)
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved
];
const IPV6_BLOCKS = [
  [0n, 128], // ::/128 unspecified
  [1n, 128], // ::1/128 loopback
  [0xfe800000000000000000000000000000n, 10], // fe80::/10 link-local
  [0xfc000000000000000000000000000000n, 7], // fc00::/7 unique local
  [0xff000000000000000000000000000000n, 8], // ff00::/8 multicast
  [0x20010db8000000000000000000000000n, 32], // 2001:db8::/32 documentation
  [0x20010000000000000000000000000000n, 32], // 2001::/32 Teredo (tunnels to arbitrary v4)
  [0x0064ff9b000100000000000000000000n, 48], // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
];
// Prefixes that carry an IPv4 address inside the IPv6 one. The embedded
// address inherits the IPv4 verdict, so 64:ff9b::a00:1 (NAT64 for 10.0.0.1)
// or 2002:a00:1:: (6to4 for 10.0.0.1) cannot reach a private v4 host.
// Each entry: [prefix, bits, extract(v6) -> embedded v4].
const IPV6_EMBEDDED_V4 = [
  [0xffff00000000n, 96, v6 => Number(v6 & 0xffffffffn)], // ::ffff:0:0/96 IPv4-mapped
  [0x0064ff9b000000000000000000000000n, 96, v6 => Number(v6 & 0xffffffffn)], // 64:ff9b::/96 NAT64 (RFC 6052)
  [0x20020000000000000000000000000000n, 16, v6 => Number((v6 >> 80n) & 0xffffffffn)], // 2002::/16 6to4
  [0n, 96, v6 => Number(v6 & 0xffffffffn)], // ::/96 IPv4-compatible (deprecated)
];
const ipv4In = (ip, [base, bits]) => (ip >>> (32 - bits)) === (base >>> (32 - bits));
const ipv6In = (ip, [base, bits]) => (ip >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));

// Block verdict for an already-parsed IPv4 uint32.
export function isBlockedIpv4Value(v4) {
  return IPV4_BLOCKS.some(block => ipv4In(v4, block));
}

// Block verdict for an already-parsed IPv6 BigInt. Embedded IPv4 (mapped,
// NAT64, 6to4, v4-compatible) inherits the IPv4 verdict; everything else is
// checked against the IPv6 blocks. Callers that cannot parse (zone IDs,
// garbage) must fail closed themselves — this function only answers for
// values parseIpv6 accepted.
export function isBlockedIpv6Value(v6) {
  // :: and ::1 are their own blocked addresses (they also sit in ::/96).
  if (v6 === 0n || v6 === 1n) return true;
  for (const [prefix, bits, extract] of IPV6_EMBEDDED_V4) {
    if (!ipv6In(v6, [prefix, bits])) continue;
    return isBlockedIpv4Value(extract(v6) >>> 0);
  }
  return IPV6_BLOCKS.some(block => ipv6In(v6, block));
}

// The IPv4 address embedded in an IPv6 literal (mapped, NAT64, 6to4,
// v4-compatible), as a uint32 — or null when the literal carries none.
export function extractEmbeddedIpv4(host) {
  const v6 = parseIpv6(host);
  if (v6 === null) return null;
  for (const [prefix, bits, extract] of IPV6_EMBEDDED_V4) {
    if (!ipv6In(v6, [prefix, bits])) continue;
    return extract(v6) >>> 0;
  }
  return null;
}

// True when a string is an IP literal in a blocked range. Non-IP hostnames
// and unparseable strings return false here — they go through DNS
// resolution (or fail closed at the caller's literal gate) instead.
export function isBlockedIp(host) {
  const v4 = parseIpv4(host);
  if (v4 !== null) return isBlockedIpv4Value(v4);
  const v6 = parseIpv6(host);
  if (v6 !== null) return isBlockedIpv6Value(v6);
  return false;
}

// A dns.lookup-compatible function that only ever answers with addresses
// that already passed the blocklist check, whatever name it is asked for.
// This closes the rebinding window: a short-TTL record that flips to a
// private address after the check is never consulted again.
export function pinnedLookup(addresses) {
  const checked = addresses.map(address => ({ address, family: parseIpv4(address) !== null ? 4 : 6 }));
  return (_hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options ? options : {};
    if (!checked.length) return cb(Object.assign(new Error("no checked address"), { code: "ENOTFOUND" }));
    if (opts.all) return cb(null, checked);
    return cb(null, checked[0].address, checked[0].family);
  };
}

// Cloudflare Workers: outbound fetch() runs in the Workers egress sandbox,
// which cannot reach the host's private network, and the Workers fetch API
// has no way to pin a connection to an address. There the DNS pre-check is
// best-effort. Everywhere else (Node / self-hosted) the checks above are
// the whole SSRF defence, so they fail closed and the connection is pinned.
export const isWorkersRuntime = () => typeof navigator !== "undefined"
  && navigator?.userAgent === "Cloudflare-Workers";
