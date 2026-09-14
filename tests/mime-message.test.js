import test from "node:test";
import assert from "node:assert/strict";
import { parseMimeMessage, mimeLimits, MimeError, htmlToText, decodeEncodedWords, parseAddressList, splitMultipart, parseStructuredHeader } from "../server/mime-message.mjs";

const crlf = lines => lines.join("\r\n");
const simple = crlf(["From: Avery Quinn <avery@example.test>", "To: room@example.test", "Subject: A small collaboration",
  "Date: Tue, 08 Sep 2026 12:00:00 +0000", "Message-ID: <hello-1@example.test>", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
  "Shall we work on this together?", "", "Private budget: 4200.", ""]);

test("simple text message: headers, addresses, date and body", () => {
  const m = parseMimeMessage(Buffer.from(simple));
  assert.equal(m.subject, "A small collaboration"); assert.equal(m.messageId, "<hello-1@example.test>");
  assert.deepEqual(m.from, { name: "Avery Quinn", address: "avery@example.test" });
  assert.deepEqual(m.to, [{ name: "", address: "room@example.test" }]);
  assert.equal(m.date, "2026-09-08T12:00:00.000Z"); assert.equal(m.contentType, "text/plain");
  assert.equal(m.text, "Shall we work on this together?\n\nPrivate budget: 4200.\n"); assert.equal(m.html, null);
  assert.equal(m.preview, "Shall we work on this together? Private budget: 4200."); assert.deepEqual(m.attachments, []);
  assert.equal(m.partCount, 1); assert.equal(m.truncated, false); assert.equal(m.headers.get("subject"), m.subject);
  assert.deepEqual(parseMimeMessage(simple), { ...m, headers: m.headers }, "string input parses the same");
  assert.deepEqual(parseMimeMessage(simple.replace(/\r\n/g, "\n")).text, m.text, "bare LF line endings are accepted");
});

test("multipart/alternative prefers text/plain; html-only falls back to a text preview", () => {
  const alt = crlf(["From: a@example.test", "To: b@example.test", "Subject: Alt", "Content-Type: multipart/alternative; boundary=\"b1\"", "",
    "--b1", "Content-Type: text/plain; charset=utf-8", "", "Plain body", "--b1", "Content-Type: text/html; charset=utf-8", "",
    "<html><body><p>HTML <b>body</b></p></body></html>", "--b1--", ""]);
  const m = parseMimeMessage(alt);
  assert.equal(m.text, "Plain body"); assert.equal(m.html, "<html><body><p>HTML <b>body</b></p></body></html>");
  assert.equal(m.preview, "Plain body"); assert.equal(m.partCount, 3);
  const htmlOnly = crlf(["From: a@example.test", "Subject: H", "Content-Type: text/html", "",
    "<style>p{color:red}</style><script>alert(1)</script><div>Hello&nbsp;&amp; <a href=\"x\">welcome</a></div><p>Second &#x1F337; line &lt;tag&gt;</p>", ""]);
  const h = parseMimeMessage(htmlOnly);
  assert.equal(h.text, null); assert.equal(h.preview, "Hello & welcome Second 🌷 line <tag>");
  assert.equal(h.preview.includes("alert"), false); assert.equal(h.preview.includes("color"), false);
});

test("nested multipart/mixed lists attachments by name, type and size without keeping bytes", () => {
  const png = Buffer.alloc(3000, 7).toString("base64").replace(/(.{76})/g, "$1\r\n");
  const mixed = crlf(["From: a@example.test", "To: b@example.test", "Subject: Files", "Content-Type: multipart/mixed; boundary=\"outer\"", "",
    "--outer", "Content-Type: multipart/alternative; boundary=inner", "",
    "--inner", "Content-Type: text/plain", "", "See attached.", "--inner", "Content-Type: text/html", "", "<p>See attached.</p>", "--inner--",
    "--outer", "Content-Type: image/png; name=\"chart.png\"", "Content-Transfer-Encoding: base64", "Content-Disposition: attachment; filename=\"chart.png\"", "", png,
    "--outer", "Content-Type: text/plain; charset=utf-8", "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.txt", "", "not the body",
    "--outer", "Content-Type: image/gif", "Content-ID: <logo@example.test>", "Content-Transfer-Encoding: base64", "", "R0lGODlh",
    "--outer", "Content-Type: message/rfc822", "", "Subject: inner mail", "", "forwarded", "--outer--", ""]);
  const m = parseMimeMessage(mixed);
  assert.equal(m.text, "See attached."); assert.equal(m.partCount, 8);
  assert.deepEqual(m.attachments, [
    { name: "chart.png", contentType: "image/png", size: 3000, contentId: null, inline: false },
    { name: "résumé.txt", contentType: "text/plain", size: 12, contentId: null, inline: false },
    { name: "", contentType: "image/gif", size: 6, contentId: "<logo@example.test>", inline: true },
    { name: "", contentType: "message/rfc822", size: 32, contentId: null, inline: false }]);
  assert.equal(JSON.stringify({ ...m, headers: null }).includes("forwarded"), false, "attachment bodies are not retained");
});

