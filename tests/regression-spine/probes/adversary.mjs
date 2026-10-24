// Adversary replays. ADV-P1 / TM-1 / ADV-P3 run the ORIGINAL lane repros
// vendored unmodified (probes/vendor/). The rest are mechanism probes over
// the exact code the findings cite.
import { readSrc, vendorRun, srcVerdict, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];

if (id === "ADV-P1" || id === "TM-1") {
  const { code, out, err } = await vendorRun("adv-p1-repro.mjs.txt");
  if (!out.includes("REPRO DONE")) notfiled(`ADV-P1 repro exited ${code} without completing: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 280)}`);
  const aVerify = /A verify S -> (\d+)/.exec(out)?.[1];
  const levelAfter = /level\(S\) after A attests: (\S+)/.exec(out)?.[1];
  const bStrip = /B unverify S -> (\d+)/.exec(out)?.[1];
  const bystander = /bystander verify S -> (\d+)/.exec(out)?.[1];
  if (aVerify === "201" && bStrip === "200")
    still(`verified tier is self-bootstrapped: a self-created room owner attested an unrelated sybil (verify -> 201, level '${levelAfter}') and a second unrelated owner stripped it (DELETE -> 200); the bystander control correctly 403s (${bystander}) — ownership of ANY self-made room is the only gate${id === "TM-1" ? "; requireVerified consumers therefore trust a ring-forgeable fact" : ""}`);
  else if (aVerify === "403" || aVerify === "422") fixed(`the unrelated-owner attestation is now refused (verify -> ${aVerify}) — attestation requires a real relationship to the target (PR #4129 shape)`);
  else notfiled(`unrecognised repro outcome: A verify=${aVerify} level=${levelAfter} B strip=${bStrip}`);
} else if (id === "ADV-P3") {
  const { code, out, err } = await vendorRun("adv-p3-repro.mjs.txt");
  if (!out.includes("REPRO DONE")) notfiled(`ADV-P3 repro exited ${code} without completing: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 280)}`);
  const link = /link by non-holder owner -> (\d+)/.exec(out)?.[1];
  const member = /member record in lab: (\S+)/.exec(out)?.[1];
  const snap = /victim secret GET \/api\/rooms\/lab -> (\d+)/.exec(out)?.[1];
  if (link === "201" && member && member !== "null" && snap === "200")
    still(`link() performs no holder proof: a room owner linked a victim identity knowing only its public id (201, member record created) and the victim's secret now reads the room (GET -> 200) — the holder never consented (defect #942)`);
  else if (link && Number(link) >= 400) fixed(`the non-holder link is refused (${link}) — holder proof (link code) is now required at link() (PR #4140 shape)`);
  else notfiled(`unrecognised repro outcome: link=${link} member=${member} snap=${snap}`);
} else if (id === "ADV-P2" || id === "TM-8") {
  // The code row is the binding: identity_link_codes carries identity only.
  const ident = readSrc("server/agent-identities.mjs") ?? "";
  const schema = /CREATE TABLE IF NOT EXISTS identity_link_codes \(([^)]*)\)/.exec(ident)?.[1] ?? "";
  const consume = /consumeLinkCode\(identityId, code\) \{([\s\S]*?)\n  \}/.exec(ident)?.[1] ?? "";
  const schemaBound = /room|sponsor|scope/i.test(schema);
  const consumeBound = /roomId|sponsor/.test(consume);
  if (!schema && !consume) notfiled("identity_link_codes schema / consumeLinkCode not found in server/agent-identities.mjs — source drifted");
  if (!schemaBound && !consumeBound)
    still(`link codes are unbound bearer proofs of the holder only: the identity_link_codes row carries (${schema.trim().replace(/\s+/g, " ").slice(0, 140)}) — no room, no sponsor, no scope — and consumeLinkCode checks identity + expiry + single-use only${id === "TM-8" ? "; any sponsor/room that obtains a code can consume it (sponsor binding gap)" : "; one code serves any room/door that asks"}`);
  else fixed(`link codes now carry binding (schema mentions room/sponsor/scope: ${schemaBound}; consume enforces it: ${consumeBound}) — PR #4132 shape in tree`);
} else if (id === "ADV-P7") {
  srcVerdict("server/legal-routes.mjs",
    /pathname === "\/api\/operator\/unpublish"/,
    /operator_actions/,
    {
      defect: "POST /api/operator/unpublish runs on an account-session cookie and appends no central operator_actions record — charter 09's per-route-action audit row is absent (the fix would reference operator_actions in legal-routes.mjs)",
      fix: "legal-routes.mjs now records operator actions centrally (operator_actions referenced)",
    });
} else if (id === "ADV-P6") {
  const routes = readSrc("server/routes/spend-pricing.mjs") ?? "";
  const mod = readSrc("server/spend-pricing.mjs") ?? "";
  if (!routes || !mod) notfiled("spend-pricing route/module not found — source drifted");
  const bindingEnforced = /expectedSessionBinding/.test(mod) && /(binding|session)[^;]{0,80}(mismatch|!==|refus|reject)/i.test(mod);
  const chainComment = /capability is null/.test(routes);
  if (!bindingEnforced)
    still(`POST /api/rooms/{roomId}/spend-pricing reaches setSpendPricing on the owner check alone (route row: capability null, "the real gate is the owner check inside setSpendPricing") — the write-defense chain sibling money routes run (session-binding enforcement) is not applied to this route; charter 08 unbuilt`);
  else fixed("setSpendPricing enforces the session binding — the write-defense chain now covers the spend-pricing route");
} else if (id === "ADV-P4") {
  // Filed mechanism (adversary.md P4): the whole-store backup-token doors
  // (export / restore / restore-from-backup) share the room-export.mjs
  // guard — 16-char credential floor (purge demands a configured SHA-256
  // hash + >=32-byte token), a 401 oracle, no rate limit, and NO audit:
  // appendOperatorAction's only caller in the tree is operator-purge.mjs.
  const exp = readSrc("server/room-export.mjs") ?? "";
  const rst = readSrc("server/restore-ndjson.mjs") ?? "";
  const purge = readSrc("server/operator-purge.mjs") ?? "";
  if (!exp) notfiled("server/room-export.mjs not found — source drifted");
  const auditAtDoors = /appendOperatorAction/.test(exp) || /appendOperatorAction/.test(rst);
  const auditOnlyAtPurge = /appendOperatorAction/.test(purge) && !auditAtDoors;
  const weakFloor = /16/.test(exp.slice(Math.max(0, exp.search(/BACKUP_TOKEN|backupToken/) - 400), exp.search(/BACKUP_TOKEN|backupToken/) + 1200));
  if (auditOnlyAtPurge) still(`the whole-store backup-token doors still write no operator_actions row: appendOperatorAction is called by the purge surface only, never by room-export.mjs/restore-ndjson.mjs${weakFloor ? ", and the export guard region still carries the 16-char credential floor (purge demands >=32 bytes + configured hash)" : ""} — an export/restore with the token is invisible in the operator audit (PR #4139 unbuilt)`);
  else if (auditAtDoors) fixed("the backup-token doors now append operator_actions records (PR #4139 shape in tree)");
  else notfiled("appendOperatorAction call graph does not match either the filed or the fixed shape — re-derive");
} else if (id === "ADV-P5" || id === "TM-10") {
  // Filed mechanism (adversary.md P5): AgentConnections create/rotate take
  // a caller-supplied keyHash validated ONLY as /^[0-9a-f]{64}$/, and apply
  // writes credential_hash = keyHash — the sponsor picks the digest of a
  // plaintext they chose, with no distinction for enrolled existing
  // identities. Fix shapes: possession proof, or an enrolled-identity
  // guard on rotate.
  const conn = readSrc("server/agent-connections.mjs") ?? "";
  if (!conn) notfiled("server/agent-connections.mjs not found — source drifted");
  const formatOnly = /\^\[0-9a-f\]\{64\}\$/.test(conn) && /credential_hash:\s*keyHash/.test(conn);
  const guarded = /enrolled[^;{]{0,120}(refus|reject|proof|possession|holder)/i.test(conn) || /verifySignature|possessionProof|proofOfPossession/.test(conn);
  if (formatOnly && !guarded) still("sponsored create/rotate still accept a caller-supplied keyHash validated only as /^[0-9a-f]{64}$/ and write it straight to credential_hash — no possession proof and no enrolled-identity distinction, so an owner can rotate an enrolled member's credential to a plaintext the owner chose (impersonation, not administration)");
  else if (guarded) fixed("sponsored rotation now distinguishes enrolled identities / verifies possession (guard present in agent-connections.mjs)");
  else notfiled("agent-connections.mjs matches neither the filed format-only shape nor a guarded shape — source drifted");
} else if (id === "TM-4") {
  const conn = readSrc("server/agent-connections.mjs") ?? "";
  if (!conn) notfiled("server/agent-connections.mjs not found");
  // Filed mechanism: enrollment's one-shot exemption consults ANY approved
  // access row for the identity, not the specific link code's approval.
  const exempt = /one.?shot|exempt/i.test(conn);
  if (exempt && !/codeHash|linkCode|specific/i.test(conn.slice(conn.search(/one.?shot|exempt/i), conn.search(/one.?shot|exempt/i) + 1500)))
    still("the enrollment one-shot exemption keys on approved-row existence, not on the specific consumed code — a perpetual exemption is mintable from any prior approval (SF2 item 1 unbuilt)");
  else if (!exempt) still("no code-specific binding found for the enrollment exemption in agent-connections.mjs — the approved-row exemption stands as filed (SF2 item 1 unbuilt)");
  else fixed("the enrollment exemption is bound to the specific code/approval (SF2 item 1 in tree)");
} else {
  notfiled(`adversary.mjs has no probe for ${id}`);
}
