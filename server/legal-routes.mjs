// HTTP for the legal pages, public reports, terms acceptance, and operator unpublish.
import {
  acceptCurrentTerms, countOpenPublicReports, hashReportAddress, reportChallenge,
  submitPublicReport, unpublishPublic, verifyReportProof,
} from "./legal-store.mjs";
import {
  LEGAL_CACHE_CONTROL, LEGAL_PAGE_CSP, LEGAL_SITEMAP_PATHS, REPORT_PAGE_CSP, legalPageHtml, reportPageHtml, securityTxt,
} from "./legal-pages.mjs";

const SECURITY_PATHS = new Set(["/.well-known/security.txt", "/security.txt"]);
const PAGE_PATHS = new Set(LEGAL_SITEMAP_PATHS);
const REPORT_FIELDS = ["kind", "target", "body", "bucket", "nonce"];

function send(res, status, body, type, head) {
  const bytes = Buffer.from(body);
  res.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length });
  res.end(head ? undefined : bytes);
}

export function isLegalPath(pathname) {
  return SECURITY_PATHS.has(pathname) || PAGE_PATHS.has(pathname) || pathname === "/report"
    || pathname === "/api/reports/public/challenge" || pathname === "/api/reports/public"
    || pathname === "/api/account/terms" || pathname === "/api/operator/unpublish"
    || pathname === "/api/health/jobs";
}

export async function handleLegalRequest({ req, res, url, store, rate, remoteAddress, readBody, json, cookie, protectWrite, reject, operatorAccountId, accountCookieName, accountView }) {
  const pathname = url.pathname;
  if (!isLegalPath(pathname)) return false;
  const head = req.method === "HEAD";
  const read = req.method === "GET" || head;

  if (SECURITY_PATHS.has(pathname)) {
    if (!read) reject(405, "method_not_allowed", "Method not allowed");
    res.setHeader("Cache-Control", LEGAL_CACHE_CONTROL);
    send(res, 200, securityTxt(), "text/plain; charset=utf-8", head);
    return true;
  }
  if (PAGE_PATHS.has(pathname)) {
    if (!read) reject(405, "method_not_allowed", "Method not allowed");
    const html = legalPageHtml(pathname);
    if (!html) reject(404, "not_found", "Not found");
    res.setHeader("Cache-Control", LEGAL_CACHE_CONTROL);
    res.setHeader("X-Robots-Tag", "all");
    res.setHeader("Content-Security-Policy", LEGAL_PAGE_CSP);
    send(res, 200, html, "text/html; charset=utf-8", head);
    return true;
  }
  if (pathname === "/report") {
    if (!read) reject(405, "method_not_allowed", "Method not allowed");
    res.setHeader("Content-Security-Policy", REPORT_PAGE_CSP);
    send(res, 200, reportPageHtml(), "text/html; charset=utf-8", head);
    return true;
  }
  if (pathname === "/api/reports/public/challenge") {
    if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
    json(res, 200, reportChallenge(store.now()));
    return true;
  }
  if (pathname === "/api/health/jobs") {
    if (!read) reject(405, "method_not_allowed", "Method not allowed");
    json(res, 200, { schema: "room.job-health/1", publicReports: countOpenPublicReports(store), servedBy: "node" }, head);
    return true;
  }
  if (pathname === "/api/reports/public") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    rate(`public-report:${hashReportAddress(String(remoteAddress ?? ""))}`, 5);
    const data = await readBody(req);
    const extra = Object.keys(data).filter(key => key !== "email" && !REPORT_FIELDS.includes(key));
    if (extra.length) reject(422, "invalid_report", "Unexpected report fields");
    if (!REPORT_FIELDS.every(key => Object.hasOwn(data, key)) || !verifyReportProof(data, store.now())) {
      reject(428, "proof_required", "A current proof of work is required");
    }
    const stored = submitPublicReport(store.db, {
      kind: data.kind, target: data.target, body: data.body,
      email: Object.hasOwn(data, "email") ? data.email : null,
      ipHash: hashReportAddress(String(remoteAddress ?? "")), now: store.now(),
    });
    if (!stored.ok) reject(stored.status, stored.code, stored.message);
    json(res, 201, { received: true, id: stored.id });
    return true;
  }
  if (pathname === "/api/account/terms") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    const token = cookie(req, accountCookieName);
    if (!token) reject(401, "unauthenticated", "Sign in required");
    const auth = store.authenticateAccountSession(token);
    protectWrite(req, auth, false);
    const data = await readBody(req);
    if (!Object.hasOwn(data, "version") || Object.keys(data).length !== 1) reject(422, "invalid_terms", "Send the terms version");
    const accepted = acceptCurrentTerms(store.db, auth.account.id, data.version, store.now());
    if (!accepted.ok) reject(accepted.status, accepted.code, accepted.message);
    json(res, 200, accountView(auth));
    return true;
  }
  if (pathname === "/api/operator/unpublish") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    const token = cookie(req, accountCookieName);
    if (!token) reject(401, "unauthenticated", "Sign in required");
    const auth = store.authenticateAccountSession(token);
    protectWrite(req, auth, false);
    if (!operatorAccountId) reject(403, "operator_unconfigured", "The operator account is not configured");
    if (auth.account.id !== operatorAccountId) reject(403, "forbidden", "Operator access required");
    const data = await readBody(req);
    if (!exact(data, ["kind", "id"])) reject(422, "invalid_unpublish", "Send kind and id");
    const result = unpublishPublic(store.db, { kind: data.kind, id: data.id, byAccount: auth.account.id, now: store.now() });
    if (!result.ok) reject(result.status, result.code, result.message);
    json(res, 200, { unpublished: true, kind: result.kind, id: result.id });
    return true;
  }
  return false;
}

function exact(value, fields) {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
