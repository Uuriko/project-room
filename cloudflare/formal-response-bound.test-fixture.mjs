import entry, {IdentityLinkRoom} from './current-identity-link.test-fixture.mjs';

export class FormalResponseBoundRoom extends IdentityLinkRoom {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!['/answer-boundary', '/answer-cold'].includes(path)) return super.fetch(request);
    try {
      const s = this.store, {identity, key} = await this.ctx.storage.get('fixture');
      s.room = () => { throw Error('Full room hydration forbidden'); };
      const body = '\u0001'.repeat(8192);
      if (path === '/answer-boundary') {
        s.command(key, 'commons', {id:'boundary-question', type:'message.posted', data:{
          messageId:'boundary-question', body:'Give the complete boundary answer',
          toMemberId:identity.identityId, requestKind:'reply'
        }});
        const selected = s.replyRequests.selected(identity.secret, 'commons', 'boundary-question');
        if (selected.page.hasMore) throw Error('Incomplete request preparation');
        const recipe = selected.responseHttpActions.find(a => a.command.data.responseOutcome === 'answered');
        recipe.command.data.body = body;
        const bytes = new TextEncoder().encode(JSON.stringify(recipe.command)).length;
        s.command(identity.secret, 'commons', recipe.command);
        const sequence = s.headSequence('commons');
        s.command(identity.secret, 'commons', recipe.command);
        if (s.headSequence('commons') !== sequence) throw Error('Retry created another event');
        await this.ctx.storage.put('boundary-answer', {command:recipe.command, sequence});
        return Response.json({characters:body.length, commandBytes:bytes, exactRetry:true});
      }
      const saved = await this.ctx.storage.get('boundary-answer');
      const selected = s.replyRequests.selected(identity.secret, 'commons', 'boundary-question');
      const answer = selected.page.items.find(item => item.kind === 'answered')?.message;
      if (selected.page.hasMore || selected.request.status !== 'answered'
          || answer?.body !== body || answer.authorId !== identity.identityId
          || answer.toMemberId !== 'owner' || answer.replyToId !== 'boundary-question')
        throw Error('Cold result lost exact body or participant binding');
      s.command(identity.secret, 'commons', saved.command);
      if (s.headSequence('commons') !== saved.sequence) throw Error('Cold retry duplicated the answer');
      return Response.json({status:selected.request.status, characters:answer.body.length,
        exactBody:true, exactParticipants:true, coldRetry:true});
    } catch (error) {
      return Response.json({error:{code:error.code, message:error.message}}, {status:500});
    }
  }
}

export default entry;
