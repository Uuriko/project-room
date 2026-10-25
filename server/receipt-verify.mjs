// Verify at read time for public receipts (charter Workstream B, P1/P2).
//
// The public receipt page has always shown stored values: hashes recorded
// when the record was projected, a merge the server's poll had settled by
// projection time — never re-checked when a stranger read the page. This
// module is the re-check. Given a public receipt it re-runs, at read time,
// every check the server can run itself: source-record (the record is
// re-derived from its current source and compared field by field),
// artifact (a public-work receipt's stored artifact still hashes to the
// sha256 the record carries), journal (a bounty lot's escrow entries are
// re-hashed and their per-account chain links re-checked — the same core
// the conservation audit uses, journalEntryHash in bounty-escrow), and
// pull-request (the linked pull request is re-fetched from GitHub and
// its current state compared with the merge the record claims). The
// verdict never outruns the checks: a check that could not run is named
// under not-checked with its reason, and no human is asked to compare a
// hash by eye — hashes stay machine-side.
import { parsePullRequestUrl, pullRequestOutcomeFromApi } from "./claim-coordination.mjs";
import { journalEntryHash } from "./bounty-escrow.mjs";
import { rederivePublicReceipt } from "./public-read-model.mjs";
import { verifyBountyReceipt } from "./bounty-receipts.mjs";
import { receiptKeyHistory, signerFingerprint, signerKeyEntry, signedReceiptCandidateById } from "./signed-receipt-read.mjs";

export const RECEIPT_VERIFICATION_SCHEMA = "project-room-receipt-verification/1";

const MAX_BODY_CHARS = 65_536;

// What no check here even attempts — stated so ran checks can't borrow scope.
const NEVER_CHECKED_ALWAYS = [
  "Whether the work itself is any good — no check here judges quality",
  "The real-world identity of the named people — names are as the room recorded them",
];
// A receipt carrying signed receipt IDs gets the signature leg below
// instead of this line. The line survives only for records with no
// signed receipt to check: the old universal wording ("public receipts
// are unsigned") claimed no signature existed even on records that
// carry one (proof layer S4, B3 §3.2).
const SIGNATURE_NOT_CHECKED_LINE =
  "A signature on this record — this record carries no signed receipt, so there is none to check";

const COMPARED_FIELDS = ["title", "agents", "humans", "pullRequest", "mergedAt", "hashes", "at"];
const sameField = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function checkSourceRecord(store, receipt) {
  const label = "Source record";
  const derived = rederivePublicReceipt(store, receipt.id);
  if (!derived || !derived.row) {
    return [{ id: "source-record", label, status: "missing",
      detail: "The source this receipt was projected from no longer yields it — the work was reverted or removed, or the room is gone." }];
  }
  const checks = [];
  const differ = COMPARED_FIELDS.filter(field => !sameField(derived.row[field], receipt[field]));
  checks.push(differ.length
    ? { id: "source-record", label, status: "contradicted",
        detail: `The stored record no longer matches its source — ${differ.join(", ")} differ${differ.length === 1 ? "s" : ""} from the source record now.` }
    : { id: "source-record", label, status: "pass",
        detail: "The record was re-derived from its source just now and every field matches." });
  if (derived.artifactHashOk !== null) {
    checks.push(derived.artifactHashOk
      ? { id: "artifact", label: "Delivered artifact", status: "pass",
          detail: "The stored artifact still hashes to the sha256 this record carries." }
      : { id: "artifact", label: "Delivered artifact", status: "contradicted",
          detail: "The stored artifact no longer hashes to the sha256 this record carries — it was altered after delivery." });
  }
  return checks;
}

