import {ProjectRoom} from './room.mjs';
import {seedPostOAuth} from '../tests/helpers/work-linked-post-oauth.mjs';

export class AttentionWaitRoom extends ProjectRoom {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__seed') {
      const saved = seedPostOAuth(this.store, {scopes: ['chat:read', 'work:read']});
      await this.ctx.storage.put('attention-test', saved);
      return Response.json({token: saved.identitySecret, after: this.store.headSequence('commons')});
    }
    if (path === '/__post') {
      const saved = await this.ctx.storage.get('attention-test');
      const id = new URL(request.url).searchParams.get('id');
      this.store.command(saved.owner, 'commons', {id, type: 'message.posted', data: {messageId: id, body: 'Native private attention', toMemberId: saved.identityId}});
      return Response.json({ok: true});
    }
    this.store.room = () => { throw Error('Whole-room hydration forbidden'); };
    return super.fetch(request);
  }
}
export default {fetch(request, env) {
  const headers = new Headers(request.headers);
  headers.set('Host', 'room.example.test');
  headers.set('x-room-visitor-ip', '192.0.2.1');
  return env.ROOM.getByName('attention-test').fetch(new Request(request, {headers, signal: request.signal}));
}};
