import { gmailParts } from "../../../server/gmail-content.mjs";
// text/plain part with attachmentId but NO filename (provider-sent text attachment).
const payload = {
  mimeType: "multipart/mixed",
  parts: [
    { mimeType: "text/plain", body: { data: Buffer.from("hello").toString("base64url") } },
    { mimeType: "text/plain", body: { attachmentId: "att-1", size: 100 } },
  ],
};
const r = gmailParts(payload);
console.log("text parts:", r.text.length, "| attachments:", JSON.stringify(r.attachments.map(a => a.partId)));
