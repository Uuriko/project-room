// Room-side knowledge router (RC-2026-09-24-310): competitive mining of Firecrawl's
// Alexandria launch ("the knowledge library for superintelligence", Sept 22, 2026).
//
// What we stole, deliberately:
//   1. Plan-first, cost-visible routing. Alexandria's real mechanic is not an opaque
//      server-side router (none is publicly documented) but agent-driven progressive
//      disclosure: discovery is free, the agent sees per-source costs before executing.
//      POST /api/web/research mirrors that: `planOnly: true` returns the plan with
//      per-source cost notes without spending any quota; the full call executes the
//      plan and reports what it cost.
//   2. Provenance receipts on every evidence item. Every returned fact carries
//      { source, url, final_url, retrieved_at, content_sha256, bytes, cache, request_id }
//      so room agents can cite evidence and the room's receipts/reputation thesis can
//      consume it. Alexandria publishes no provenance mechanics; this schema is ours.
//   3. Developer-Index-style typed result ids: `room:<key8>`, `doc:<path>`,
//      `fetch:<sha8>`, `alexandria:<sha8>` — kind-prefixed stable ids, matched
//      passages, and an explicit "not indexed" vs "no results" distinction.
//
// What we did NOT steal: opaque LLM routing (deterministic planner, no model), their
// 21% eval methodology (vendor-run, unreproduced — see research brief), per-key scopes
// (they don't have them; the room does).
//
// Sources in v1:
//   - room:     the room's own fetch memory — keyword search over web_fetch_cache.
//               Alexandria can never see this; it is the room's moat.
//   - docs:     local markdown corpus (docs/, README.md, CHANGELOG.md). Node only;
//               skipped gracefully on Workers / when unreadable.
//   - fetch:    explicit URLs through the existing WebFetch service (SSRF-hardened,
//               cached, journaled). Each URL bills web-fetch quota — Alexandria-like
//               credit semantics: planning is free, execution costs.
//   - provider: env-pluggable registry. `alexandria` reads ALEXANDRIA_API_KEY from
//               the environment (never from code, never logged). Without a key the
//               plan reports the leg as unconfigured instead of failing.
//
// Auth is owner + full members only, same posture as POST /api/web/fetch (the HTTP
// layer applies the #798 guest gate). Storage is purely additive (web_research_log,
// IF NOT EXISTS, no schema version bump), following the web-fetch additive pattern.
// The research question itself is never journaled — only its sha256 — consistent with
// "full page content is never journaled".
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WebFetchError,
  extractHighlights,
  isWorkersRuntime,
} from "./web-fetch.mjs";

const fail = (status, code, message, extra) => { throw new WebFetchError(status, code, message, extra); };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
export const WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY = 50;
export const WEB_RESEARCH_RATE_PER_ROOM_PER_DAY = 500;
export const WEB_RESEARCH_RATE_WINDOW_MS = 86_400_000;
export const WEB_RESEARCH_MAX_QUESTION_CHARS = 2000;
export const WEB_RESEARCH_MAX_EVIDENCE = 20;
export const WEB_RESEARCH_DEFAULT_EVIDENCE = 5;
export const WEB_RESEARCH_MAX_URLS = 10;
export const WEB_RESEARCH_MAX_TAGS = 20;
export const WEB_RESEARCH_TAG_CHARS = 64;
export const WEB_RESEARCH_SOURCES = ["room", "docs", "fetch", "provider"];
export const WEB_RESEARCH_DOCS_MAX_FILES = 300;
export const WEB_RESEARCH_DOCS_MAX_BYTES = 1024 * 1024;
export const WEB_RESEARCH_DOCS_MAX_FILE_BYTES = 200 * 1024;
export const WEB_RESEARCH_CACHE_SCAN_LIMIT = 200;

const STOPWORDS = new Set(
  "a,an,the,and,or,but,of,to,in,on,for,with,by,from,at,as,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,can,could,should,what,when,where,which,who,whom,whose,why,how,this,that,these,those,it,its,they,them,their,there,here,not,no,yes,if,then,than,so,such,into,out,up,down,over,under,about,between,through,during,before,after,my,your,his,her,our,you,we,they,i,me,him,us,any,all,some,more,most,other,same,own,just,like,get,got,make,made,use,used,using,also,well,much,many,may,might,must,shall".split(",")
);

export function researchKeywords(question, max = 8) {
  const seen = [];
  for (const token of String(question || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 3 || STOPWORDS.has(token) || seen.includes(token)) continue;
    seen.push(token);
    if (seen.length >= max) break;
  }
  return seen;
}

