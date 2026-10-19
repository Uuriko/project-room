// Docs / catalogue / UI-copy / suite probes: TRUTH-F1..F3, API-F1/F2,
// HUMAN-H1..H6/A-1/A-2, FRONTEND-F1..F5, SCALE-1/3/4/5 (the #4122 cliffs),
// RACE-R1 (the #4124 suite), ZOMBIE-Z5 (the #4120 deletions), API-F3.
import { execSync } from "node:child_process";
import { bootServer, get, readSrc, runNode, ROOT, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];
const grepCount = (pattern, paths) => {
  try { return Number(execSync(`grep -r "${pattern}" ${paths} | wc -l`, { cwd: ROOT, encoding: "utf8", shell: "/bin/bash" }).trim()) || 0; } catch { return 0; }
};

switch (id) {
  case "TRUTH-F1": {
    const s = readSrc("docs/FAQ.md") ?? "";
    if (!s) notfiled("docs/FAQ.md not found");
    else if (/funds are only released on acceptance/i.test(s) && /No real funds move without explicit owner approval/i.test(s)) still("docs/FAQ.md still tells strangers the pre-#4103 story (funds 'only released on acceptance', 'no real funds move without explicit owner approval') — false since the keeper settles automatically; the correction rides open PR #4121 only");
    else fixed("the FAQ bounty paragraph now describes automatic keeper settlement (PR #4121's correction is in the tree)");
    break;
  }
  case "TRUTH-F2": {
    const s = readSrc("docs/DATA-BOUNDARIES.md") ?? "";
    if (!s) notfiled("docs/DATA-BOUNDARIES.md not found");
    else if (/makes no outbound network calls/i.test(s)) still("docs/DATA-BOUNDARIES.md §4 still claims the hosted service makes no outbound network calls — falsified by the tree's own outbound call sites (webhooks, gmail sync, OG fetch); the FINISH-docs correction is unlanded");
    else fixed("the DATA-BOUNDARIES outbound-calls claim has been corrected");
    break;
  }
  case "TRUTH-F3": {
    let s = "";
    try { s = readSrc("about.html") ?? readSrc("public/about.html") ?? ""; } catch { s = ""; }
    if (!s) { try { s = execSync(`grep -rl "every finished result" --include="*.html" .`, { cwd: ROOT, encoding: "utf8" }).trim().split("\n")[0] ? readSrc(execSync(`grep -rl "every finished result" --include="*.html" .`, { cwd: ROOT, encoding: "utf8" }).trim().split("\n")[0].replace("./", "")) ?? "" : ""; } catch { s = ""; } }
    if (/every finished result ends in a public receipt/i.test(s)) still("the about page hero still promises every finished result ends in a public receipt — false for result-mode work in rooms that never opted in (and for opted-out lots); the corrected copy exists only in open PR #4151");
    else if (s) fixed("the about hero no longer overpromises public receipts");
    else notfiled("about page / hero line not located in the tree — re-derive TRUTH-F3");
    break;
  }
  case "API-F1": {
    const a = grepCount("terms_changed", "skills/project-room/references/errors-catalog.md plugins/ 2>/dev/null");
    const b = grepCount("invalid_proof_query", "skills/project-room/references/errors-catalog.md plugins/ 2>/dev/null");
    if (a >= 2 && b >= 2) fixed(`both HTTP-emitted codes are catalogued in both copies (terms_changed x${a}, invalid_proof_query x${b} across skills + plugins mirror) — PR #4144's catalogue half is in the tree`);
    else still(`HTTP-emitted codes are still missing from the errors catalogue (terms_changed hits=${a}, invalid_proof_query hits=${b} across the two bound copies; the server emits both — 409 from legal, 422 from proof)`);
    break;
  }
  case "API-F2": {
    const y = readSrc("docs/openapi.yaml") ?? "";
    if (!y) notfiled("docs/openapi.yaml not found");
    const check = (() => { try { return execSync(`ls scripts/ tests/ | grep -iE "openapi.*(drift|sync|check)|drift.*openapi"`, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } })();
    const ops = (y.match(/operationId/g) ?? []).length;
    if (check) fixed(`an openapi drift/sync check exists (${check.split("\n")[0]}) — spec drift is machine-caught`);
    else notfiled(`openapi.yaml carries ${ops} operationIds (formalism partly present) but no drift/sync check was found in scripts/ or tests/, and the lane's specific formalism gaps need its list to re-verify one by one — R2 item; note the companion catalogue fix (API-F1) is absent at this tree, so PR #4144's formalism half is not confirmed landed either`);
    break;
  }
  case "API-F3": {
    const { origin, close } = await bootServer();
    const spec = await get(origin, null, "/openapi.json");
    await close();
    // Isolate the share-link preview operation inside the served spec and
    // look for origin wording inside THAT operation only.
    const paths = spec.body?.paths ?? {};
    const shareKey = Object.keys(paths).find((k) => /share/.test(k) && /preview|link/.test(k)) ?? Object.keys(paths).find((k) => /share/.test(k));
    const opJson = shareKey ? JSON.stringify(paths[shareKey]) : "";
    if (spec.status === 200 && shareKey && !/origin/i.test(opJson)) still(`the served /openapi.json operation ${shareKey} describes the origin-gated share-link door with no origin restriction stated anywhere in the operation — a stranger integrating against the spec builds against a door that refuses their origin (chartered fix unbuilt)`);
    else if (spec.status === 200 && shareKey) fixed(`the served spec's ${shareKey} operation now states its origin restriction`);
    else notfiled(`served spec probe inconclusive: http ${spec.status}, share operation found: ${Boolean(shareKey)}`);
    break;
  }
  case "API-F4": {
    const y = readSrc("docs/openapi.yaml") ?? "";
    if (!y) notfiled("docs/openapi.yaml not found");
    const both = (y.match(/'401'/g) ?? []).length > 0 && (y.match(/'422'/g) ?? []).length > 0;
    if (both) still("session-bound operations in docs/openapi.yaml still document both 401 and 422 for the same doors, and which one fires remains per-family folklore — an integrator cannot tell an expired session from a malformed request from the spec");
    else fixed("the spec now separates session-expiry (401) from validation (422) per family");
    break;
  }
  case "SCALE-1":
  case "SCALE-3":
  case "SCALE-4":
  case "SCALE-5": {
    // The cliffs are statement-count explosions: the read materialises
    // the whole collection and slices afterwards, so a LIMIT at the
    // response edge does not cure them (cliff 1 was measured WITH
    // limit:1). Verified at the API while building this pack: the cure
    // PR #4122 is OPEN, not merged — so the mechanism check is whether
    // the module's primary collection read is bounded at the query, not
    // at the slice. A full statement-count bench is the R2 upgrade.
    const targets = {
      "SCALE-1": "server/work-claims-read.mjs",
      "SCALE-3": "server/public-read-model.mjs",
      "SCALE-4": "server/proof-page.mjs",
      "SCALE-5": "server/public-read-model.mjs",
    }[id];
    const s = readSrc(targets) ?? "";
    if (!s) notfiled(`${targets} not found — source layout drifted for ${id}`);
    const slicesAfterFetch = /\.all\(\)/.test(s) && /\.slice\(/.test(s);
    const queryBounded = /SELECT[^;]{0,220}LIMIT/i.test(s);
    if (slicesAfterFetch && !queryBounded)
      still(`${id}: ${targets} still fetches its collection with .all() and slices in memory — the statement explosion is in the materialisation, before any response limit applies; the cure (PR #4122) is open, not in this tree`);
    else if (queryBounded && !slicesAfterFetch) fixed(`${id}: the primary collection read in ${targets} is bounded at the query (LIMIT in the SELECT) — the #4122 cure shape is present`);
    else notfiled(`${id}: ${targets} mixes bounded and unbounded reads (queryBounded=${queryBounded} slicesAfterFetch=${slicesAfterFetch}) — separate the surfaces by hand`);
    break;
  }
  case "RACE-R1": {
    let files = "";
    try { files = execSync(`ls tests/ | grep -iE "request-outcome|claim.*idempot|idempot.*claim"`, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { files = ""; }
    const named = files.split("\n").filter(Boolean).map((f) => `tests/${f}`);
    const extra = (() => { try { return execSync(`grep -rl "round" tests/ --include="*.test.js" | xargs grep -l "idempot" 2>/dev/null | head -3`, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } })();
    const suites = [...new Set([...named, ...extra.split("\n").filter(Boolean)])].slice(0, 3);
    if (!suites.length) notfiled("no claim-idempotency suite identified in tests/ — re-derive RACE-R1's pin");
    const run = await runNode(["--test", ...suites], { timeoutMs: 420000 });
    const out = run.out + run.err;
    const fail = /ℹ fail (\d+)/.exec(out)?.[1];
    if (fail === "0") fixed(`the claim idempotency ledger's round-scoping is pinned by a passing shipped suite (${suites.join(", ")}) — PR #4124's fix is in the tree and green`);
    else if (fail !== undefined) still(`the round-scoping suite fails at this tree (fail=${fail}) — the ledger still replays outcomes across claim rounds`);
    else notfiled(`suite run produced no summary: ${out.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 240)}`);
    break;
  }
  case "FE-F1": {
    const s = (readSrc("src/board-ui.js") ?? "") + (readSrc("src/work-claims-ui.js") ?? "");
    if (/requestId|idempotency/i.test(s)) fixed("the board create path now sends a client request id (PR #4142's idempotency half is in the tree) — a double-submit replays instead of duplicating");
    else if (s) still("the board 'New item' create still sends no requestId/idempotency key from the client — a double-click or retry mints two items (the server half of #4142 may exist; the client half does not)");
    else notfiled("board UI sources not found — re-derive FE-F1");
    break;
  }
  case "FE-F2": {
    const s = (readSrc("src/board-ui.js") ?? "") + (readSrc("src/bounty-board.js") ?? "");
    if (!s) notfiled("board UI sources not found");
    const cardRegion = (() => { const i = s.search(/leaseExpiresAt|expiresAt/); return i >= 0 ? s.slice(i, i + 3000) : ""; })();
    if (!cardRegion || !/expired/i.test(cardRegion)) still("the board card rendering never branches on lease expiry — an expired-lease card renders with the same live state and actions as an active one, contradicting itself (the claim is dead; the card still invites work on it)");
    else if (/expired/i.test(cardRegion) && /(disabled|released|renew)/i.test(cardRegion)) fixed("expired-lease cards now render a distinct state with honest actions");
    else notfiled("an expiry branch exists in the card region but its actions are unclear — re-derive FE-F2");
    break;
  }
  case "FE-F3": {
    const s = readSrc("src/board-ui.js") ?? "";
    if (!s) notfiled("src/board-ui.js not found");
    // The verify/deliver requestId builders: check what components the
    // id is joined from.
    const builders = [...s.matchAll(/\["(verify|deliver)",\s*([^\]]{0,160})\]/g)].map((m) => m[0]);
    if (!builders.length) notfiled("no verify/deliver requestId builders found in board-ui.js — re-derive FE-F3");
    else if (builders.every((b) => /deliveryGeneration|claimedAt|round/i.test(b))) fixed(`client verify/deliver request ids incorporate the claim round (${builders[0].slice(0, 110)}) — a re-claim's new round cannot collide with the old round's recorded outcome`);
    else still(`client verify/deliver request ids are built without the claim round (${builders[0].slice(0, 110)}) — after a release and re-claim, the new round's verify/deliver collides with the old round's recorded outcome and replays it (client half of RACE-R-1)`);
    break;
  }
  case "FE-F4":
  case "FE-F5": {
    let file = null;
    try { file = execSync(`grep -rl "class DraftRecovery" src/ | head -1`, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { file = ""; }
    const s = file ? readSrc(file) ?? "" : "";
    if (!s) notfiled("DraftRecovery source not located in src/ — re-derive");
    // Scope every check to the class itself: other files import and use
    // DraftRecovery (and hold lookalike drafts.entries code) without
    // defining its persistence behaviour.
    const clsAt = s.search(/class DraftRecovery/);
    const cls = clsAt >= 0 ? s.slice(clsAt, clsAt + 16000) : "";
    if (!cls) notfiled("class DraftRecovery not isolated — re-derive");
    else if (id === "FE-F4") {
      // The persistence cap (write() in the class): entries are sliced
      // from the Map's iteration (insertion = first-creation) order; an
      // edit re-sets an existing key without moving it, so the cap
      // evicts by first creation, not last write.
      const save = /\[...drafts\.entries\][^;]{0,160}/.exec(cls)?.[0] ?? /drafts\.entries[^;]{0,160}/.exec(cls)?.[0] ?? "";
      if (/slice\(-\d+\)/.test(save) && !/sort/.test(save)) still(`DraftRecovery (${file}) still evicts by first creation: its write path keeps ${save.match(/slice\(-\d+\)/)?.[0]} of the entries Map in insertion order with no last-write sort — the draft edited a minute ago is evicted before one untouched since creation whenever it was created earlier (PR #4143 unbuilt)`);
      else if (/sort/.test(save) && /updatedAt|lastWrite|editedAt/.test(save)) fixed("DraftRecovery's save path now orders by last write before capping");
      else notfiled(`DraftRecovery save shape not isolated: ${save.slice(0, 120)} — re-derive FE-F4`);
    } else {
      // read()'s failure path: every failure (JSON.parse error, oversize,
      // scope/expiry) lands in the single outer catch, which clears the
      // whole store — clear() removes the v1, v2 and v3 keys — instead
      // of quarantining the one corrupt entry.
      const flat = cls.replace(/\s+/g, " ");
      if (/JSON\.parse\(raw\)/.test(flat) && /catch \{ this\.clear\(\); return null; \}/.test(flat) && /clear\(\) \{[^;]{0,80}removeItem/.test(flat))
        still(`DraftRecovery (${file}) still destroys drafts wholesale on a parse failure: read()'s only failure path is its outer catch (this.clear(); return null) and clear() removes every drafts version key (v1/v2/v3) — one corrupt entry wipes all recoverable drafts instead of being quarantined (fix PR #4146 is queued, not in the tree)`);
      else if (/JSON\.parse/.test(flat)) fixed("DraftRecovery's parse-failure path no longer wipes the whole store");
      else notfiled("no JSON.parse path found in DraftRecovery — re-derive FE-F5");
    }
    break;
  }
  case "HUMAN-H1": {
    const s = readSrc("src/bounty-board.js") ?? "";
    if (/Accept &(amp;)? release escrow/.test(s)) still("the bounty board button still reads 'Accept & release escrow' (src/bounty-board.js, the accept action's label) — one click labelled as acceptance that also releases the money, with no separation of the two acts (PR #4155's copy fix is queued, not in the tree)");
    else if (s) fixed("the accept/release copy has been separated or corrected");
    else notfiled("src/bounty-board.js not found");
    break;
  }
  case "HUMAN-H3": {
    const s = readSrc("src/bounty-board.js") ?? "";
    if (/preset/i.test(s) && /(verdict|pass)/i.test(s.slice(Math.max(0, s.search(/preset/) - 600), s.search(/preset/) + 600))) still("the rubric UI still couples verdict to preset (selecting the verdict pre-selects the Pass preset) — the form grades itself before the human reads the work (PR #4155 queued)");
    else if (s) notfiled("the verdict/preset coupling did not match — re-derive HUMAN-H3");
    else notfiled("src/bounty-board.js not found");
    break;
  }
  case "HUMAN-H4": {
    const s = readSrc("src/bounty-board.js") ?? "";
    if (/Attributed/.test(s) && !/(attributed means|held in escrow until|explainer|title="[^"]{20,})/i.test(s)) still("the ledger's 'Attributed' state still appears in the money panel with no in-situ explanation — a human cannot tell attributed from paid without leaving the surface (PR #4155's explainer is queued)");
    else if (/Attributed/.test(s)) fixed("the Attributed state now carries an in-panel explanation");
    else notfiled("'Attributed' not found in bounty-board.js — re-derive HUMAN-H4");
    break;
  }
  case "HUMAN-H2":
  case "HUMAN-H5":
  case "HUMAN-H6": {
    const board = readSrc("src/bounty-board.js") ?? "";
    const room = (readSrc("src/room.js") ?? "") + (readSrc("src/app.js") ?? "");
    if (id === "HUMAN-H2") {
      if (board && !/(escrow|bounty|credits)/i.test(room.slice(0, 200000))) still("the room's main surface still carries no money vocabulary at all — the money surface lives four disclosures deep in the bounty board, so a human can use the room for days without learning money exists here (design item, unbuilt)");
      else notfiled("room surface sources did not match the filed shape — re-derive HUMAN-H2");
    } else if (id === "HUMAN-H5") {
      const form = /(claim|submit)[^"]{0,40}(form|button|btn)/i.test(board) && /human|member/i.test(board);
      if (!form) still("a human worker still has no UI for the work loop: claim and submit exist only as API/MCP doors — the board shows bounties to humans but gives them no way to take or deliver one (API-only as filed)");
      else fixed("a human claim/submit path now exists in the board UI");
    } else {
      if (board && !/(how escrow works|held until|released when|before you post)/i.test(board)) still("the bounty post form still teaches nothing before commitment — no line explains escrow, holding or release before the poster commits funds (copy item, unbuilt)");
      else if (board) fixed("the post form now explains escrow before commitment");
      else notfiled("src/bounty-board.js not found");
    }
    break;
  }
  case "HUMAN-A1": {
    const s = readSrc("index.html") ?? "";
    if (!s) notfiled("index.html not found");
    const mainIdx = s.search(/<main/);
    const authIdx = s.search(/auth|sign-in|signin/i);
    if (mainIdx > authIdx && authIdx >= 0) still("the signed-out page still presents sign-in inside a <section> while the only <main> landmark belongs to the hidden signed-in app — a screen-reader user lands on a page with no main landmark (index.html as filed)");
    else if (mainIdx >= 0 && mainIdx < authIdx) fixed("the sign-in view now sits inside the <main> landmark");
    else notfiled("index.html landmark shape unclear — re-derive HUMAN-A1");
    break;
  }
  case "HUMAN-A2": {
    const s = readSrc("src/styles.css") ?? "";
    if (!s) notfiled("src/styles.css not found");
    const fw = /\.composer-row:focus-within\s*\{([^}]*)\}/.exec(s)?.[1] ?? "";
    if (fw && /border-color/.test(fw) && !/outline|box-shadow/.test(fw)) still(`the composer focus indicator is still a border-colour change alone (.composer-row:focus-within { ${fw.trim().replace(/\s+/g, " ").slice(0, 90)} }) against the app's own 2px outline standard elsewhere — keyboard users get the weakest focus signal on the most-used control`);
    else if (fw) fixed("the composer focus indicator now meets the app's outline standard");
    else notfiled(".composer-row:focus-within rule not found — styles drifted");
    break;
  }
  case "ZOMBIE-Z5": {
    // #4120's R-2/R-3 zero-risk deletions: named in zombie.md as the
    // receipts-live-era dead routes/modules. Probe the two most concrete:
    // the legacy /api/receipts-live route and the parked /orient alias —
    // both were ruled deleted; Z-2 covers /orient separately, so here:
    // the duplicate agent-signin page + legacy board route family.
    const http = readSrc("server/http.mjs") ?? "";
    const gone = !/receipts-live/.test(http);
    if (gone) fixed("the R-2/R-3 deletion set's HTTP surface is absent from http.mjs (PR #4120's deletions are observable in the tree)");
    else still("receipts-live-era dead surface still dispatched from http.mjs — the zero-risk deletion set (PR #4120) is not observable in the tree");
    break;
  }
  default:
    notfiled(`docs-suites.mjs has no probe for ${id}`);
}
