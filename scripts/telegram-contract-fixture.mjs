// Invented Telegram Bot API shaped data. No bot token, chat export or real people.
export function telegramContractFixture() {
  const connection = { accountId: "account-fixture", id: "telegram-fixture", revision: 1, channel: "telegram", provider: "telegram-bot",
    externalId: "7000000001", identity: { kind: "bot", id: "7000000001", handle: "@fixture_room_bot", displayName: "Fixture Room Bot" },
    capabilities: { read: true, send: true, threads: true, edit: true } };
  const chat = { id: -1001000000001, type: "supergroup", title: "Fixture planning" };
  const avery = { id: 5000000001, is_bot: false, first_name: "Avery", last_name: "Quinn", username: "avery_q" };
  const lee = { id: 5000000002, is_bot: false, first_name: "Lee" };
  const updates = [
    { update_id: 900001, message: { message_id: 41, date: 1788948000, chat, from: avery, text: "Shall we work on this together?\n\nPrivate budget: 4200." } },
    { update_id: 900002, message: { message_id: 42, date: 1788948060, chat, from: lee, reply_to_message: { message_id: 41 }, caption: "Brief attached",
      document: { file_id: "BQACAgIAAxkBAAIFixtureDoc", file_unique_id: "AgADfixture", file_name: "brief.txt", mime_type: "text/plain", file_size: 128 } } },
    { update_id: 900003, message: { message_id: 43, date: 1788948120, chat, from: avery, caption: "Whiteboard",
      photo: [{ file_id: "AgACAgIAAxkBAAIFixtureSmall", file_unique_id: "AQADsmall", width: 90, height: 60, file_size: 900 },
        { file_id: "AgACAgIAAxkBAAIFixtureLarge", file_unique_id: "AQADlarge", width: 1280, height: 853, file_size: 90000 }] } },
    { update_id: 900004, callback_query: { id: "ignored-callback", from: avery, data: "not a message" } },
    { update_id: 900005, edited_message: { message_id: 41, date: 1788948000, edit_date: 1788948300, chat, from: avery, text: "Shall we work on this together?\n\nPrivate budget: 4300." } },
    { update_id: 900006, channel_post: { message_id: 7, date: 1788948360, chat: { id: -1001000000002, type: "channel", title: "Fixture announcements", username: "fixture_news" },
      sender_chat: { id: -1001000000002, type: "channel", title: "Fixture announcements", username: "fixture_news" }, text: "Release notes are out." } }
  ];
  return { connection, chat, updates, recording: { connection, updates, limit: 100 } };
}