export function hasRecencySignal(question) {
  const q = String(question || "").toLowerCase();
  return /\b(20\d{2}|v\d+|latest|today|yesterday|breaking|announce\w*|launch\w*|releas\w*|recent\w*|just)\b/.test(q);
}

// ---------------------------------------------------------------------------
// Schema (additive)
// ---------------------------------------------------------------------------
export const webResearchSchema = `
  CREATE TABLE IF NOT EXISTS web_research_log (
    request_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    member_id TEXT NOT NULL,
    credential_hash TEXT,
    question_hash TEXT NOT NULL,
    sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
    evidence_count INTEGER NOT NULL CHECK(evidence_count >= 0),
    plan_only INTEGER NOT NULL CHECK(plan_only IN (0,1)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS web_research_log_room_time ON web_research_log(room_id, created_at);
  CREATE INDEX IF NOT EXISTS web_research_log_member_time ON web_research_log(room_id, member_id, created_at);
`;

function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Provider registry (env-pluggable; no keys in code, ever)
// ---------------------------------------------------------------------------
function readEnv(name) {
  if (typeof process === "undefined" || !process?.env) return undefined;
  return process.env[name] || undefined;
}

async function queryAlexandria(question, { apiKey, fetchImpl, maxResults }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") fail(502, "provider_failed", "No fetch implementation available for the alexandria provider");
  let res;
  try {
    res = await doFetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: question, sources: ["web", "alexandria"], limit: maxResults }),
    });
  } catch (error) {
    fail(502, "provider_failed", `Alexandria provider request failed: ${error?.message ?? error}`);
  }
  if (!res.ok) fail(502, "provider_failed", `Alexandria provider returned HTTP ${res.status}`);
  let json;
  try { json = await res.json(); }
  catch { fail(502, "provider_failed", "Alexandria provider returned non-JSON"); }
  const web = json?.data?.web ?? [];
  return web.slice(0, maxResults).map(item => ({
    url: item.url ?? null,
    title: item.title ?? item.url ?? "alexandria result",
    excerpt: item.description ?? item.markdown ?? "",
  }));
}

const PROVIDERS = { alexandria: queryAlexandria };

export function providerStatus(requested) {
  // Returns { name, status: "ready"|"unconfigured", detail } — never the key.
  if (!requested) return { name: null, status: "unconfigured", detail: "no provider requested" };
  const envName = readEnv("WEB_RESEARCH_PROVIDER");
  if (!envName) {
    return { name: null, status: "unconfigured", detail: "set WEB_RESEARCH_PROVIDER=alexandria and ALEXANDRIA_API_KEY to enable the provider leg" };
  }
  if (!PROVIDERS[envName]) {
    return { name: envName, status: "unconfigured", detail: `unknown provider "${envName}" (known: ${Object.keys(PROVIDERS).join(", ")})` };
  }
  const keyEnv = `${envName.toUpperCase()}_API_KEY`;
  if (!readEnv(keyEnv)) {
    return { name: envName, status: "unconfigured", detail: `provider "${envName}" selected but ${keyEnv} is not set` };
  }
  return { name: envName, status: "ready", detail: "provider key present (never logged)" };
}

// ---------------------------------------------------------------------------
// Docs corpus (Node only; lazy file list, capped)
// ---------------------------------------------------------------------------
let docsFileCache = null;

function defaultCorpusRoots() {
  try {
    const serverDir = fileURLToPath(new URL(".", import.meta.url));
    const repoRoot = join(serverDir, "..");
    return { docsDir: join(repoRoot, "docs"), extraFiles: [join(repoRoot, "README.md"), join(repoRoot, "CHANGELOG.md")] };
  } catch { return null; }
}

function listCorpusFiles(docsDir, extraFiles) {
  const files = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= WEB_RESEARCH_DOCS_MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(docsDir);
  for (const f of extraFiles) {
    try { if (statSync(f).isFile()) files.push(f); } catch { /* absent */ }
  }
  return files.slice(0, WEB_RESEARCH_DOCS_MAX_FILES);
}

function scoreDocContent(content, keywords) {
  const lower = content.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    let from = 0, hits = 0;
    for (;;) {
      const at = lower.indexOf(kw, from);
      if (at === -1 || hits >= 10) break;
      hits++;
      from = at + kw.length;
    }
    score += hits;
  }
  return score;
}

