// greet — example plugin: greets members on join, using config + timers.
plugin.on('room.member.joined', (payload) => {
  const who = payload && payload.member ? payload.member : 'friend';
  plugin.api.log('info', `${plugin.config.greeting}, ${who}!`);
  // Deferred follow-up proves timers work inside the sandbox.
  setTimeout(() => {
    plugin.api.log('info', `psst, ${who} — enjoy the room`);
  }, 10);
  return { ok: true, greeted: who };
});
