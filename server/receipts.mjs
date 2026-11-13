// Receipt text parsing (pure, no imports). Receipts are the one-line posts that
// deploy-prod, ci-receipt and merge-receipt put in the room. parseReceipt is
// shared by the project-state read (text fallback) and by the post path that
// appends them as typed signals (server/receipt-signals.mjs).
const clip = (text, n) => {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

// Receipt formats are the ones deploy-prod, ci-receipt and merge-receipt post.
// Anything that does not match is not a receipt.
export function parseReceipt(body) {
  if (typeof body !== "string") return null;
  let m = /^PROD DEPLOY ([0-9a-f]{8}) · (.*)$/s.exec(body.split("\n", 1)[0]);
  if (m) {
    const line = m[2];
    const ok = /strict smoke success/.test(line) && /live smoke success/.test(line) || /\bPASSED\b/.test(line) || /workflow smoke ok/.test(line);
    const failed = /ROLL FORWARD REQUIRED|ROLLBACK NOT VERIFIED|ROLLBACK VERIFIED|NO DEPLOYMENT CHANGE|smoke failure|smoke cancelled/.test(line);
    return { kind: "deploy", sha: m[1], smoke: failed ? "failed" : ok ? "ok" : "unknown" };
  }
  m = /^PROD ROLLBACK · (.*)$/s.exec(body.split("\n", 1)[0]);
  if (m) return { kind: "rollback", smoke: /smoke ok/.test(m[1]) ? "ok" : "unknown" };
  m = /^MERGED #(\d{1,7}) ([0-9a-f]{8}) · (.{0,200})$/s.exec(body.split("\n", 1)[0]);
  if (m) return { kind: "merged", pr: Number(m[1]), sha: m[2], title: clip(m[3].split(" · ")[0], 70) };
  m = /^CI #(\d{1,7}) ([0-9a-f]{8}) (PASSED|FAILED)\b(.{0,120})/s.exec(body.split("\n", 1)[0]);
  if (m) return { kind: "ci", pr: Number(m[1]), sha: m[2], verdict: m[3].toLowerCase(), detail: clip(m[4].replace(/·\s*https?:\S+/, ""), 60) };
  return null;
}
