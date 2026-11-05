// Room Git remote (ROOM_GIT_REMOTE), phase 0: pure smart-HTTP helpers only.
// No routes are wired yet. See docs/design/git-remote.md.

export const gitRemoteEnabled = (env = process.env) => env?.ROOM_GIT_REMOTE === "1";

const MAX_PKT = 65520;
const ZERO_OID = "0".repeat(40);
const OID = /^[0-9a-f]{40}$/;
const REF = /^refs\/heads\/room\/[A-Za-z0-9._\/-]{1,200}$/;

export function encodePktLine(text) {
  if (text === null) return "0000";
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length + 4;
  if (len > MAX_PKT) throw new RangeError("pkt-line too long");
  return len.toString(16).padStart(4, "0") + text;
}

// Parses pkt-lines from the start of buf. Returns { lines, rest } where lines
// holds strings (null = flush) and rest is the byte offset after the last flush.
export function parsePktLines(buf, { maxLines = 1000 } = {}) {
  const view = buf instanceof Uint8Array ? buf : new TextEncoder().encode(String(buf));
  const dec = new TextDecoder();
  const lines = [];
  let i = 0;
  while (i + 4 <= view.length) {
    if (lines.length >= maxLines) throw new RangeError("too many pkt-lines");
    const head = dec.decode(view.subarray(i, i + 4));
    if (!/^[0-9a-f]{4}$/.test(head)) throw new SyntaxError("bad pkt-line length");
    const len = parseInt(head, 16);
    if (len === 0) { lines.push(null); i += 4; return { lines, rest: i }; }
    if (len < 4 || len > MAX_PKT || i + len > view.length) throw new SyntaxError("bad pkt-line length");
    lines.push(dec.decode(view.subarray(i + 4, i + len)));
    i += len;
  }
  throw new SyntaxError("missing flush");
}

// receive-pack command list: "<old> <new> <ref>[\0caps]". Only refs/heads/room/* may be pushed,
// so an agent can never touch main or another agent's branch namespace by accident.
export function parseReceivePackCommands(lines) {
  const commands = [];
  let capabilities = [];
  for (const raw of lines) {
    if (raw === null) break;
    let line = raw.replace(/\n$/, "");
    const nul = line.indexOf("\0");
    if (nul >= 0) { if (!commands.length) capabilities = line.slice(nul + 1).split(" ").filter(Boolean); line = line.slice(0, nul); }
    const [oldOid, newOid, ref, extra] = line.split(" ");
    if (extra !== undefined || !OID.test(oldOid || "") || !OID.test(newOid || "")) throw new SyntaxError("bad command");
    if (!REF.test(ref || "") || ref.includes("..") || ref.endsWith(".lock") || ref.endsWith("/")) throw new SyntaxError("ref not allowed");
    commands.push({ oldOid, newOid, ref, create: oldOid === ZERO_OID, delete: newOid === ZERO_OID });
  }
  if (!commands.length || commands.length > 20) throw new SyntaxError("bad command count");
  return { commands, capabilities };
}

// info/refs advertisement for an empty or populated repo.
export function advertiseRefs(service, refs = []) {
  if (service !== "git-receive-pack" && service !== "git-upload-pack") throw new SyntaxError("bad service");
  const caps = service === "git-receive-pack" ? "report-status delete-refs ofs-delta" : "ofs-delta";
  let out = encodePktLine(`# service=${service}\n`) + encodePktLine(null);
  if (!refs.length) out += encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  refs.forEach(({ oid, ref }, n) => {
    if (!OID.test(oid) || !/^refs\//.test(ref)) throw new SyntaxError("bad ref");
    out += encodePktLine(n === 0 ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`);
  });
  return out + encodePktLine(null);
}
