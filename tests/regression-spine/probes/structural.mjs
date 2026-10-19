// Bulk mechanism probes for findings whose filed repro is a code-reading
// (source/text/workflow surfaces). Each check names the filed mechanism and
// the fix shape; a source that matches neither reports NOTFILED honestly.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readSrc, srcHas, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];
const has = (rel, re) => srcHas(rel, re);

switch (id) {
  case "SM-F3": {
    const s = readSrc("server/project-offers.mjs") ?? "";
    if (!s) notfiled("server/project-offers.mjs not found");
    // Filed: terms.deadline is validated at create and never read again.
    const reads = (s.match(/deadline/g) ?? []).length;
    const enforced = /deadline[^;]{0,90}(past|expired|before|<=|>=|Date\.now|now\(\))/i.test(s.replace(/deadline must|deadline is|invalid[^;]{0,60}deadline/gi, ""));
    if (!enforced) still(`offer terms.deadline is validated at create and never enforced (no deadline-vs-now comparison in project-offers.mjs; ${reads} mentions, all validation-side) — claims and settlement proceed past a dead offer's deadline`);
    else fixed("offer deadline is now compared against the clock somewhere in the offer lifecycle");
    break;
  }
  case "SM-F4": {
    const jobs = readSrc("server/jobs.mjs") ?? "";
    const conns = readSrc("server/agent-connections.mjs") ?? "";
    const scanOwns = /access[-_ ]?request/i.test(jobs) && /expir/i.test(jobs);
    if (!scanOwns && /expir/i.test(conns)) still("access-request expiry is lazy-only: agent-connections.mjs checks expiry when a request is read, but no job in server/jobs.mjs owns an expiry scan — expired requests sit live until something happens to read them");
    else if (scanOwns) fixed("a job now owns the access-request expiry scan");
    else notfiled("neither lazy-expiry nor a scan matched — re-derive SM-F4");
    break;
  }
  case "RACE-S1": {
    const s = readSrc("server/claim-pr-sync.mjs");
    if (s === null) notfiled("server/claim-pr-sync.mjs not found — source drifted");
    else notfiled("not classified mechanically: claim-pr-sync.mjs carries revision checks on its land/deploy close path (the closes settle only rows whose revision is live), but whether the PR-sync sweep's board write-backs are fenced against fresher board state could not be isolated from the close path by a source probe — R2 re-derives with charter 07's stale-snapshot construction");
    break;
  }
  case "LOSS-2": {
    const s = readSrc("server/messages-store.mjs") ?? "";
    if (!/pruneMessages/.test(s)) notfiled("pruneMessages not found in messages-store.mjs");
    else if (/pruneMessages/.test(s) && /parity|certif/i.test(s.slice(s.search(/pruneMessages/), s.search(/pruneMessages/) + 2500))) fixed("the prune path now carries the parity-certification gate (#4133 shape in tree)");
    else still("pruneMessages still prunes against a possibly stale/torn projection with no parity-certification gate in its path — the guard built in PR #4133 (charter: verify the projection is certified before pruning) is not in the tree");
    break;
  }
  case "LOSS-3": {
    const sites = [["server/agent-plugin-store.mjs", 2], ["server/inbox-stitch-store.mjs", 1], ["server/updates.mjs", 1], ["server/channel-drain.mjs", 1]];
    const surfaced = sites.every(([f]) => /(parseSkip|skippedParse|reportSkip|onParseError|parseErrors)/.test(readSrc(f) ?? ""));
    const silent = sites.filter(([, _]) => true).length;
    if (!surfaced) still(`the #4088-family silent parse-skips stand: the cited sites (agent-plugin-store x2, inbox-stitch-store, updates, channel-drain) share no counted parse-skip surfacing — a skipped record vanishes without a counter or log line (charter 01 unbuilt)`);
    else fixed("the parse-skip sites now surface a counted skip signal");
    break;
  }
  case "LOSS-4": {
    const s = readSrc("server/work-item-board.mjs") ?? "";
    if (!s) notfiled("server/work-item-board.mjs not found");
    // Scoped to the merge itself: mergeReviews caps via MAX_REVIEWS = 50
    // (slice(-MAX_REVIEWS)) and returns only the array; check whether the
    // module attaches any total/truncation field for reviews specifically.
    else if (/MAX_REVIEWS = 50/.test(s) && /slice\(-MAX_REVIEWS\)/.test(s) && !/(reviewsTotal|totalReviews|reviewsTruncated|reviewsOmitted)/.test(s)) still("board reviews are union-capped at MAX_REVIEWS = 50 (mergeReviews returns slice(-MAX_REVIEWS)) and no total/truncation field for reviews exists anywhere in work-item-board.mjs — the 51st review silently ceases to exist on the board (charter 10 unbuilt)");
    else if (/(reviewsTotal|totalReviews|reviewsTruncated|reviewsOmitted)/.test(s)) fixed("the reviews union now reports its total/truncation");
    else notfiled("the mergeReviews cap region did not match either shape — re-derive LOSS-4");
    break;
  }
  case "LOSS-5": {
    const s = readSrc("server/channel-send-budgets.mjs") ?? "";
    if (!s) notfiled("server/channel-send-budgets.mjs not found");
    else if (/catch\s*\{\s*return \{\}/.test(s)) still("channel-send-budgets still substitutes an empty budget state on any read error (catch { return {} }) — a corrupt budget record silently resets send limits instead of failing loudly");
    else fixed("the empty-state substitution on read error is gone from channel-send-budgets.mjs");
    break;
  }
  case "ORPH-C2":
  case "ORPH-C3": {
    const s = readSrc("server/purge-registry.mjs");
    if (s === null) notfiled("server/purge-registry.mjs not found — source drifted");
    else if (id === "ORPH-C2" && !/public_work_requests/.test(s)) still("the purge registry has no row for public_work_requests — no deletion path reaches the table, and its stored idempotency outcomes replay after a purge (PR #4150 unbuilt)");
    else if (id === "ORPH-C3" && !/analytics_events|analytics_room_cursor|claim_bond_shadow/.test(s)) still("the purge registry names none of the analytics shadows (analytics_events, analytics_room_cursor, claim_bond_shadow) — a room purge leaves its analytics shadow rows behind (PR #4150 unbuilt)");
    else fixed(`the purge registry now covers ${id === "ORPH-C2" ? "public_work_requests" : "the analytics shadow tables"} (PR #4150 shape in tree)`);
    break;
  }
  case "TM-2": {
    const rst = readSrc("server/restore-ndjson.mjs") ?? "";
    const audit = readSrc("server/operator-actions.mjs") ?? "";
    const preserves = /(pre-restore|snapshot|preserve|retain)[^;]{0,80}(audit|operator)/i.test(rst) || /appendOperatorAction/.test(rst);
    // The audit trail is a table in the same store the restore replaces;
    // the filed defect holds unless the restore itself preserves or
    // records outside that replacement.
    if (audit && !preserves) still("the operator audit trail lives in the same store that restore replaces wholesale (server/operator-actions.mjs's table), and restore-ndjson.mjs neither preserves the pre-restore trail nor appends its own operator_actions record — a restore erases the evidence of every prior operator action, including exports and earlier restores");
    else if (preserves) fixed("restore now preserves or records the audit trail across the swap");
    else notfiled("operator-actions module not found — re-derive TM-2");
    break;
  }
  case "TM-5": {
    const prm = readSrc("server/public-read-model.mjs") ?? "";
    if (!prm) notfiled("server/public-read-model.mjs not found");
    else if (!/(signature|signReceipt|ed25519)/i.test(prm)) still("public receipts carry no signature (no signing in the public read model) — a receipt is exactly as trustworthy as the server that serves it, with no external anchor a stranger can verify (Stage 4 signing unbuilt)");
    else fixed("public receipts are now signed at projection");
    break;
  }
  case "TM-6": {
    const node = (readSrc("server/http.mjs") ?? "") + (readSrc("server/agent-discovery.mjs") ?? "");
    const worker = readSrc("cloudflare/room.mjs") ?? "";
    const guard = /(isPrivate|privateIp|ssrf|blockPrivate|127\.0\.0\.1|169\.254)/i;
    const inNode = guard.test(node), inWorker = guard.test(worker);
    if (inNode !== inWorker) still(`SSRF controls diverge by runtime: the private-address guard is present on ${inNode ? "the Node side" : "the Workers side"} and absent on the other — the same product refuses a fetch in one runtime and allows it in the other`);
    else if (!inNode && !inWorker) still("no private-address/SSRF guard found on either runtime's fetch path — the divergence finding stands in its stronger form");
    else fixed("both runtimes carry the SSRF guard");
    break;
  }
  case "TM-9": {
    const checks = {
      attestationGate: has("server/agent-identities.mjs", /linked member|member of the room/i),
      verifyConservationCaller: has("server/bounty-epoch-keeper.mjs", /verifyConservation/),
      restoreAudit: has("server/restore-ndjson.mjs", /appendOperatorAction|operator_actions/),
    };
    const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) still(`designed posture != running posture: ${missing.length}/3 designed controls are absent from the running tree (${missing.join(", ")}) — the threat model's mitigations describe a system that is not the one deployed`);
    else fixed("all three designed controls are present in the tree");
    break;
  }
  case "TM-11": {
    const parts = [];
    if (!has("server/restore-ndjson.mjs", /appendOperatorAction/) && !has("server/room-export.mjs", /appendOperatorAction/)) parts.push("the whole-store export/restore doors write no operator_actions row (ADV-P4)");
    if (!has("server/legal-routes.mjs", /operator_actions/)) parts.push("operator unpublish writes no central operator_actions row (ADV-P7)");
    const quar = readSrc(".github/workflows/zero-bug-quarantine.yml");
    if (quar !== null && !/^\s*permissions:/m.test(quar)) parts.push("the zero-bug-quarantine workflow carries no permissions block at all — default token permissions for a detection-only gate (DEP-1)");
    if (parts.length >= 2) still(`the residual knowns bundle stands: ${parts.join("; ")}`);
    else notfiled(`only ${parts.length} residual components matched — re-derive TM-11`);
    break;
  }
  case "DEP-1": {
    const s = readSrc(".github/workflows/zero-bug-quarantine.yml");
    if (s === null) notfiled("zero-bug-quarantine workflow not found in the tree");
    else if (!/^\s*permissions:/m.test(s)) still("the zero-bug-quarantine workflow declares no permissions block at all — a detection-only gate runs with the repository's default (write-capable) token permissions instead of an explicit read-only grant");
    else if (/permissions:\s*\n(\s+[a-z-]+:\s*(read|none)\s*\n?)+/m.test(s) && !/write/.test(s.slice(s.search(/permissions:/), s.search(/permissions:/) + 300))) fixed("the quarantine workflow now declares explicit read-only permissions");
    else still("the quarantine workflow's permissions block still grants a write scope");
    break;
  }
  case "ECON-3": {
    const s = readSrc("server/project-offers.mjs") ?? "";
    if (!s) notfiled("server/project-offers.mjs not found");
    const capIdx = s.search(/100|cap/i);
    const region = capIdx >= 0 ? s.slice(Math.max(0, capIdx - 500), capIdx + 800) : "";
    if (/room/i.test(region) && !/(operator|account|global|across rooms)/i.test(region)) still("the 100-offer lifetime cap (#3608) is counted per room only — nothing counts an operator's offers across rooms or surfaces, so the cap is evaded by reposting across rooms exactly as the economics lane proved (within-surface counting itself is honest)");
    else if (/(operator|account)/i.test(region)) fixed("the offer cap now counts across rooms per operator");
    else notfiled("the cap region did not match either shape — re-derive ECON-3");
    break;
  }
  case "SCALE-2": {
    const s = readSrc("server/work-claims-read.mjs") ?? readSrc("server/work-item-board.mjs") ?? "";
    if (/LIMIT|paginate|pageSize/i.test(s)) notfiled("board read shows a LIMIT/pagination marker — recheck SCALE-2 by hand (charter C-1 may have landed a partial cure)");
    else still("the board read still materialises the full claims set before answering (no LIMIT/pagination in the read path) — board cost grows linearly with room history (charter C-1 unbuilt)");
    break;
  }
  case "SCALE-6": {
    const s = readSrc("server/public-read-model.mjs") ?? "";
    const clamp = /LIMIT 1000|limit\s*=\s*1000|1000/.test(s);
    const signalled = /(total|hasMore|truncated)/i.test(s.slice(Math.max(0, s.search(/1000/) - 500), s.search(/1000/) + 500));
    if (clamp && !signalled) still("a public surface still clamps at 1,000 receipts silently (LIMIT present, no total/hasMore/truncation signal beside it) on top of the sitemap N+1 — past 1,000 receipts the public record just stops, indistinguishably from complete (charter C-2 unbuilt)");
    else if (!clamp) notfiled("no 1,000-clamp marker found in the public read model — re-derive SCALE-6");
    else fixed("the 1,000-receipt clamp now carries a completeness signal");
    break;
  }
  case "SOAK-S2": {
    const s = readSrc("cloudflare/room.mjs") ?? "";
    if (!s) notfiled("cloudflare/room.mjs not found — source drifted");
    else if (/finally/.test(s) && /armJobAlarm|Alarm/.test(s.slice(s.search(/finally/), s.search(/finally/) + 600))) still("ProjectRoom.fetch still re-arms the job alarm in a finally block on every request — the alarm re-arm tax (a 5-table earliestFutureAlarm scan per request) is paid by all traffic, not just job traffic (cure WU-5 held)");
    else notfiled("the fetch/finally alarm-arm shape did not match — re-derive SOAK-S2");
    break;
  }
  case "SOAK-S5": {
    const s = readSrc("server/project-offers.mjs") ?? "";
    // Find the lifetime-cap count itself (the #3608 check): the COUNT over
    // the room's offers that the create path compares to the cap.
    const m = /COUNT\(\*\)[^;]{0,200}project_offers[^;]{0,200}/i.exec(s) ?? /project_offers[^;]{0,120}COUNT/i.exec(s);
    const region = m ? m[0] : "";
    if (region && !/(status|state)\s*(=|IN|NOT)/i.test(region)) still(`the offer lifetime cap counts rows without excluding drafts/withdrawn (count: ${region.replace(/\s+/g, " ").slice(0, 150)}) — every saved draft and withdrawn offer burns the room's 100-offer lifetime budget (cf. ECON-3's cap surface)`);
    else if (region) notfiled(`the cap count carries a state predicate (${region.replace(/\s+/g, " ").slice(0, 130)}) — whether drafts specifically are excluded needs the lane's construction; R2 item`);
    else notfiled("the lifetime-cap count was not located in project-offers.mjs — re-derive SOAK-S5");
    break;
  }
  case "WATCH-P4": {
    const { execSync } = await import("node:child_process");
    let refs = "";
    try { refs = execSync(`grep -rl "watcher-health" server/ cloudflare/ scripts/ --include="*.mjs"`, { cwd: ROOT, encoding: "utf8" }); } catch { refs = ""; }
    const files = refs.trim().split("\n").filter(Boolean);
    if (files.length <= 1) still(`watcher-health exists but is invoked by nothing (referenced only from: ${files.join(", ") || "itself"}) — a working health probe with no caller is indistinguishable from no probe (GC-5 absorption unlanded)`);
    else fixed(`watcher-health now has callers: ${files.join(", ")}`);
    break;
  }
  case "WATCH-P6":
  case "WATCH-P7":
  case "WATCH-P8":
  case "WATCH-P10": {
    let names = [];
    try { names = readdirSync(join(ROOT, ".github", "workflows")); } catch { names = []; }
    if (!names.length) notfiled("no .github/workflows directory in the target tree");
    if (id === "WATCH-P8") {
      const zombies = names.filter((n) => /^(apply|assemble|reset)-/.test(n));
      if (zombies.length) still(`${zombies.length} one-shot dispatch workflows still sit in the tree (${zombies.slice(0, 4).join(", ")}${zombies.length > 4 ? ", …" : ""}) — each is a standing manual trigger with production reach and no owner`);
      else fixed("the one-shot apply/assemble/reset workflows are gone from the tree");
    } else if (id === "WATCH-P10") {
      if (names.some((n) => /feature-tour/.test(n))) still("the agentic-feature-tour workflow is still in the tree on its daily cron with no delivery destination — it tours, finds, and tells no one");
      else notfiled("agentic-feature-tour does not appear among the tree's workflows at this baseline — whether it was deleted (fixed) or moved off-repo cannot be distinguished locally; R2 confirms against the Actions census");
    } else if (id === "WATCH-P6") {
      if (names.some((n) => /mirror/.test(n))) still("repo-mirror-refresh is still in the tree; its failure reports have no destination in the workflow (no notify/issue step) — and its first-ever run is still ahead of it");
      else notfiled("repo-mirror-refresh does not appear among the tree's workflows at this baseline — whether it was deleted (fixed) or lives outside the repo census cannot be distinguished locally; R2 confirms against the Actions census");
    } else {
      const scheduled = names.filter((n) => /cron|schedule/i.test(readSrc(join(".github", "workflows", n).replace(ROOT, "")) ?? readSrc(`.github/workflows/${n}`) ?? ""));
      if (scheduled.length) still(`${scheduled.length} scheduled workflows sit in the tree (${scheduled.slice(0, 4).join(", ")}) with no in-tree reader for their outcomes — the watcher census finding stands: schedules run, nobody reads`);
      else notfiled("no scheduled workflows identified by content scan — re-derive WATCH-P7");
    }
    break;
  }
  case "ZOMBIE-Z2": {
    if (has("server/http.mjs", /\/orient/) || has("server/routes/table.mjs", /orient/)) still("the /orient endpoint is still dispatched in the server — a retired front door that still answers (its replacement shipped; the old door was never closed)");
    else fixed("/orient is no longer dispatched");
    break;
  }
  case "ZOMBIE-Z3": {
    const shim = has("server/public-read-model.mjs", /receipts-live/) || has("server/http.mjs", /receipts-live/) || has("server/routes/table.mjs", /receipts-live/);
    const prefixes = has("server/http.mjs", /project-room\//);
    if (shim || prefixes) still(`the receipts-live shim / triple-prefix serving is still in the tree (shim markers: ${shim}, /project-room/ prefix handling: ${prefixes}) — the B20/D10 staged sunset has not started`);
    else fixed("the receipts-live shim and prefix aliases are gone");
    break;
  }
  case "ZOMBIE-Z4": {
    const wakes = readSrc("server/work-wakes.mjs") !== null && readSrc("server/wake-queue.mjs") !== null;
    const table = readSrc("server/routes/table.mjs") ?? "";
    const attention = /activity-read|notifications/.test(table);
    const exhibits = [wakes && "WorkWakes dual modules (work-wakes.mjs + wake-queue.mjs both live, D11)", attention && "attention families still separate route families (D12)"].filter(Boolean);
    if (exhibits.length) still(`Phase-2 §D exhibits still unexecuted: ${exhibits.join("; ")} — SIMPLIFY's narrowed builds (D11 verify-and-report only, D12 delete-only) are queued, not landed`);
    else fixed("the named §D exhibits have been executed");
    break;
  }
  case "ZOMBIE-Z1": {
    const s = readSrc("server/public-read-model.mjs") ?? "";
    if (!s) notfiled("server/public-read-model.mjs not found");
    else if (/optIn|opt_in|ownerOptIn/i.test(s)) fixed("settled-lot receipts now require an owner opt-in at projection (#3594 finished)");
    else still("settled-lot receipts are still public by default at projection — the #3594 opt-in decision (owner must opt IN) is not implemented in the public read model (PR #4151 carries copy only; the default never flipped)");
    break;
  }
  default:
    notfiled(`structural.mjs has no probe for ${id}`);
}