test("quoted-printable UTF-8 and base64 bodies decode; Latin-1 charset is honoured", () => {
  const qp = crlf(["From: a@example.test", "Subject: QP", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
    "Caf=C3=A9 =E2=80=94 soft=", "break and a literal =3D sign", ""]);
  assert.equal(parseMimeMessage(qp).text, "Café — softbreak and a literal = sign\n");
  const b64 = crlf(["From: a@example.test", "Subject: B64", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from("Ünïcödé body 🌷\r\nline two").toString("base64"), ""]);
  assert.equal(parseMimeMessage(b64).text, "Ünïcödé body 🌷\nline two");
  const latin = Buffer.concat([Buffer.from(crlf(["From: a@example.test", "Subject: L1", "Content-Type: text/plain; charset=iso-8859-1", "", ""])), Buffer.from([0x43, 0x61, 0x66, 0xe9])]);
  assert.equal(parseMimeMessage(latin).text, "Café");
  const eightBit = Buffer.concat([Buffer.from(crlf(["From: a@example.test", "Subject: 8bit", "Content-Type: text/plain", "", ""])), Buffer.from("naïve ✓")]);
  assert.equal(parseMimeMessage(eightBit).text, "naïve ✓", "undeclared charset is read as UTF-8 when valid");
});

test("RFC 2047 encoded-words: Q and B, UTF-8 and ISO-8859-1, adjacent words, malformed left alone", () => {
  assert.equal(decodeEncodedWords("=?UTF-8?Q?Caf=C3=A9_planning?= =?utf-8?B?8J+Mtw==?="), "Café planning🌷");
  assert.equal(decodeEncodedWords("=?ISO-8859-1?Q?Se=F1or?= Lopez"), "Señor Lopez");
  assert.equal(decodeEncodedWords("=?iso-8859-1?B?U2Xxb3I=?="), "Señor");
  assert.equal(decodeEncodedWords("plain =?utf-8?X?bad?= =?utf-8?B?!!!?= text"), "plain =?utf-8?X?bad?= =?utf-8?B?!!!?= text");
  assert.equal(decodeEncodedWords("=?utf-8*en?Q?tagged?="), "tagged");
  const m = parseMimeMessage(crlf(["From: =?UTF-8?B?QXZlcnkgUXVpbm4=?= <avery@example.test>", "Subject: =?utf-8?q?Re=3A_Caf=C3=A9?=", "", "x"]));
  assert.equal(m.subject, "Re: Café"); assert.equal(m.from.name, "Avery Quinn");
  const long = "=?utf-8?Q?" + "a".repeat(1500) + "?=";
  assert.equal(decodeEncodedWords(long), long, "over-long encoded text is not an encoded-word");
});

test("address lists: names, quotes, comments, groups, multiple headers and invalid entries", () => {
  assert.deepEqual(parseAddressList("\"Quinn, Avery\" <avery@example.test>, lee@example.test (Lee), Team: sam@example.test, pat@example.test;, bad address, <x@y>"), [
    { name: "Quinn, Avery", address: "avery@example.test" }, { name: "", address: "lee@example.test" },
    { name: "", address: "sam@example.test" }, { name: "", address: "pat@example.test" }, { name: "", address: "x@y" }]);
  assert.deepEqual(parseAddressList("a@example.test, b@example.test, c@example.test", { max: 2 }).length, 2);
  const longName = parseAddressList("\"" + "名".repeat(400) + "\" <cjk@example.test>")[0];
  assert.equal(longName.address, "cjk@example.test"); assert.equal(Buffer.byteLength(longName.name), 1023, "display names are cut at the envelope's 1024-byte cap on a code-point boundary");
  assert.deepEqual(parseAddressList("<" + "a".repeat(250) + "@" + "b".repeat(80) + ".test>, ok@example.test"), [{ name: "", address: "ok@example.test" }],
    "an addr-spec over 320 bytes is dropped like any other invalid entry");
  const m = parseMimeMessage(crlf(["From: a@example.test", "To: one@example.test", "To: two@example.test", "Cc: \"Three\" <three@example.test>", "Reply-To: replies@example.test",
    "In-Reply-To: <earlier@example.test>", "References: <start@example.test>", "\t<earlier@example.test>", "", "x"]));
  assert.deepEqual(m.to.map(a => a.address), ["one@example.test", "two@example.test"]); assert.equal(m.cc[0].name, "Three");
  assert.deepEqual(m.replyTo, [{ name: "", address: "replies@example.test" }]);
  assert.deepEqual(m.inReplyTo, ["<earlier@example.test>"]); assert.deepEqual(m.references, ["<start@example.test>", "<earlier@example.test>"]);
});

