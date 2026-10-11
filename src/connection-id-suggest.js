// r35-4 (John's Tab r35 polish list): the add-connection dialog prefilled the
// connection id with a fixed default ("mailbox" for email, "telegram-bot" for
// Telegram, "whatsapp" for WhatsApp), so adding a second connection of the
// same kind failed with "That id already belongs to a different bot or
// mailbox." Suggest a base id that isn't taken, appending -2, -3, ... when it
// is. Pure and DOM-free so it can be unit tested directly.
//
// `existingIds` is any iterable (or Set) of taken connection ids.
export function suggestConnectionId(base, existingIds) {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
