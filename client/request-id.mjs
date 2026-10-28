import { createHash } from "node:crypto";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .filter(key => value[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

export function deriveRequestId(tool, identity, args) {
  const input = canonical({ tool, roomId: identity?.roomId ?? null, memberId: identity?.memberId ?? null, arguments: args });
  return `mcp-${createHash("sha256").update(input).digest("hex")}`;
}

export function withDerivedRequestId(tool, args, identity) {
  if (!args || typeof args !== "object" || Array.isArray(args) || args.requestId !== undefined
      || typeof identity?.roomId !== "string" || typeof identity?.memberId !== "string") return args;
  return { ...args, requestId: deriveRequestId(tool, identity, args) };
}
