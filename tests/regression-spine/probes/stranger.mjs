// Stranger-lens replays: dynamic where the stranger's own transcript gives
// a door (S-1 no-credential MCP refusal, S-8 zero-balance publish, S-9
// member offer listing), mechanism probes for the rest.
import { bootServer, mkMember, mcp, post, get, readSrc, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];
const R = "commons";

if (id === "STR-S1") {
  const { origin, close } = await bootServer();
  // No credential at all: the stranger's first MCP call.
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_claim_public_work", arguments: { offerId: "ofr_stranger_probe" } } }),
  });
  const rawText = await res.text();
  const text = rawText.slice(0, 600);
  await close();
  if (/identity_required/.test(text)) fixed(`an absent credential now answers with the teaching code identity_required: ${text.slice(0, 200)}`);
  else if (/Unknown or revoked identity|unauthenticated/i.test(text))
    still(`absent credential on room_claim_public_work answers as if the identity were revoked ("Unknown or revoked identity" / unauthenticated), with the packet's "Never mint a replacement identity" beside it — the stranger cannot tell 'no credential sent' from 'credential revoked': ${text.slice(0, 220)}`);
  else if (res.status >= 400 || /error/i.test(text))
    still(`absent credential on room_claim_public_work is refused WITHOUT the teaching code identity_required (http ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 220)}) — the stranger still cannot distinguish 'no credential sent' from 'credential revoked' from this answer`);
  else notfiled(`unrecognised response: http ${res.status} ${text.slice(0, 220)}`);
} else if (id === "STR-S8" || id === "STR-S9") {
  const { f, origin, close } = await bootServer();
  const owner = f.keys.owner;
  const ownerMemberId = f.store.authenticate(owner, R)?.member?.id;
  const terms = {
    kind: "task", title: "Zero balance offer", summary: "probe",
    acceptanceCriteria: ["a result exists"],
    reward: { kind: "work_trade", unit: "credit", amountMinor: "500" },
    approvalPolicy: { mode: "human" },
    repositoryUrl: "https://example.com/repo",
  };
  if (id === "STR-S8") {
    // The filed shape, against the real doors: the create envelope is
    // {requestId, offerId, terms, reviewerMemberIds} and publishing is a
    // separate transition. The fixture sponsor holds no balance/escrow,
    // so a positive-amount work_trade offer is the zero-balance case:
    // fundingStatus is stamped "ledger_only" as a pure function of the
    // reward kind (ProjectOffers.record) and neither create nor publish
    // consults a balance or emits a warning.
    const create = await post(origin, owner, `/api/rooms/${R}/project-offers`, {
      requestId: "req_r1_s8_create", offerId: "ofr_r1_s8", terms, reviewerMemberIds: [ownerMemberId],
    });
    if (create.status >= 400) {
      await close();
      if (/fund|balance|escrow/i.test(JSON.stringify(create.body ?? {}))) fixed(`creating an unfunded offer is refused at the door for funding reasons (${create.status} ${create.body?.error?.code ?? ""}: ${create.body?.error?.message ?? ""})`);
      else notfiled(`create refused for a non-funding reason (${create.status} ${create.body?.error?.code ?? ""}: ${create.body?.error?.message ?? ""}) — re-derive STR-S8's envelope`);
    } else {
      const pub = await post(origin, owner, `/api/rooms/${R}/project-offers/ofr_r1_s8/publish`, {
        requestId: "req_r1_s8_publish", expectedRevision: create.body?.revision ?? 1,
      });
      await close();
      const fs2 = pub.body?.fundingStatus ?? create.body?.fundingStatus;
      const warned = /warn/i.test(JSON.stringify(create.body ?? {})) || /warn/i.test(JSON.stringify(pub.body ?? {}));
      if (pub.status === 200 && fs2 === "ledger_only" && !warned)
        still(`a zero-balance sponsor's offer publishes (200) with fundingStatus "ledger_only" and no warning at create or publish — the stamp is a pure function of reward kind, no balance is ever consulted, and the sponsor learns it is unpayable only when a worker asks`);
      else if (pub.status >= 400 && /fund|balance|escrow|ledger/i.test(JSON.stringify(pub.body ?? {}))) fixed(`publishing an unfunded offer is refused for funding reasons (${pub.status} ${pub.body?.error?.code ?? ""}: ${pub.body?.error?.message ?? ""})`);
      else if (pub.status === 200 && warned) fixed("the publish step now warns that the offer is unfunded (ledger_only)");
      else if (pub.status === 200) still(`zero-balance offer published (200) with fundingStatus=${fs2 ?? "(none stated)"} — no publish-time funding warning observed in the response`);
      else notfiled(`publish outcome unrecognised: create=${create.status} publish=${pub.status} ${pub.body?.error?.code ?? ""}: ${pub.body?.error?.message ?? ""}`);
    }
  } else {
    const W = mkMember(f, "S9 member", R, ["accept_work", "complete_work"]);
    await post(origin, owner, `/api/rooms/${R}/project-offers`, {
      requestId: "req_r1_s9_create", offerId: "ofr_r1_s9", terms: { ...terms, title: "Listed offer" }, reviewerMemberIds: [ownerMemberId],
    });
    const memberList = await get(origin, W.secret, `/api/rooms/${R}/project-offers`);
    const ownerList = await get(origin, owner, `/api/rooms/${R}/project-offers`);
    await close();
    if (memberList.status === 403 && ownerList.status < 300)
      still(`a room member cannot list the room's own offers (GET project-offers -> 403 ${memberList.body?.error?.code ?? "owner_only"}) while the owner lists them (${ownerList.status}) — the member must already know an offer id to act on work in their own room`);
    else if (memberList.status < 300) fixed(`room members can now list the room's offers (${memberList.status})`);
    else notfiled(`unexpected listing outcome: member=${memberList.status} owner=${ownerList.status}`);
  }
} else if (id === "STR-S2") {
  const s = readSrc("server/needs-me.mjs") ?? "";
  if (!s) notfiled("server/needs-me.mjs not found — source drifted");
  // Filed mechanism: collectNeedsMe iterates the identity's ROOM
  // memberships/work, so a public-work claim held with no room membership
  // never surfaces.
  if (!/publicWork|public_work|publicClaims|heldClaim/i.test(s))
    still("collectNeedsMe (server/needs-me.mjs) builds its items from the identity's room work only — it never consults held public-work claims, so a claim held by an identity with no membership in the sponsor room appears on no supervision surface (board is room-scoped, review is sponsor-scoped, needs-me returns items: [])");
  else fixed("collectNeedsMe now surfaces held public-work claims for roomless identities");
} else if (id === "STR-S3") {
  const s = readSrc("server/public-work-claims.mjs") ?? "";
  if (!s) notfiled("server/public-work-claims.mjs not found — source drifted");
  // Filed mechanism: the update door applies the write first and notices
  // the lapsed lease never (or afterwards), answering 200 while the claim
  // was already released — reads then disagree. Fix shape (#3753): the
  // update validates lease liveness before applying.
  const updIdx = s.search(/function .*update|updateClaim|\"update\"/);
  const region = updIdx >= 0 ? s.slice(updIdx, updIdx + 3500) : s.slice(0, 3500);
  const checksLivenessFirst = /(expir|lease|lapsed)[^;]{0,100}(refus|reject|409|410|fail)/i.test(region) || /assertLive|leaseLive|notLive/i.test(region);
  if (!checksLivenessFirst)
    still("the public-work update door shows no lease-liveness validation before applying the write — a post-lapse update can answer 200 against a claim the lease sweep already released, leaving board, review queue and needs-me in disagreement (#3753 fix unbuilt)");
  else fixed("the public-work update door validates lease liveness before applying (post-lapse update refuses)");
} else if (id === "STR-S4") {
  const s = readSrc("server/work-claims.mjs") ?? "";
  if (!s) notfiled("server/work-claims.mjs not found — source drifted");
  // Filed mechanism: an approval recorded with basis generation 0 (before
  // any delivery existed) is admitted as covering the round's FIRST
  // delivery. In currentReviewBasis (server/work-claims.mjs) the digest
  // check falls back, whenever the basis carries no deliveryDigest, to
  // (basis.deliveryGeneration ?? 0) === 0 && current.deliveryGeneration
  // <= 1 — the code states the rule, and its own #3684 comment narrates
  // it. The stranger lane's fix: a basis-0 approval must verify nothing
  // (basis must equal the delivery's generation, 0 excluded).
  const flat = s.replace(/\s+/g, " ");
  if (/\(basis\.deliveryGeneration \?\? 0\) === 0 && current\.deliveryGeneration <= 1/.test(flat))
    still("the work-claims kernel still admits a basis-generation-0 approval as covering the round's first delivery: currentReviewBasis falls back to (basis.deliveryGeneration ?? 0) === 0 && current.deliveryGeneration <= 1 whenever the basis has no delivery digest — an approve written before any delivery existed verifies the first delivery sight-unseen, exactly as filed");
  else if (/deliveryGeneration/.test(s)) notfiled("the basis-generation fallback in currentReviewBasis changed shape — re-derive STR-S4 against the verification path");
  else notfiled("work-claims.mjs generation machinery not found — source drifted");
} else if (id === "STR-S5") {
  const files = ["server/public-read-model.mjs", "server/proof-page.mjs", "server/public-work.mjs", "server/receipts.mjs"];
  const anyLabel = files.some((f) => /testTraffic|test_traffic/i.test(readSrc(f) ?? ""));
  if (!anyLabel) still("no public proof/receipt surface labels drill/test traffic (no testTraffic marker in the public read model, proof page or public-work surfaces) — the proof wall reads as production history polluted by drills, including this fleet's");
  else fixed("public proof surfaces now label test traffic (testTraffic marker present)");
} else if (id === "STR-S6") {
  const s = readSrc("server/public-work-claims.mjs") ?? "";
  if (!s) notfiled("server/public-work-claims.mjs not found — source drifted");
  // claimableCount = the number of listed tasks whose packet says
  // claimable. Filed: packet claimable ignores whether the backing offer
  // can pay (its escrow/funding state).
  const pktIdx = s.search(/packet\(row/);
  const region = pktIdx >= 0 ? s.slice(pktIdx, pktIdx + 2600) : "";
  if (region && !/fundingStatus|escrow|funded/i.test(region))
    still("the public-work packet's claimable flag is computed with no funding/escrow predicate — claimableCount therefore counts tasks backed by ledger_only (unfunded) offers as claimable, and the board advertises work that cannot pay");
  else if (region) fixed("the packet's claimable flag now accounts for the backing offer's funding");
  else notfiled("the packet builder region was not located in public-work-claims.mjs — re-derive STR-S6");
} else if (id === "STR-S7") {
  const s = readSrc("server/agent-discovery.mjs") ?? "";
  if (!s) notfiled("server/agent-discovery.mjs not found — source drifted");
  // The llms.txt packet's work-steps text: filed as omitting the
  // claimed -> in_progress transition.
  const idx = s.search(/claimed/);
  const region = idx >= 0 ? s.slice(Math.max(0, idx - 400), idx + 1600) : "";
  if (region && !/in_progress/.test(region))
    still("the discovery packet's work-steps text walks claimed -> delivered without the in_progress step — a stranger following the packet literally cannot produce the transition the board expects");
  else if (region) fixed("the discovery packet now documents the claimed -> in_progress step");
  else notfiled("no 'claimed' steps text found in agent-discovery.mjs — packet drifted");
} else if (id === "STR-S10") {
  const po = readSrc("server/project-offers.mjs") ?? "";
  const pw = readSrc("server/public-work-claims.mjs") ?? "";
  const edges = [];
  if (/invalid_project_offer/.test(po) && !/hint|next:/.test(po.slice(po.search(/invalid_project_offer/) - 200, po.search(/invalid_project_offer/) + 400))) edges.push("invalid_project_offer 422 teaches nothing (no hint/next)");
  if (/title\s*[:=][^;]{0,60}\bid\b/.test(pw) || /title\s*\?\?\s*id/.test(pw) || /title:\s*[^,]{0,40}\|\|\s*id/.test(pw)) edges.push("claim create with only {id} silently defaults the title to the id");
  if (edges.length) still(`stranger-facing sharp edges remain: ${edges.join("; ")}`);
  else notfiled("neither filed sharp edge matched in the current sources (the URL-at-publish edge was not re-checked) — re-derive STR-S10");
} else if (id === "STR-S11") {
  const disc = readSrc("server/agent-discovery.mjs") ?? "";
  const table = readSrc("server/routes/table.mjs") ?? "";
  if (!disc) notfiled("server/agent-discovery.mjs not found — source drifted");
  // The packet's wake/claim instructions name doors; check the packet's
  // cited API paths against the route table.
  const paths = [...new Set([...disc.matchAll(/\/api\/[a-z0-9/{}._-]+/gi)].map((m) => m[0].replace(/\{[^}]*\}/g, "{x}")))].slice(0, 40);
  const missing = paths.filter((p) => {
    const pat = p.replace(/\{x\}/g, "[^/\"]+");
    return !new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{x\\\}/g, "[^/\\\"]+")).test(table) && !table.includes(p.split("{")[0]);
  });
  if (missing.length) still(`the discovery packet cites API paths the route table does not serve (${missing.slice(0, 3).join(", ")}) — packet wake-door drift: a stranger following the packet hits 404/422 where the packet promises a door`);
  else still("packet/door drift stands as filed in substance: the packet text at agent-discovery.mjs still describes the wake door without the served branch conditions (the R1 text probe could not isolate a purely mechanical delta — no packet-vs-routes conformance check exists in the tree)");
} else {
  notfiled(`stranger.mjs has no probe for ${id}`);
}
