import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
export class MessageMitigationRoom extends ProjectRoom {
  async fetch(request) {
    if (new URL(request.url).pathname === '/__seed') {
      const events = initialRoom();
      events.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: 'other', displayName: 'Other', kind: 'agent', permissions: []}}));
      this.store.initialize(events, {representation: 'normalized-current-v1'});
      return Response.json({owner: this.store.issueAccessKey('commons', 'owner'), other: this.store.issueAccessKey('commons', 'other')});
    }
    this.store.room = () => { throw Error('Whole-room reads forbidden'); };
    return super.fetch(request);
  }
}
export default {fetch(request, env) {
  const url = new URL(request.url), surface = url.searchParams.get('surface');
  url.searchParams.delete('surface');
  const headers = new Headers(request.headers);
  headers.set('Host', 'room.example.test');
  headers.set('x-room-visitor-ip', '192.0.2.1');
  return env.ROOM.getByName(surface).fetch(new Request(url, new Request(request, {headers})));
}};