test("caps: oversized raw, header count and length, part count, depth, attachments, text truncation", () => {
  const big = Buffer.alloc(mimeLimits.rawBytes + 1, 0x61);
  assert.throws(() => parseMimeMessage(big), { name: "MimeError", code: "mime_raw_limit" });
  assert.throws(() => parseMimeMessage("Subject: x\r\n\r\nbody", { limits: { rawBytes: 4 } }), { code: "mime_raw_limit" });
  const head = Buffer.from("Subject: exactly at the cap\r\n\r\n");
  const atCap = parseMimeMessage(Buffer.concat([head, Buffer.alloc(mimeLimits.rawBytes - head.length, 0x61)]));
  assert.equal(atCap.truncated, true); assert.equal(atCap.text.length, mimeLimits.textBytes, "the raw cap itself is allowed; text is cut at the text cap");
  assert.throws(() => parseMimeMessage(Array.from({ length: mimeLimits.headers + 1 }, (_, i) => `X-H${i}: v`).join("\r\n") + "\r\n\r\nx"), { code: "mime_header_limit" });
  assert.throws(() => parseMimeMessage("Subject: " + "a".repeat(mimeLimits.headerBytes + 1) + "\r\n\r\nx"), { code: "mime_header_limit" });
  const many = ["Content-Type: multipart/mixed; boundary=b", ""];
  for (let i = 0; i <= mimeLimits.parts; i++) many.push("--b", "Content-Type: text/plain", "", "p" + i);
  assert.throws(() => parseMimeMessage(crlf([...many, "--b--", ""])), { code: "mime_part_limit" });
  let nested = "Content-Type: text/plain\r\n\r\nleaf";
  for (let d = 0; d <= mimeLimits.depth; d++) nested = `Content-Type: multipart/mixed; boundary=d${d}\r\n\r\n--d${d}\r\n${nested}\r\n--d${d}--\r\n`;
  assert.throws(() => parseMimeMessage(nested), { code: "mime_depth_limit" });
  const files = ["Content-Type: multipart/mixed; boundary=f", ""];
  for (let i = 0; i <= 12; i++) files.push("--f", "Content-Type: application/octet-stream", "", "z");
  assert.throws(() => parseMimeMessage(crlf([...files, "--f--", ""]), { limits: { attachments: 12 } }), { code: "mime_attachment_limit" });
  const long = parseMimeMessage("Subject: t\r\n\r\n" + "é".repeat(200), { limits: { textBytes: 101 } });
  assert.equal(long.truncated, true); assert.equal(Buffer.byteLength(long.text), 100, "truncation never splits a code point");
  assert.throws(() => parseMimeMessage(42), { code: "invalid_mime_input" });
  assert.ok(new MimeError("x") instanceof Error);
});

