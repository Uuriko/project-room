// Invented Gmail API shaped data (users.messages resources). No mailbox
// export, real people or tokens.
const b64 = text => Buffer.from(text, "utf8").toString("base64url");
const headers = entries => entries.map(([name, value]) => ({ name, value }));

export function gmailContractFixture() {
  const connection = { accountId: "account-fixture", id: "gmail-fixture", revision: 1, provider: "gmail-api",
    mailboxId: "morgan@gmail.test", identity: { name: "Morgan", address: "morgan@gmail.test" }, aliases: [] };
  const labelId = "INBOX";
  const message1 = { id: "18d3f2a1b4c50001", threadId: "18d3f2a1b4c50001", labelIds: ["INBOX", "UNREAD"],
    snippet: "Shall we work on this together? Private budget: 4200.",
    historyId: "9876501", internalDate: "1788868801000",
    payload: { partId: "", mimeType: "multipart/mixed",
      headers: headers([["From", "Avery Quinn <avery@example.test>"], ["Sender", "Avery's assistant <assistant@example.test>"],
        ["Reply-To", "Project replies <replies@example.test>"], ["To", "Morgan <morgan@gmail.test>, Lee <lee@example.test>"],
        ["Cc", "Sam <sam@example.test>"], ["Subject", "A small collaboration"], ["Date", "Mon, 08 Sep 2026 12:00:01 +0000"],
        ["Message-ID", "<hello-1@example.test>"], ["In-Reply-To", "<earlier@example.test>"],
        ["References", "<start@example.test> <earlier@example.test>"], ["X-Fixture-Private", "do not project this header"]]),
      body: { size: 0 },
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", headers: headers([["Content-Type", "text/plain; charset=utf-8"]]),
          body: { size: 52, data: b64("Shall we work on this together?\n\nPrivate budget: 4200.") } },
        { partId: "1", mimeType: "text/plain", filename: "brief.txt", headers: headers([["Content-Type", "text/plain"]]),
          body: { size: 128, data: b64("x".repeat(128)), attachmentId: "ANGjd_fixtureAttachment1" } }
      ] },
    sizeEstimate: 2048 };
  const message2 = { id: "18d3f2a1b4c50002", threadId: "18d3f2a1b4c50002", labelIds: ["DRAFT"],
    snippet: "Draft with HTML body.",
    historyId: "9876502", internalDate: "1788946200000",
    payload: { partId: "", mimeType: "text/html",
      headers: headers([["From", "\"Quinn, Avery\" <avery@example.test>"], ["To", "morgan@gmail.test"],
        ["Subject", "HTML only"], ["Date", "Tue, 09 Sep 2026 09:30:00 +0000"], ["Message-ID", "<hello-2@example.test>"]]),
      body: { size: 41, data: b64("<p>Hello <b>Morgan</b></p>") } },
    sizeEstimate: 512 };
  const message3 = { id: "18d3f2a1b4c50003", threadId: "18d3f2a1b4c50001", labelIds: ["INBOX", "SENT"],
    snippet: "Minimal headers.",
    historyId: "9876503", internalDate: "1788946200000",
    payload: { partId: "", mimeType: "text/plain",
      headers: headers([["From", "lee@example.test"], ["To", "morgan@gmail.test"], ["Message-ID", "<hello-3@example.test>"]]),
      body: { size: 7, data: b64("Minimal") } },
    sizeEstimate: 256 };
  const pages = [
    { pageToken: null, response: { status: 200, body: { messages: [{ id: message1.id, threadId: message1.threadId },
        { id: message2.id, threadId: message2.threadId }], nextPageToken: "tok-2", resultSizeEstimate: 3 } } },
    { pageToken: "tok-2", response: { status: 200, body: { messages: [{ id: message3.id, threadId: message3.threadId }],
        resultSizeEstimate: 3 } } }
  ];
  const messages = [
    { id: message1.id, response: { status: 200, message: message1 } },
    { id: message2.id, response: { status: 200, message: message2 } },
    { id: message3.id, response: { status: 200, message: message3 } },
    { id: "18d3f2a1b4c5gone", response: { status: 404, code: "notFound" } }
  ];
  return { connection, labelId, messages, recording: { connection, pages, messages } };
}