function docTitle(content, filePath) {
  const m = /^#{1,6}\s+(.+)$/m.exec(content);
  return (m?.[1] ?? filePath.split("/").pop()).trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Input validation (strict: unknown fields fail loudly, like web-fetch)
// ---------------------------------------------------------------------------
function validateResearchInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(422, "invalid_research_input", "Request body must be a JSON object");
  for (const key of Object.keys(input)) {
    if (!["question", "sources", "urls", "maxEvidence", "maxAgeMs", "planOnly", "tags"].includes(key))
      fail(422, "invalid_research_input", `Unknown field: ${key}`);
  }
  const { question, sources, urls, maxEvidence, maxAgeMs, planOnly, tags } = input;
  if (typeof question !== "string" || !question.trim())
    fail(422, "invalid_research_input", "question is required");
  if (question.length > WEB_RESEARCH_MAX_QUESTION_CHARS)
    fail(422, "invalid_research_input", `question must be <= ${WEB_RESEARCH_MAX_QUESTION_CHARS} chars`);
  let resolvedSources = [...WEB_RESEARCH_SOURCES];
  if (sources !== undefined) {
    if (!Array.isArray(sources) || !sources.length)
      fail(422, "invalid_research_input", "sources must be a non-empty array");
    for (const s of sources) {
      if (!WEB_RESEARCH_SOURCES.includes(s))
        fail(422, "invalid_research_input", `Unknown source: ${s} (known: ${WEB_RESEARCH_SOURCES.join(", ")})`);
    }
    resolvedSources = [...new Set(sources)];
  }
  let resolvedUrls = [];
  if (urls !== undefined) {
    if (!Array.isArray(urls)) fail(422, "invalid_research_input", "urls must be an array of URL strings");
    if (urls.length > WEB_RESEARCH_MAX_URLS)
      fail(422, "invalid_research_input", `urls must have <= ${WEB_RESEARCH_MAX_URLS} entries`);
    for (const u of urls) {
      if (typeof u !== "string" || !u.trim()) fail(422, "invalid_research_input", "urls entries must be non-empty strings");
    }
    resolvedUrls = urls;
  }
  let resolvedMaxEvidence = WEB_RESEARCH_DEFAULT_EVIDENCE;
  if (maxEvidence !== undefined) {
    if (!Number.isInteger(maxEvidence) || maxEvidence < 1 || maxEvidence > WEB_RESEARCH_MAX_EVIDENCE)
      fail(422, "invalid_research_input", `maxEvidence must be 1..${WEB_RESEARCH_MAX_EVIDENCE}`);
    resolvedMaxEvidence = maxEvidence;
  }
  let resolvedMaxAgeMs;
  if (maxAgeMs !== undefined) {
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 0)
      fail(422, "invalid_research_input", "maxAgeMs must be a non-negative integer");
    resolvedMaxAgeMs = maxAgeMs;
  }
  let resolvedTags = [];
  if (tags !== undefined) {
    if (!Array.isArray(tags)) fail(422, "invalid_research_input", "tags must be an array of strings");
    if (tags.length > WEB_RESEARCH_MAX_TAGS)
      fail(422, "invalid_research_input", `tags must have <= ${WEB_RESEARCH_MAX_TAGS} entries`);
    for (const t of tags) {
      if (typeof t !== "string" || !t || t.length > WEB_RESEARCH_TAG_CHARS)
        fail(422, "invalid_research_input", `tags entries must be 1..${WEB_RESEARCH_TAG_CHARS} chars`);
    }
    resolvedTags = tags;
  }
  return {
    question: question.trim(),
    sources: resolvedSources,
    urls: resolvedUrls,
    maxEvidence: resolvedMaxEvidence,
    maxAgeMs: resolvedMaxAgeMs,
    planOnly: planOnly === true,
    tags: resolvedTags,
  };
}