function checkJournal(store, receipt) {
  const label = "Ledger hash chain";
  let entries;
  try {
    entries = store.db.prepare(`SELECT seq, room_id, entry_id, account_id, at, kind, bounty_id, lot_id,
      amount, lot_state, hash, prev_hash, memo, actor_kind, actor_id, track
      FROM bounty_journal WHERE lot_id=? ORDER BY seq`).all(receipt.id);
  } catch {
    return [{ id: "journal", label, status: "missing", detail: "This store holds no escrow ledger to re-check the lot against." }];
  }
  if (!entries.length) {
    return [{ id: "journal", label, status: "missing", detail: "The ledger no longer holds entries for this lot." }];
  }
  for (const entry of entries) {
    if (journalEntryHash(entry) !== entry.hash) {
      return [{ id: "journal", label, status: "contradicted",
        detail: `Ledger entry ${entry.entry_id} does not match its recorded hash — the entry was altered after it was written.` }];
    }
    const prev = store.db.prepare(`SELECT hash FROM bounty_journal
      WHERE room_id=? AND account_id=? AND seq<? ORDER BY seq DESC LIMIT 1`).get(entry.room_id, entry.account_id, entry.seq);
    if (entry.prev_hash !== (prev?.hash ?? "genesis")) {
      return [{ id: "journal", label, status: "contradicted",
        detail: `The hash chain is broken at ledger entry ${entry.entry_id} — it no longer links to the entry before it.` }];
    }
  }
  return [{ id: "journal", label, status: "pass",
    detail: `${entries.length} ledger ${entries.length === 1 ? "entry" : "entries"} re-hashed just now; every hash and chain link matches.` }];
}

async function checkPullRequest(receipt, { fetchImpl, token }) {
  const label = "Pull request on GitHub";
  const base = { id: "pull-request", label };
  const parsed = parsePullRequestUrl(receipt.pullRequest);
  if (!parsed) {
    return { ...base, status: "not-checked",
      detail: "The recorded link is not a GitHub pull request URL, so there is nothing to re-fetch." };
  }
  const [owner, name] = parsed.repo.split("/");
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${parsed.number}`;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "project-room-receipt-verify",
    "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(endpoint, { headers, signal: AbortSignal.timeout(5000) });
  } catch {
    return { ...base, status: "not-checked", detail: "GitHub could not be reached just now, so the pull request was not re-checked." };
  }
  if (response.status === 404) {
    return { ...base, status: "contradicted", detail: `GitHub reports no pull request #${parsed.number} in ${parsed.repo}.` };
  }
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    return { ...base, status: "not-checked",
      detail: "GitHub declined the re-check (rate limit or authorization), so the pull request was not re-checked." };
  }
  if (!response.ok) {
    return { ...base, status: "not-checked", detail: `GitHub answered ${response.status}, so the pull request was not re-checked.` };
  }
  let body = null;
  try {
    const text = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
    if (text.length <= MAX_BODY_CHARS) body = JSON.parse(text);
  } catch { body = null; }
  if (!body) {
    return { ...base, status: "not-checked", detail: "GitHub's answer could not be read, so the pull request was not re-checked." };
  }
  const outcome = pullRequestOutcomeFromApi(body);
  if (outcome === "merged") {
    const at = typeof body.merged_at === "string" ? ` at ${body.merged_at}` : "";
    const sha = typeof body.merge_commit_sha === "string" && /^[0-9a-f]{40}$/.test(body.merge_commit_sha)
      ? ` (merge commit ${body.merge_commit_sha.slice(0, 12)})` : "";
    return { ...base, status: "pass", detail: `GitHub reports pull request #${parsed.number} merged${at}${sha}.` };
  }
  // A merge is claimed only when the record carries mergedAt; for a
  // receipt that merely links the pull (a work item's evidence), the
  // current state is reported as a fact, not scored against a claim the
  // record never made.
  if (!receipt.mergedAt) {
    return { ...base, status: "observed",
      detail: `GitHub reports pull request #${parsed.number} ${outcome === "closed" ? "closed without merging" : "still open"}. This record claims no merge.` };
  }
  return { ...base, status: "contradicted",
    detail: outcome === "closed"
      ? `GitHub reports pull request #${parsed.number} closed without merging — the merge this record shows did not happen there.`
      : `GitHub reports pull request #${parsed.number} still open — not merged, as this record shows.` };
}

