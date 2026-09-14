// Minimal RFC 5322 / MIME reader for mail delivered by Cloudflare Email Routing.
// No dependencies, no network, no attachment bytes retained. Every axis is
// bounded (raw size, header count and length, part count, nesting depth, text
// size) and every scan is linear: boundaries are matched with indexOf, never
// interpolated into a regular expression, and the regular expressions used on
// untrusted text have bounded, non-nested quantifiers.
export const mimeLimits = Object.freeze({ rawBytes: 1048576, headers: 200, headerBytes: 8192, parts: 50, depth: 4,
  textBytes: 262144, attachments: 100, addresses: 200, nameChars: 255, previewChars: 512 });
export class MimeError extends Error {
  constructor(code, detail) { super(detail ?? code); this.name = "MimeError"; this.code = code; }
}
const fail = (code, detail) => { throw new MimeError(code, detail); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const addressPattern = /^[^\s@<>(),;:"\\[\]]{1,256}@[^\s@<>(),;:"\\[\]]{1,255}$/;
const controls = /[\u0000-\u001f\u007f]/g, bodyControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Header values must be safe for the envelope (no control characters, well
// formed UTF-16). Folding is unfolded before this runs, so CR/LF here can only
// be an injection attempt and is removed, never re-emitted.
export const cleanHeaderValue = value => String(value).replace(controls, "").toWellFormed().trim();
const cleanBodyText = value => value.replace(/\r\n?/g, "\n").replace(bodyControls, "").toWellFormed();
const latin1 = bytes => Buffer.from(bytes).toString("latin1");
export function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return { value, truncated: false };
  return { value: Buffer.from(value).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, ""), truncated: true };
}

// Charset decoding through the platform decoder with a short allow list of
// labels; anything unknown falls back to Latin-1 so bytes are never dropped
// silently and never interpreted as markup.
function decodeCharset(bytes, charset) {
  const label = String(charset ?? "utf-8").toLowerCase().replace(/^["']|["']$/g, "");
  if (/^(utf-?8|us-ascii|ascii|ansi_x3\.4-1968)$/.test(label)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return new TextDecoder("windows-1252").decode(bytes); }
  }
  if (/^(iso[-_]?8859-1|latin-?1|l1|cp819|windows-1252|cp1252|x-cp1252|ascii)$/.test(label)) return new TextDecoder("windows-1252").decode(bytes);
  if (/^[a-z0-9._:-]{1,40}$/.test(label)) {
    try { return new TextDecoder(label).decode(bytes); } catch { /* unknown label: Latin-1 below */ }
  }
  return new TextDecoder("windows-1252").decode(bytes);
}
// Raw 8-bit header bytes (common, non-compliant) are read as UTF-8 when valid.
const headerBytesToText = raw => /[\u0080-\u00ff]/.test(raw) ? decodeCharset(Buffer.from(raw, "latin1"), "utf-8") : raw;

// RFC 2047 encoded-words. Charset token, Q or B encoding and the encoded text
// are each bounded; whitespace between two adjacent encoded-words is dropped.
const encodedWord = /=\?([A-Za-z0-9!#$%&'*+\-^_`{|}~]{1,75}?)(?:\*[A-Za-z0-9-]{1,35})?\?([QqBb])\?([!->@-~]{0,1000})\?=/g;
function decodeEncodedWord(charset, encoding, text) {
  let bytes;
  if (encoding === "Q" || encoding === "q") {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "_") out.push(0x20);
      else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) { out.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
      else out.push(c.charCodeAt(0));
    }
    bytes = Buffer.from(out);
  } else {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) return null;
    bytes = Buffer.from(text, "base64");
  }
  return decodeCharset(bytes, charset);
}
export function decodeEncodedWords(value) {
  const input = String(value);
  let out = "", last = 0, previousWasWord = false;
  for (const match of input.matchAll(encodedWord)) {
    const between = input.slice(last, match.index);
    const decoded = decodeEncodedWord(match[1], match[2], match[3]);
    if (decoded === null) { out += between + match[0]; previousWasWord = false; }
    else { out += previousWasWord && /^[ \t]*$/.test(between) ? "" : between; out += decoded; previousWasWord = true; }
    last = match.index + match[0].length;
  }
  return out + input.slice(last);
}
const decodeHeader = raw => cleanHeaderValue(decodeEncodedWords(headerBytesToText(raw)));

