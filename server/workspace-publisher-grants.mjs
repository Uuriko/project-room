import { createHash, randomBytes } from "node:crypto";

const grantLifetimeMs = 10_000;
const grantLimit = 64;
const digest = value => createHash("sha256").update(value).digest("hex");

// Only the local broker redeems. These short-lived grants are not Room keys.
export function createWorkspacePublisherGrants(now = Date.now) {
  const grants = new Map();
  return {
    issue(selection, isCurrent) {
      const time = now();
      for (const [key, issued] of grants) if (issued.expiresAt <= time) grants.delete(key);
      if (grants.size >= grantLimit) return null;
      const grant = randomBytes(32).toString("hex");
      const expiresAt = time + grantLifetimeMs;
      grants.set(digest(grant), { selection, isCurrent, expiresAt });
      return { ...selection, grant, expiresAt };
    },
    consume(grant, expected) {
      if (typeof grant !== "string" || !/^[a-f0-9]{64}$/.test(grant)) return null;
      const key = digest(grant), issued = grants.get(key);
      grants.delete(key);
      if (!issued || issued.expiresAt <= now() || !expected ||
          Object.entries(issued.selection).some(([field, value]) => expected[field] !== value)) return null;
      try { return issued.isCurrent() ? issued.selection : null; }
      catch { return null; }
    },
    revoke(selection) {
      for (const [key, issued] of grants) {
        if (Object.entries(selection).every(([field, value]) => issued.selection[field] === value))
          grants.delete(key);
      }
    },
    clear() { grants.clear(); },
  };
}