// The signature leg (proof layer S4; B3 §3.2). For each signed receipt
// ID stamped on the lot: five checks, never collapsed — integrity (the
// signature itself), signer identity (pinned against the published key
// history, when one exists), journal linkage (the entries the receipt
// was signed over still re-hash), time (always not-checked for the
// native format: issuedAt is the signer's assertion and no independent
// witness is carried), and key status (observed from the history). An
// ID stamped on the ledger with no admitted body is `missing`, not
// silent. Identity degrades exactly as designed while no key history
// is published (S5's reader fills the receiptKeyHistory seam):
// not-checked, never pass, never contradicted.
function checkSignatures(store, receipt, keyHistory) {
  const checks = [];
  const journal = { entryHash: entryId => {
    const row = store.db.prepare("SELECT * FROM bounty_journal WHERE entry_id=?").get(entryId);
    if (!row) throw new Error(`journal entry ${entryId} is not in this store`);
    return journalEntryHash(row);
  } };
  for (const receiptId of receipt.lot?.signedReceiptIds ?? []) {
    const label = `Signed receipt ${receiptId}`;
    const resolved = signedReceiptCandidateById(store, receiptId);
    if (!resolved) {
      checks.push({ id: "signature", label, status: "missing",
        detail: "A receipt ID is stamped on the ledger entries, but no signed body is stored to check." });
      continue;
    }
    const { body } = resolved;
    const result = verifyBountyReceipt(body, { journal });
    const reason = String(result.reason ?? "");
    const reasonClass = reason.split(":")[0] || "invalid";
    const entry = signerKeyEntry(body, keyHistory);
    const fingerprint = signerFingerprint(body.issuer?.pubkey);
    // Integrity: the signature stage. Journal and signer findings are
    // scored by their own checks, not folded into this one.
    if (result.ok || reason.startsWith("unexpected_signer") || reason.startsWith("journal_mismatch")) {
      checks.push({ id: "signature", label, status: "pass",
        detail: "The signed bytes are unaltered since issuance — the signature verifies over the receipt's canonical form." });
    } else {
      checks.push({ id: "signature", label, status: "contradicted",
        detail: `The stored signed body fails verification (${reasonClass}) — it was altered after signing, or never validly signed.` });
    }
    // Signer identity: pinned only when the published history names
    // this key (fingerprint + ref + role) and the signature itself
    // verified (a journal finding does not impeach the signer).
    const signerOk = result.ok || reason.startsWith("journal_mismatch");
    if (reason.startsWith("unexpected_signer")) {
      checks.push({ id: "signer-identity", label, status: "contradicted",
        detail: "The signature is valid, but not from the signer key this record names." });
    } else if (!entry) {
      checks.push({ id: "signer-identity", label, status: "not-checked",
        detail: keyHistory == null
          ? "Key history not published — signer identity not pinned."
          : "The published key history does not pin this key — the signature is self-consistent only." });
    } else if (entry.status === "revoked" && entry.compromiseTime && body.issuedAt >= entry.compromiseTime && signerOk) {
      checks.push({ id: "signer-identity", label, status: "contradicted",
        detail: `This receipt was issued at ${body.issuedAt}, after the compromise declared for its signer key at ${entry.compromiseTime}.` });
    } else if (!signerOk) {
      checks.push({ id: "signer-identity", label, status: "not-checked",
        detail: "The signature does not verify, so the signer cannot be confirmed against the pinned key." });
    } else {
      checks.push({ id: "signer-identity", label, status: "pass",
        detail: `Signed by the published escrow-keeper key ${fingerprint} (pinned by the published key history).${entry.status === "revoked" ? ` Signed before the declared compromise at ${entry.compromiseTime ?? "an unpublished time"}.` : ""}` });
    }
    // Journal linkage.
    if (result.ok) {
      checks.push({ id: "signature-journal", label, status: "pass",
        detail: "Both journal entries re-hash to the hashes the receipt was signed over." });
    } else if (reason.startsWith("unexpected_signer")) {
      checks.push({ id: "signature-journal", label, status: "not-checked",
        detail: "The signer is not the named key, so journal linkage is not scored for this body." });
    } else if (reason.startsWith("journal_mismatch")) {
      const named = /entry (\S+)/.exec(reason)?.[1];
      checks.push({ id: "signature-journal", label, status: "contradicted",
        detail: `Journal entry ${named ?? "named in the receipt"} no longer re-hashes to the hash this receipt was signed over.` });
    } else {
      checks.push({ id: "signature-journal", label, status: "not-checked",
        detail: "Journal linkage was not re-checked because the signature itself did not verify." });
    }
    // Time: always not-checked for the native format.
    checks.push({ id: "signature-time", label, status: "not-checked",
      detail: "No independently witnessed time is carried — issuedAt is the signer's assertion." });
    // Key status: observed from the published history, when one exists.
    if (!entry) {
      checks.push({ id: "signature-status", label, status: "not-checked",
        detail: keyHistory == null
          ? "Status unchecked — no key history or status record was consulted."
          : "The published key history does not carry this key, so its status is not published." });
    } else if (entry.status === "superseded") {
      checks.push({ id: "signature-status", label, status: "observed",
        detail: `Signing key superseded${entry.successor ? ` by ${entry.successor}` : ""}; this receipt still verifies.` });
    } else if (entry.status === "revoked") {
      checks.push({ id: "signature-status", label, status: "observed",
        detail: "The signer key is published as revoked; the issue-time window is scored under signer identity." });
    } else {
      checks.push({ id: "signature-status", label, status: "observed",
        detail: "The signer key is a published active escrow-keeper key." });
    }
  }
  return checks;
}

