// Invented Microsoft Graph-shaped data. No mailbox export, real people or tokens.
export function emailContractFixture() {
  const address = (name, address) => ({ emailAddress: { name, address } });
  const connection = { accountId: "account-fixture", id: "mail-fixture", revision: 1, provider: "microsoft-graph",
    mailboxId: "fixture-mailbox", identity: { name: "Morgan", address: "morgan@example.test" }, aliases: [{ name: "Morgan", address: "m@example.test" }] };
  const message = { id: "AQMkFixtureMessage+1/=", changeKey: "CQAAfixture-1=", conversationId: "AAQkFixtureThread=",
    parentFolderId: "AQMkFixtureInbox=", internetMessageId: "<hello-1@example.test>", subject: "A small collaboration",
    sentDateTime: "2026-09-08T12:00:00Z", receivedDateTime: "2026-09-08T12:00:01.0000000Z",
    from: address("Avery", "avery@example.test"), sender: address("Avery's assistant", "assistant@example.test"),
    replyTo: [address("Project replies", "replies@example.test")],
    toRecipients: [address("Morgan", "morgan@example.test"), address("Lee", "lee@example.test")],
    ccRecipients: [address("Morgan alias", "m@example.test"), address("Sam", "sam@example.test")],
    bccRecipients: [address("Private observer", "observer@example.test")],
    body: { contentType: "text", content: "Shall we work on this together?\r\n\r\nPrivate budget: 4200." },
    hasAttachments: true, isDraft: false, isRead: false,
    internetMessageHeaders: [{ name: "In-Reply-To", value: "<earlier@example.test>" },
      { name: "References", value: "<start@example.test>\r\n\t<earlier@example.test>" },
      { name: "X-Fixture-Private", value: "do not project this header" }],
    bodyPreview: "Not authoritative body content", webLink: "https://outlook.example.test/not-opened" };
  const attachmentObservation = { messageId: message.id, messageRevision: message.changeKey, complete: true,
    items: [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "attachment-1=", name: "brief.txt", contentType: "text/plain",
      size: 128, isInline: false, contentId: null }] };
  return { connection, message, options: { idType: "immutable", attachmentObservation } };
}
