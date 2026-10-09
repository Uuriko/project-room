// audit — example plugin: append-only message log in namespaced storage.
plugin.on('room.message.posted', (payload) => {
  const key = 'messages';
  const log = plugin.api.storage.get(key) || [];
  log.push({ ts: Date.now(), author: payload.author, body: String(payload.body).slice(0, 200) });
  plugin.api.storage.set(key, log);
  plugin.api.log('debug', `audited message #${log.length}`);
  return { ok: true, count: log.length };
});