const VERDICTS = {
  "server-verified": {
    label: "Server-verified",
    summary: "The server re-checked this record just now: the source record still matches, and GitHub confirms the merge.",
  },
  "record-checked": {
    label: "Record re-checked",
    summary: "The server re-checked this record just now against its source, and everything it ran still matches.",
  },
  "partially-verifiable": {
    label: "Partially verifiable",
    summary: "Most of this record re-checked clean, but at least one check could not run — what was not checked is listed below.",
  },
  "contradicted": {
    label: "Contradicted",
    summary: "A re-check found this record does not match its evidence. The checks below name the mismatch.",
  },
  "no-longer-verifiable": {
    label: "No longer verifiable",
    summary: "The source behind this record is gone or no longer supports it, so it cannot be re-verified.",
  },
};

// Re-run every check the server can run on one public receipt, now.
// `receipt` is the public shape (server/receipts-live.mjs publicReceiptById).
// fetchImpl/token are injected the same way claim-pr-sync's are, so tests
// and the Worker resolve GitHub access identically.
export async function verifyPublicReceipt(store, receipt, { fetchImpl = fetch, token = null, nowMs = Date.now(), keyHistory } = {}) {
  const checks = receipt.source === "bounty-lot"
    ? checkJournal(store, receipt)
    : checkSourceRecord(store, receipt);
  if (receipt.source === "bounty-lot" && (receipt.lot?.signedReceiptIds?.length ?? 0) > 0)
    checks.push(...checkSignatures(store, receipt, keyHistory === undefined ? receiptKeyHistory() : keyHistory));
  if (receipt.pullRequest) checks.push(await checkPullRequest(receipt, { fetchImpl, token }));

  const contradicted = checks.some(check => check.status === "contradicted");
  const missing = checks.some(check => check.status === "missing");
  const notChecked = checks.some(check => check.status === "not-checked");
  let verdict;
  if (contradicted) verdict = "contradicted";
  else if (missing) verdict = "no-longer-verifiable";
  else if (notChecked) verdict = "partially-verifiable";
  else if (receipt.mergedAt) verdict = "server-verified";
  else verdict = "record-checked";

  const meta = VERDICTS[verdict];
  return {
    schema: RECEIPT_VERIFICATION_SCHEMA,
    receiptId: receipt.id,
    checkedAt: new Date(nowMs).toISOString(),
    verdict,
    verdictLabel: meta.label,
    summary: meta.summary,
    checks,
    scope: {
      checked: checks.filter(check => check.status !== "not-checked").map(check => check.label),
      notChecked: [
        ...checks.filter(check => check.status === "not-checked").map(check => check.label),
        ...NEVER_CHECKED_ALWAYS,
        ...((receipt.lot?.signedReceiptIds?.length ?? 0) > 0 ? [] : [SIGNATURE_NOT_CHECKED_LINE]),
      ],
      by: "the Project Room server, at read time",
    },
  };
}