test("malformed boundaries and header lines are rejected; prefix-sharing boundaries are not confused", () => {
  assert.throws(() => parseMimeMessage("Content-Type: multipart/mixed\r\n\r\n--x\r\n\r\nbody\r\n--x--"), { code: "malformed_mime_boundary" });
  assert.throws(() => parseMimeMessage("Content-Type: multipart/mixed; boundary=\"\"\r\n\r\nbody"), { code: "malformed_mime_boundary" });
  assert.throws(() => parseMimeMessage("Content-Type: multipart/mixed; boundary=\"has\\\"quote\"\r\n\r\nbody"), { code: "malformed_mime_boundary" });
  assert.throws(() => parseMimeMessage("Content-Type: multipart/mixed; boundary=ok\r\n\r\nno delimiter at all"), { code: "malformed_mime_boundary" });
  assert.throws(() => splitMultipart("x", "a".repeat(71)), { code: "malformed_mime_boundary" });
  const unterminated = parseMimeMessage("Content-Type: multipart/mixed; boundary=ok\r\n\r\n--ok\r\nContent-Type: text/plain\r\n\r\nno close delimiter");
  assert.equal(unterminated.text, "no close delimiter");
  const prefix = parseMimeMessage(crlf(["Content-Type: multipart/mixed; boundary=b", "", "--b", "Content-Type: text/plain", "", "--b2 is text", "--bx also", "--b--", ""]));
  assert.equal(prefix.text, "--b2 is text\n--bx also");
  assert.throws(() => parseMimeMessage("Subject: ok\r\nthis line has no colon\r\n\r\nx"), { code: "malformed_mime_header" });
  assert.throws(() => parseMimeMessage(" leading continuation\r\n\r\nx"), { code: "malformed_mime_header" });
  assert.throws(() => parseMimeMessage("Bad Name: x\r\n\r\nx"), { code: "malformed_mime_header" });
  assert.equal(parseMimeMessage("Subject: only headers").subject, "only headers");
  assert.equal(parseMimeMessage("Content-Type: text/plain; boundary=unused\r\n\r\nplain").text, "plain", "boundary on a non-multipart type is ignored");
  assert.equal(parseMimeMessage("Content-Type: ../../weird\r\n\r\nx").contentType, "application/octet-stream");
});

test("header injection: CR/LF and other control characters never survive into header values", () => {
  const raw = Buffer.concat([Buffer.from("From: a@example.test\r\nSubject: =?utf-8?Q?Line=0D=0ABcc=3A_evil=40example.test?= tail"), Buffer.from([0x00, 0x07, 0x7f]),
    Buffer.from("\r\nX-Note: first\r\n second\r\n\ttab\r\nTo: =?utf-8?B?" + Buffer.from("x\r\nInjected: y").toString("base64") + "?= <b@example.test>\r\n\r\nbody ok\r\n")]);
  const m = parseMimeMessage(raw);
  assert.equal(m.subject, "LineBcc: evil@example.test tail");
  for (const name of m.headers.names()) for (const value of m.headers.all(name)) assert.doesNotMatch(value, /[ -]/);
  assert.equal(m.headers.get("x-note"), "first second tab"); assert.equal(m.headers.get("injected"), null); assert.equal(m.headers.get("bcc"), null);
  assert.equal(m.text, "bodyok\n");
  assert.deepEqual(m.to, [{ name: "y", address: "b@example.test" }], "decoded CR/LF vanish; the remaining colon reads as RFC group syntax, never as a header");
  const lone = parseMimeMessage("Subject: bad \ud800 surrogate\r\n\r\nx");
  assert.equal(lone.subject.isWellFormed(), true);
});

test("structured headers and html-to-text handle quoting, RFC 2231, comments and pathological input in linear time", () => {
  assert.deepEqual(parseStructuredHeader("Text/HTML; charset=\"UTF-8\"; name=\"a;b.txt\""), { type: "text/html", parameters: { charset: "UTF-8", name: "a;b.txt" } });
  assert.deepEqual(parseStructuredHeader("attachment; filename*0*=utf-8''big%20; filename*1*=file.txt").parameters, { filename: "big file.txt" });
  assert.equal(htmlToText("<!-- hidden -->a<br>b<p>c</p><table><tr><td>1</td><td>2</td></tr></table>&unknown; &#0; &#xD800;"), "a\nb\nc\n\n1 2\n\n&unknown;");
  assert.equal(htmlToText("<script>while(1){}</scr" + "ipt>after<style>x</style>"), "after");
  assert.equal(htmlToText("a < b and 1 <2 <notatag"), "a < b and 1 <2 <notatag");
  const started = performance.now();
  htmlToText("<".repeat(200000)); htmlToText("<!--".repeat(50000)); htmlToText("&amp".repeat(50000));
  decodeEncodedWords("=?".repeat(50000)); decodeEncodedWords("=?utf-8?Q?" + "=".repeat(900) + "?= ".repeat(50));
  assert.throws(() => splitMultipart(("--b" + "x".repeat(10) + "\r\n").repeat(20000), "b"), { code: "malformed_mime_boundary" }, "20000 prefix-sharing lines are scanned, none is a delimiter");
  assert.equal(splitMultipart("--b\r\n" + ("--b" + "x".repeat(10) + "\r\n").repeat(20000) + "--b--", "b").length, 1);
  parseAddressList("<".repeat(100000) + "a@b");
  assert.ok(performance.now() - started < 2000, "pathological inputs finish quickly");
});