// ---------------------------------------------------------------------------
// Store-bound service
// ---------------------------------------------------------------------------
export class WebResearch {
  constructor(store, opts = {}) {
    this.store = store;
    this.db = store.db;
    this.opts = opts;
  }

  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = webResearchSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(/^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Web research schema requires operator reconciliation");
    }
    return true;
  }

  checkRateLimits(roomId, memberId, now) {
    const since = now - WEB_RESEARCH_RATE_WINDOW_MS;
    const limited = (count, per, scope) => {
      if (count < per) return;
      const oldest = this.db.prepare(
        `SELECT MIN(created_at) AS at FROM web_research_log WHERE room_id=? ${scope} AND created_at>? AND plan_only=0`)
        .get(roomId, ...(scope ? [memberId] : []), since).at ?? now;
      const resetAt = oldest + WEB_RESEARCH_RATE_WINDOW_MS;
      fail(429, "rate_limited",
        `Web research quota exceeded (${per} per day ${scope ? "for this member" : "for this room"})`,
        { retryAfterMs: Math.max(0, resetAt - now), resetAt });
    };
    // Only executed research (plan_only=0) consumes quota; planning is free —
    // Alexandria's "discovery is free, execution costs" pattern.
    limited(this.db.prepare(
      "SELECT COUNT(*) AS n FROM web_research_log WHERE room_id=? AND member_id=? AND created_at>? AND plan_only=0")
      .get(roomId, memberId, since).n, WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY, "AND member_id=?");
    limited(this.db.prepare(
      "SELECT COUNT(*) AS n FROM web_research_log WHERE room_id=? AND created_at>? AND plan_only=0")
      .get(roomId, since).n, WEB_RESEARCH_RATE_PER_ROOM_PER_DAY, "");
  }

  journal({ requestId, roomId, memberId, credentialHash, questionHash, sources, evidenceCount, planOnly, at }) {
    this.db.prepare(`INSERT INTO web_research_log(request_id, room_id, member_id, credential_hash, question_hash, sources_json, evidence_count, plan_only, created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(requestId, roomId, memberId, credentialHash ?? null, questionHash,
        JSON.stringify(sources), evidenceCount, planOnly ? 1 : 0, at);
  }

  // -- Planner: deterministic, no model. Returns [{ source, status, reason, cost }].
  plan(req) {
    const prov = req.sources.includes("provider") ? providerStatus(true) : null;
    const plan = [];
    if (req.sources.includes("room")) {
      plan.push({
        source: "room",
        // INTERIM DISABLE (2026-09-24): the room leg searched the global
        // web_fetch_cache with no room scope — cross-room disclosure.
        // Proper fix (room-scoped web_fetch_cache_rooms mapping) is in flight;
        // until it lands the leg stays disabled. searchRoomCache() also
        // returns [] as defense in depth.
        status: "disabled",
        reason: "temporarily disabled: room-leg cache scoping fix in progress — no room evidence returned",
        cost: "n/a",
      });
    }
    if (req.sources.includes("docs")) {
      const docsAvailable = !isWorkersRuntime();
      plan.push({
        source: "docs",
        status: docsAvailable ? "planned" : "skipped",
        reason: docsAvailable
          ? "keyword search over the room's own docs corpus (docs/, README.md, CHANGELOG.md)"
          : "docs corpus unavailable in this runtime",
        cost: "free (local)",
      });
    }
    if (req.sources.includes("fetch")) {
      if (req.urls.length) {
        plan.push({
          source: "fetch",
          status: "planned",
          reason: `${req.urls.length} explicit URL(s) via the room's SSRF-hardened fetch`,
          cost: `bills web-fetch quota (${req.urls.length} fetch(es))`,
        });
      } else {
        plan.push({
          source: "fetch",
          status: "skipped",
          reason: hasRecencySignal(req.question)
            ? "question wants fresh web data but no urls were given and no provider is configured — pass urls[] or configure a provider"
            : "no urls[] given — the fetch leg needs explicit URLs (the room has no search backend without a provider key)",
          cost: "n/a",
        });
      }
    }
    if (prov) {
      plan.push({
        source: "provider",
        status: prov.status === "ready" ? "planned" : "unconfigured",
        reason: prov.status === "ready"
          ? `provider "${prov.name}" will answer via its own indexes + live web`
          : prov.detail,
        cost: prov.status === "ready" ? "bills provider credits (see provider pricing)" : "n/a",
      });
    }
    return plan;
  }

  provenance({ source, url, finalUrl, retrievedAt, content, bytes, cache, requestId }) {
    return {
      source,
      url: url ?? null,
      final_url: finalUrl ?? url ?? null,
      retrieved_at: retrievedAt,
      content_sha256: sha256Hex(content ?? ""),
      bytes: bytes ?? 0,
      cache: cache ?? null,
      request_id: requestId,
    };
  }

  // -- room leg: the room's own fetch memory.
  // INTERIM DISABLE (2026-09-24): cross-room disclosure — web_fetch_cache
  // is global with no room scope. The planner marks this leg "disabled" and
  // this method returns nothing until the room-scoped web_fetch_cache_rooms
  // fix lands. (Full query body preserved in git history.)
  searchRoomCache(_req, _keywords, _requestId, _now) {
    return [];
  }

  // -- docs leg: local markdown corpus (Node only).
  searchDocs(req, keywords, requestId, now) {
    if (isWorkersRuntime()) return [];
    const roots = this.opts.docsRoot ?? defaultCorpusRoots();
    if (!roots) return [];
    if (docsFileCache === null) {
      docsFileCache = listCorpusFiles(roots.docsDir, roots.extraFiles ?? []);
    }
    const files = this.opts.docsFiles ?? docsFileCache;
    const scored = [];
    let bytesRead = 0;
    for (const file of files) {
      if (scored.length >= WEB_RESEARCH_DOCS_MAX_FILES) break;
      let content;
      try {
        const size = statSync(file).size;
        if (size > WEB_RESEARCH_DOCS_MAX_FILE_BYTES || bytesRead + size > WEB_RESEARCH_DOCS_MAX_BYTES) continue;
        content = readFileSync(file, "utf8");
        bytesRead += size;
      } catch { continue; }
      const score = scoreDocContent(content, keywords);
      if (score > 0) scored.push({ file, content, score });
      if (scored.length >= req.maxEvidence * 3) break;
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, req.maxEvidence).map(({ file, content }, i) => {
      const title = docTitle(content, file);
      const passages = extractHighlights(content, req.question, 2, title);
      const excerpt = passages.join("\n\n");
      let mtime = now;
      try { mtime = statSync(file).mtimeMs; } catch { /* ignore */ }
      const rel = relative(process.cwd(), file);
      return {
        rank: i,
        source: "docs",
        id: `doc:${rel}`,
        url: null,
        title,
        excerpt,
        provenance: this.provenance({
          source: "docs",
          url: rel,
          finalUrl: rel,
          retrievedAt: Math.floor(mtime),
          content: excerpt || content.slice(0, 4000),
          bytes: content.length,
          cache: null,
          requestId,
        }),
      };
    });
  }

  // -- fetch leg: explicit URLs through the room's WebFetch service.
  async fetchUrls(req, requestId, roomId, memberId, credentialHash, now) {
    const evidence = [];
    const errors = [];
    for (const url of req.urls) {
      try {
        const res = await this.store.webFetch.fetch(roomId, memberId, {
          url,
          formats: { markdown: true, highlights: true },
          highlightsParams: { query: req.question, maxPassages: 3 },
          ...(req.maxAgeMs !== undefined ? { maxAgeMs: req.maxAgeMs } : {}),
          tags: req.tags,
        }, { credentialHash });
        const passages = (res.highlights?.data ?? []).map(h => typeof h === "string" ? h : (h?.text ?? ""));
        const excerpt = passages.join("\n\n");
        const content = res.markdown?.data ?? excerpt;
        evidence.push({
          rank: evidence.length,
          source: "fetch",
          id: `fetch:${sha256Hex(res.url).slice(0, 8)}`,
          url: res.url,
          title: res.metadata?.title || res.url,
          excerpt,
          provenance: this.provenance({
            source: "fetch",
            url: res.url,
            finalUrl: res.url,
            retrievedAt: now,
            content: excerpt || content.slice(0, 4000),
            bytes: content.length,
            cache: res.cache_metadata ? { status: res.cache_metadata.status, age_ms: res.cache_metadata.age_ms } : null,
            requestId: res.request_id ?? requestId,
          }),
        });
      } catch (error) {
        // One bad URL never kills the whole research call — reported, not thrown.
        errors.push({ url, code: error?.code ?? "fetch_failed", message: error?.message ?? String(error) });
      }
    }
    return { evidence, errors };
  }

  // -- provider leg: env-configured external knowledge (e.g. Alexandria).
  async queryProvider(req, prov, requestId, now) {
    const keyEnv = `${prov.name.toUpperCase()}_API_KEY`;
    const apiKey = readEnv(keyEnv);
    if (!apiKey) return { evidence: [], errors: [{ source: "provider", code: "provider_unconfigured", message: `${keyEnv} is not set` }] };
    const query = PROVIDERS[prov.name];
    let items;
    try {
      items = await query(req.question, { apiKey, fetchImpl: this.opts.fetchImpl, maxResults: req.maxEvidence });
    } catch (error) {
      return { evidence: [], errors: [{ source: "provider", code: error?.code ?? "provider_failed", message: error?.message ?? String(error) }] };
    }
    return {
      evidence: (items ?? []).map((item, i) => {
        const excerpt = item.excerpt ?? "";
        return {
          rank: i,
          source: "provider",
          id: `${prov.name}:${sha256Hex(item.url ?? excerpt).slice(0, 8)}`,
          url: item.url,
          title: item.title ?? item.url ?? prov.name,
          excerpt,
          provenance: this.provenance({
            source: `provider:${prov.name}`,
            url: item.url,
            finalUrl: item.url,
            retrievedAt: now,
            content: excerpt,
            bytes: excerpt.length,
            cache: null,
            requestId,
          }),
        };
      }),
      errors: [],
    };
  }

  async research(roomId, memberId, input, opts = {}) {
    const req = validateResearchInput(input);
    const now = this.store.now();
    const requestId = randomUUID();
    const questionHash = sha256Hex(req.question);
    const plan = this.plan(req);
    const credentialHash = opts.credentialHash;

    // Plan-first disclosure: planning is free and bills nothing.
    if (req.planOnly) {
      this.journal({ requestId, roomId, memberId, credentialHash, questionHash, sources: req.sources, evidenceCount: 0, planOnly: true, at: now });
      return { plan, evidence: [], fetch_errors: [], provider_status: providerStatus(req.sources.includes("provider")), request_id: requestId, plan_only: true };
    }

    this.checkRateLimits(roomId, memberId, now); // 429 with retry info, never a 500
    const keywords = researchKeywords(req.question);
    const evidence = [];
    const fetchErrors = [];
    const providerErrors = [];

    for (const leg of plan) {
      if (leg.status !== "planned") continue;
      if (evidence.length >= req.maxEvidence) break;
      try {
        if (leg.source === "room") {
          for (const e of this.searchRoomCache(req, keywords, requestId, now)) {
            if (evidence.length >= req.maxEvidence) break;
            e.rank = evidence.length;
            evidence.push(e);
          }
        } else if (leg.source === "docs") {
          for (const e of this.searchDocs(req, keywords, requestId, now)) {
            if (evidence.length >= req.maxEvidence) break;
            e.rank = evidence.length;
            evidence.push(e);
          }
        } else if (leg.source === "fetch") {
          const { evidence: fetched, errors } = await this.fetchUrls(req, requestId, roomId, memberId, credentialHash, now);
          for (const e of fetched) {
            if (evidence.length >= req.maxEvidence) break;
            e.rank = evidence.length;
            evidence.push(e);
          }
          fetchErrors.push(...errors);
        } else if (leg.source === "provider") {
          const prov = providerStatus(true);
          const { evidence: provided, errors } = await this.queryProvider(req, prov, requestId, now);
          for (const e of provided) {
            if (evidence.length >= req.maxEvidence) break;
            e.rank = evidence.length;
            evidence.push(e);
          }
          providerErrors.push(...errors);
        }
      } catch (error) {
        // A failing leg degrades to a note, never a 500 for the whole call.
        fetchErrors.push({ source: leg.source, code: error?.code ?? "leg_failed", message: error?.message ?? String(error) });
      }
    }

    this.journal({ requestId, roomId, memberId, credentialHash, questionHash, sources: req.sources, evidenceCount: evidence.length, planOnly: false, at: now });
    return {
      plan,
      evidence,
      fetch_errors: fetchErrors,
      provider_errors: providerErrors,
      provider_status: providerStatus(req.sources.includes("provider")),
      request_id: requestId,
      plan_only: false,
    };
  }
}

// Contract for API docs / clients.
export function webResearchContract() {
  return {
    status: "live",
    route: "POST /api/web/research",
    auth: "owner_and_full_members",
    sources: WEB_RESEARCH_SOURCES,
    limits: {
      maxQuestionChars: WEB_RESEARCH_MAX_QUESTION_CHARS,
      maxEvidence: WEB_RESEARCH_MAX_EVIDENCE,
      maxUrls: WEB_RESEARCH_MAX_URLS,
      perMemberPerDay: WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY,
      perRoomPerDay: WEB_RESEARCH_RATE_PER_ROOM_PER_DAY,
    },
    typedErrors: ["invalid_research_input", "rate_limited", "provider_failed"],
    notes: [
      "Planning (planOnly) is free and bills no quota; execution bills research quota, and fetch-leg URLs additionally bill web-fetch quota.",
      "The provider leg reads its key from the environment (ALEXANDRIA_API_KEY); the key is never logged or returned.",
    ],
  };
}

