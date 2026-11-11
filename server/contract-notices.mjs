// Contract-change notices (flag ROOM_CONTRACT_NOTICES, off by default).
//
// Research basis (50-agent-needs Page): agents whose work passes alone often
// break when combined; a single structured "this interface changed" notice
// recovered most such failures. Room already records the dependency edge:
// a Board claim's `dependsOn` lists claims that must finish first, and
// `parentClaimId` names the claim whose output it builds on (it does not block
// claiming, so it is the usual live edge). When a claim
// links a pull request, every live claim that depends on it gets one
// structured room post naming the PR and the touched paths, and its agent
// owner is woken. No new storage: the post id is stable per
// (upstream claim, pull, dependent claim), so repeats are no-ops.
//
// ROOM_CONTRACT_NOTICES: off | on | comma-separated room ids.
// ROOM_CONTRACT_PATHS (optional): comma-separated interface globs
// (e.g. "src/events.js,server/mcp-hosted-tools.mjs,spec/**,docs/openapi.yaml").
// When set, a notice is sent only if the upstream claim's declared files or
// the pull's files touch one of them; when a claim declares no files at all
// the notice still goes out (we cannot prove the interface is untouched).

import { appendRoomEvent, stableEventId } from "./receipt-cards.mjs";
import { enqueueClaimWake } from "./work-claim-events.mjs";
import { ownMember } from "../src/events.js";

const FLAG = "ROOM_CONTRACT_NOTICES";
const PATHS = "ROOM_CONTRACT_PATHS";
// Real claim states (server/work-claims.mjs STATES); delivered work has not merged yet.
const LIVE = new Set(["unclaimed", "claimed", "in_progress", "blocked", "delivered"]);

function envOf(store) {
  return store && Object.hasOwn(store, "featureEnv") ? store.featureEnv : (globalThis.process?.env ?? {});
}

export function contractNoticesEnabled(store, roomId) {
  const bag = envOf(store);
  const raw = bag && typeof bag[FLAG] === "string" ? bag[FLAG].trim() : "";
  if (raw === "on" || raw === "1" || raw === "true") return true;
  if (!raw || raw === "off" || raw === "0" || raw === "false") return false;
  return raw.split(",").map(part => part.trim()).filter(Boolean).includes(roomId);
}

export function interfaceGlobs(store) {
  const raw = envOf(store)?.[PATHS];
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw.split(",").map(part => part.trim()).filter(Boolean).slice(0, 64);
}

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { out += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function pathMatchesInterface(path, globs) {
  return globs.some(glob => {
    if (!glob.includes("*") && !glob.includes("?")) return path === glob || path.startsWith(`${glob.replace(/\/$/, "")}/`) || glob.startsWith(`${path.replace(/\/$/, "")}/`);
    return globToRegExp(glob).test(path);
  });
}

function pullsOf(claim) {
  return Array.isArray(claim?.pullRequests) && claim.pullRequests.length ? claim.pullRequests : (claim?.pullRequest ? [claim.pullRequest] : []);
}

export function pullUrlOf(pull) {
  const url = typeof pull === "string" ? pull : pull?.url;
  return typeof url === "string" && url ? url : null;
}

export function touchedPaths(claim) {
  const paths = new Set();
  for (const path of claim?.files ?? []) if (typeof path === "string" && path.trim()) paths.add(path.trim());
  for (const pull of pullsOf(claim)) for (const path of [...(pull?.files ?? []), ...(pull?.changedFiles ?? [])]) if (typeof path === "string" && path.trim()) paths.add(path.trim());
  for (const path of claim?.changedFiles ?? []) if (typeof path === "string" && path.trim()) paths.add(path.trim());
  return [...paths].sort();
}

// Pure: which dependents should hear about `upstream`'s pulls.
// Returns [{ dependent, pullUrl, paths, interfacePaths }].
export function contractNoticePlan(upstream, claims, globs = []) {
  if (!upstream?.id) return [];
  const pulls = pullsOf(upstream).map(pullUrlOf).filter(Boolean);
  if (pulls.length === 0) return [];
  const paths = touchedPaths(upstream);
  const interfacePaths = globs.length ? paths.filter(path => pathMatchesInterface(path, globs)) : paths;
  if (globs.length && paths.length > 0 && interfacePaths.length === 0) return [];
  const plan = [];
  for (const claim of claims ?? []) {
    if (!claim || claim.id === upstream.id || !LIVE.has(claim.state)) continue;
    const depends = Array.isArray(claim.dependsOn) && claim.dependsOn.includes(upstream.id);
    if (!depends && claim.parentClaimId !== upstream.id) continue;
    if (typeof claim.owner !== "string" || !claim.owner) continue;
    if (claim.owner === upstream.owner) continue;
    for (const pullUrl of pulls) plan.push({ dependent: claim, pullUrl, paths, interfacePaths });
  }
  return plan;
}

const plain = value => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[<>`]/g, "").slice(0, 200);

export function noticeBody(upstream, entry, members = {}) {
  const who = plain(ownMember(members ?? {}, upstream.owner)?.displayName) || "an agent";
  const shown = (entry.interfacePaths.length ? entry.interfacePaths : entry.paths).slice(0, 8).map(plain);
  const lines = [
    `Contract change: ${who} linked ${plain(entry.pullUrl)} on ${plain(upstream.id)}.`,
    `Your task ${plain(entry.dependent.id)} builds on ${plain(upstream.id)} (${entry.dependent.parentClaimId === upstream.id ? "parentClaimId" : "dependsOn"}).`,
    shown.length ? `Touched paths: ${shown.join(", ")}${entry.paths.length > shown.length ? ` (+${entry.paths.length - shown.length} more)` : ""}.` : "Touched paths: not declared on the claim.",
    "Re-check your work against this change before you merge."
  ];
  return lines.join("\n");
}

// After a claim is saved with a linked pull. Idempotent; never throws.
export function notifyContractChanges(store, roomId, upstream) {
  try {
    if (!contractNoticesEnabled(store, roomId)) return [];
    if (!store?.room || !store?.workClaims?.list) return [];
    const claims = store.workClaims.list(roomId);
    const room = store.room(roomId);
    const members = room?.state?.members ?? {};
    const ownerId = room?.state?.room?.ownerId;
    const author = ownMember(members, ownerId);
    if (!author || author.active === false) return [];
    const sent = [];
    for (const entry of contractNoticePlan(upstream, claims, interfaceGlobs(store))) {
      const material = `${roomId}\0contract\0${upstream.id}\0${entry.pullUrl}\0${entry.dependent.id}`;
      const messageId = stableEventId("cn", material);
      try {
        // Every later claim write re-runs this; a notice already posted
        // returns null and must not wake the dependent again.
        const posted = appendRoomEvent(store, roomId, { id: messageId, type: "message.posted", actorId: author.id,
          data: { messageId, body: noticeBody(upstream, entry, members) } });
        if (!posted) continue;
        if (ownMember(members, entry.dependent.owner)?.kind === "agent") {
          enqueueClaimWake(store, roomId, entry.dependent.owner, messageId, { reason: "contract_change", actorId: author.id });
        }
        sent.push(messageId);
      } catch (error) {
        console.error("contract notice failed:", error?.message ?? error);
      }
    }
    return sent;
  } catch (error) {
    console.error("contract notice failed:", error?.message ?? error);
    return [];
  }
}
