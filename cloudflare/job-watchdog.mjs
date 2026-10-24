// One object for every room subject's heartbeat. It does not run jobs.
// rebootAlarm on the subject only sets the alarm; the subject's own alarm
// does the work. Schema lives here, not in RoomStore: DurableDatabase
// refuses a database that has no writer permit.
import { DurableObject } from 'cloudflare:workers';
import {
  WATCHDOG_NAME, WATCHDOG_PERIOD_MS, WATCHDOG_SUBJECT,
  ensureWatchdogStore, markRebooted, planWatchdogReboots, readWatchdogHealth, recordWatchdogBeat
} from '../server/job-watchdog-store.mjs';

export { WATCHDOG_NAME };

function database(sql) {
  return {
    exec(query) { sql.exec(query); },
    prepare(query) {
      return {
        all: (...args) => sql.exec(query, ...args).toArray(),
        get: (...args) => sql.exec(query, ...args).toArray()[0],
        run: (...args) => { sql.exec(query, ...args); }
      };
    }
  };
}

export class JobWatchdog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = ctx;
    this.env = env;
    this.db = database(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => { ensureWatchdogStore(this.db); });
  }
  async beat(beat) {
    recordWatchdogBeat(this.db, beat, Date.now());
    return this.ensureArmed();
  }
  async readHealth() {
    return readWatchdogHealth(this.db, Date.now());
  }
  async ensureArmed() {
    const current = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (current != null && current > now) return { armed: false, alarmAt: current };
    const alarmAt = now + WATCHDOG_PERIOD_MS;
    await this.ctx.storage.setAlarm(alarmAt);
    return { armed: true, alarmAt };
  }
  async alarm() {
    const now = Date.now();
    const due = planWatchdogReboots(this.db, now);
    let rebooted = 0;
    for (const name of due) {
      if (name !== WATCHDOG_SUBJECT) continue;
      try {
        await this.env.ROOM.getByName(name).rebootAlarm();
        markRebooted(this.db, name, now);
        rebooted += 1;
      } catch (error) {
        console.error(`[job-watchdog] reboot failed: ${String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
      }
    }
    console.info(JSON.stringify({ event: 'room.watchdog', rebooted, stalled: due.length }));
    await this.ensureArmed();
  }
}