// Header block of one entity. Lines are split on LF with an optional CR so
// bare-LF messages still parse; the block ends at the first empty line.
function parseHeaderBlock(section, limits) {
  const headers = [];
  let pos = 0, current = null;
  while (pos < section.length) {
    const eol = section.indexOf("\n", pos), end = eol === -1 ? section.length : eol;
    const line = section[end - 1] === "\r" && end > pos ? section.slice(pos, end - 1) : section.slice(pos, end);
    pos = eol === -1 ? section.length : eol + 1;
    if (line === "") return { headers, body: section.slice(pos) };
    if (line[0] === " " || line[0] === "\t") {
      if (!current) fail("malformed_mime_header", "continuation line before any header");
      current.raw += " " + line.trim();
    } else {
      const colon = line.indexOf(":");
      const name = colon > 0 ? line.slice(0, colon) : "";
      if (!/^[!-9;-~]{1,200}$/.test(name)) fail("malformed_mime_header", "header line without a valid field name");
      if (headers.length >= limits.headers) fail("mime_header_limit", `more than ${limits.headers} header fields`);
      current = { name, raw: line.slice(colon + 1).trim() };
      headers.push(current);
    }
    if (current.raw.length > limits.headerBytes) fail("mime_header_limit", `header ${current.name} longer than ${limits.headerBytes} bytes`);
  }
  return { headers, body: "" }; // Header-only entity without a blank line.
}
export class MimeHeaders {
  #fields;
  constructor(fields) { this.#fields = fields.map(f => ({ name: f.name, value: decodeHeader(f.raw), raw: f.raw })); }
  get size() { return this.#fields.length; }
  all(name) { const key = String(name).toLowerCase(); return this.#fields.filter(f => f.name.toLowerCase() === key).map(f => f.value); }
  get(name) { return this.all(name)[0] ?? null; }
  has(name) { return this.all(name).length > 0; }
  // Structured fields (Content-Type, Content-Disposition) are parsed from the
  // undecoded value so quoted parameters keep their exact bytes.
  raw(name) { const key = String(name).toLowerCase(); return this.#fields.find(f => f.name.toLowerCase() === key)?.raw ?? null; }
  names() { return this.#fields.map(f => f.name); }
}

// type/subtype; name=value; name="quoted"; RFC 2231 name*=charset'lang'pct and
// name*0/name*1 continuations. A hand-written scanner: no regex over the value.
export function parseStructuredHeader(value) {
  const raw = String(value ?? ""), segments = [];
  let seg = "", quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted && c === "\\" && i + 1 < raw.length) { seg += raw[++i]; continue; }
    if (c === "\"") { quoted = !quoted; continue; }
    if (c === ";" && !quoted) { segments.push(seg); seg = ""; continue; }
    seg += c;
  }
  segments.push(seg);
  const type = segments.shift().trim().toLowerCase();
  const parameters = {}, extended = new Map();
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim().toLowerCase(), val = segment.slice(eq + 1).trim();
    const shape = /^([a-z0-9!#$%&'+.^_`|~-]{1,64})(?:\*(\d{1,3}))?(\*)?$/.exec(name);
    if (!shape) continue;
    const [, base, index, encoded] = shape;
    if (index === undefined && encoded === undefined) { if (!Object.hasOwn(parameters, base)) parameters[base] = val; continue; }
    const list = extended.get(base) ?? []; list[Number(index ?? 0)] = { val, encoded: encoded === "*" }; extended.set(base, list);
  }
  for (const [base, pieces] of extended) {
    let charset = "utf-8", text = "";
    pieces.forEach((piece, i) => {
      if (!piece) return;
      let v = piece.val;
      if (piece.encoded) {
        if (i === 0) { const parts = v.split("'"); if (parts.length >= 3) { charset = parts[0] || "utf-8"; v = parts.slice(2).join("'"); } }
        const bytes = [];
        for (let k = 0; k < v.length; k++) {
          if (v[k] === "%" && /^[0-9A-Fa-f]{2}$/.test(v.slice(k + 1, k + 3))) { bytes.push(parseInt(v.slice(k + 1, k + 3), 16)); k += 2; }
          else bytes.push(v.charCodeAt(k) & 0xff);
        }
        v = decodeCharset(Buffer.from(bytes), charset);
      }
      text += v;
    });
    parameters[base] = text; // RFC 2231 form wins over a plain duplicate.
  }
  return { type, parameters };
}
const parameter = (parsed, name) => Object.hasOwn(parsed.parameters, name) ? parsed.parameters[name] : null;
const boundaryPattern = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/;

// Split a multipart body on its boundary. Delimiter lines are located with
// indexOf at line starts; a line that merely begins with the delimiter (for
// example a nested boundary sharing a prefix) is not a delimiter.
export function splitMultipart(body, boundary) {
  if (typeof boundary !== "string" || !boundaryPattern.test(boundary) || boundary.endsWith(" ")) fail("malformed_mime_boundary", "missing or invalid boundary parameter");
  const delimiter = "--" + boundary, parts = [];
  let search = 0, start = null, closed = false;
  while (search <= body.length) {
    let at = body.indexOf(delimiter, search);
    while (at > 0 && body[at - 1] !== "\n") at = body.indexOf(delimiter, at + 1);
    if (at === -1) break;
    const eol = body.indexOf("\n", at), lineEnd = eol === -1 ? body.length : eol;
    const rest = body.slice(at + delimiter.length, lineEnd).replace(/\r$/, "");
    if (!/^(--)?[ \t]{0,64}$/.test(rest)) { search = at + delimiter.length; continue; }
    if (start !== null) {
      let end = at;
      if (end > start && body[end - 1] === "\n") end -= end - 1 > start && body[end - 2] === "\r" ? 2 : 1;
      parts.push(body.slice(start, Math.max(start, end)));
    }
    if (rest.startsWith("--")) { closed = true; break; }
    start = eol === -1 ? body.length : eol + 1; search = start;
  }
  if (start === null) fail("malformed_mime_boundary", "multipart body has no opening boundary delimiter");
  if (!closed) parts.push(body.slice(start)); // Missing close delimiter: read to end of body.
  return parts;
}
function decodeQuotedPrintable(text) {
  const out = Buffer.allocUnsafe(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "=") {
      if (text[i + 1] === "\r" && text[i + 2] === "\n") { i += 2; continue; }
      if (text[i + 1] === "\n") { i += 1; continue; }
      if (/^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) { out[n++] = parseInt(text.slice(i + 1, i + 3), 16); i += 2; continue; }
    }
    out[n++] = c.charCodeAt(0) & 0xff;
  }
  return out.subarray(0, n);
}
function decodeTransfer(body, encoding) {
  const e = String(encoding ?? "7bit").trim().toLowerCase();
  if (e === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/]/g, ""), "base64");
  if (e === "quoted-printable") return decodeQuotedPrintable(body);
  return Buffer.from(body, "latin1"); // 7bit, 8bit, binary or unknown: bytes as delivered.
}

// Address lists: comma separated outside quotes, angle brackets and comments.
// Group syntax is unwrapped; display names lose surrounding quotes. Entries
// whose addr-spec would not pass the envelope's address rule are dropped.
export function parseAddressList(value, { max = mimeLimits.addresses } = {}) {
  const input = String(value ?? ""), items = [];
  let token = "", quoted = false, angle = 0, comment = 0;
  const flush = () => { if (token.trim()) items.push(token.trim()); token = ""; };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\" && (quoted || comment) && i + 1 < input.length) { token += c + input[++i]; continue; }
    if (c === "\"" && !comment) quoted = !quoted;
    else if (!quoted && c === "(") comment++;
    else if (!quoted && c === ")" && comment) comment--;
    else if (!quoted && !comment && c === "<") angle++;
    else if (!quoted && !comment && c === ">" && angle) angle--;
    else if (!quoted && !comment && !angle && (c === "," || c === ";")) { flush(); continue; }
    else if (!quoted && !comment && !angle && c === ":") { token = ""; continue; } // group name
    token += c;
  }
  flush();
  const out = [];
  for (const item of items) {
    if (out.length >= max) break;
    const mailbox = parseMailbox(item);
    if (mailbox) out.push(mailbox);
  }
  return out;
}
const stripComments = value => {
  let out = "", depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && depth && i + 1 < value.length) { i++; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")" && depth) { depth--; continue; }
    if (!depth) out += c;
  }
  return out;
};
const unquote = value => {
  const v = value.trim();
  return v.length >= 2 && v[0] === "\"" && v.at(-1) === "\"" ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;
};
export function parseMailbox(item) {
  const open = item.indexOf("<");
  let name = "", address = item;
  if (open !== -1) {
    const close = item.indexOf(">", open);
    name = unquote(stripComments(item.slice(0, open)));
    address = item.slice(open + 1, close === -1 ? item.length : close);
  }
  address = stripComments(address).trim();
  if (!addressPattern.test(address)) return null;
  return { name: cleanHeaderValue(name).slice(0, 1024), address };
}
const messageIdPattern = /<([^<>\s]{1,998})>/g;
export const parseMessageIds = (value, max = 10) => [...String(value ?? "").matchAll(messageIdPattern)].map(m => "<" + m[1] + ">").slice(-max);
function parseDate(value) {
  if (!value || value.length > 100) return null;
  const at = Date.parse(value.replace(/\([^)]{0,100}\)/g, "").trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// Conservative HTML to text for previews only: comments, script and style
// blocks are removed with indexOf scans, tags are dropped (block tags become
// newlines), then a bounded set of entities is decoded. Output is text.
const asciiLower = value => value.replace(/[A-Z]/g, c => c.toLowerCase());
const blockTags = new Set(["br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "ul", "ol", "hr", "section", "article", "header", "footer"]);
const entities = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "\u00a9", reg: "\u00ae", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", bull: "\u2022", middot: "\u00b7", euro: "\u20ac", pound: "\u00a3", trade: "\u2122" };
function removeBlocks(html, lower, open, close) {
  let out = "", pos = 0;
  while (pos < html.length) {
    const at = lower.indexOf(open, pos);
    if (at === -1) { out += html.slice(pos); break; }
    out += html.slice(pos, at);
    const end = lower.indexOf(close, at + open.length), tail = end === -1 ? -1 : close.endsWith(">") ? end + close.length - 1 : lower.indexOf(">", end + close.length);
    pos = tail === -1 ? html.length : tail + 1;
  }
  return out;
}
export function htmlToText(html) {
  let text = String(html ?? "");
  text = removeBlocks(text, asciiLower(text), "<!--", "-->");
  for (const tag of ["script", "style", "head", "title"]) text = removeBlocks(text, asciiLower(text), "<" + tag, "</" + tag);
  let out = "", pos = 0, noClose = false;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt === -1) { out += text.slice(pos); break; }
    out += text.slice(pos, lt);
    const gt = noClose ? -1 : text.indexOf(">", lt + 1);
    if (gt === -1) { noClose = true; out += text.slice(lt); break; }
    const tag = text.slice(lt + 1, gt), name = asciiLower(/^\/?([a-zA-Z][a-zA-Z0-9]{0,15})/.exec(tag)?.[1] ?? "");
    if (!name) out += text.slice(lt, gt + 1);
    else if (blockTags.has(name)) out += "\n";
    else if (name === "td" || name === "th") out += " ";
    pos = gt + 1;
  }
  out = out.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, ref) => {
    if (ref[0] !== "#") return Object.hasOwn(entities, ref) ? entities[ref] : whole;
    const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) return " ";
    return String.fromCodePoint(code);
  });
  return cleanBodyText(out).split("\n").map(line => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseEntity(section, depth, state) {
  const { limits } = state;
  if (depth > limits.depth) fail("mime_depth_limit", `parts nested deeper than ${limits.depth}`);
  if (++state.parts > limits.parts) fail("mime_part_limit", `more than ${limits.parts} MIME parts`);
  const block = parseHeaderBlock(section, limits), headers = new MimeHeaders(block.headers);
  const contentType = parseStructuredHeader(headers.raw("content-type") ?? "text/plain");
  const type = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(contentType.type) ? contentType.type : "application/octet-stream";
  const disposition = parseStructuredHeader(headers.raw("content-disposition") ?? "");
  const filenameRaw = parameter(disposition, "filename") ?? parameter(contentType, "name");
  const filename = filenameRaw === null ? null : cleanHeaderValue(decodeEncodedWords(headerBytesToText(unquote(filenameRaw)))).slice(0, limits.nameChars);
  const entity = { headers, type };
  if (type.startsWith("multipart/")) {
    const parts = splitMultipart(block.body, parameter(contentType, "boundary"));
    for (const part of parts) parseEntity(part, depth + 1, state);
    return entity;
  }
  const bytes = decodeTransfer(block.body, headers.raw("content-transfer-encoding"));
  const inlineText = (type === "text/plain" || type === "text/html") && disposition.type !== "attachment" && filename === null;
  if (inlineText) {
    const decoded = cleanBodyText(decodeCharset(bytes, parameter(contentType, "charset") ?? "utf-8"));
    const key = type === "text/plain" ? "text" : "html";
    if (state[key] === null) state[key] = decoded;
    else if (key === "text") state.text += "\n\n" + decoded; // Later inline text parts are appended; a second HTML body is ignored.
    return entity;
  }
  if (state.attachments.length >= limits.attachments) fail("mime_attachment_limit", `more than ${limits.attachments} attachments`);
  const contentId = parseMessageIds(headers.get("content-id"), 1)[0] ?? null;
  state.attachments.push({ name: filename ?? "", contentType: type, size: bytes.length, contentId,
    inline: disposition.type === "inline" || (disposition.type === "" && contentId !== null) });
  return entity;
}

// Parse a raw message (Uint8Array, ArrayBuffer or string). Attachment bodies
// are measured and discarded; text bodies are capped at limits.textBytes.
export function parseMimeMessage(raw, options = {}) {
  const limits = Object.freeze({ ...mimeLimits, ...(object(options.limits) ? options.limits : {}) });
  let bytes;
  if (typeof raw === "string") bytes = Buffer.from(raw, "utf8");
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
  else if (raw instanceof Uint8Array) bytes = raw;
  else fail("invalid_mime_input", "raw message must be bytes or a string");
  if (bytes.length > limits.rawBytes) fail("mime_raw_limit", `raw message larger than ${limits.rawBytes} bytes`);
  const state = { limits, parts: 0, text: null, html: null, attachments: [] };
  const root = parseEntity(latin1(bytes), 0, state);
  const h = root.headers;
  const text = state.text === null ? null : truncateUtf8(state.text, limits.textBytes);
  const html = state.html === null ? null : truncateUtf8(state.html, limits.textBytes);
  const previewSource = text?.value.trim() ? text.value : html ? htmlToText(html.value) : "";
  const from = parseAddressList(h.get("from"), { max: 1 }), sender = parseAddressList(h.get("sender"), { max: 1 });
  return {
    rawSize: bytes.length, partCount: state.parts, headers: h, contentType: root.type,
    subject: h.get("subject") ?? "", messageId: parseMessageIds(h.get("message-id"), 1)[0] ?? null, date: parseDate(h.get("date")),
    from: from[0] ?? null, sender: sender[0] ?? null, replyTo: parseAddressList(h.get("reply-to")),
    to: parseAddressList(h.all("to").join(", ")), cc: parseAddressList(h.all("cc").join(", ")),
    inReplyTo: parseMessageIds(h.get("in-reply-to")), references: parseMessageIds(h.get("references")),
    text: text?.value ?? null, html: html?.value ?? null, truncated: Boolean(text?.truncated || html?.truncated),
    preview: previewSource.replace(/\s+/g, " ").trim().slice(0, limits.previewChars), attachments: state.attachments
  };
}
