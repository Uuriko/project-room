// Local Worker qualification only; never deployed.
import { safeGmailHtml } from '../server/gmail-content.mjs';
export default {fetch(){
 const value=safeGmailHtml('<html><body>'+'<iframe>'.repeat(4000)+'</body></html>');
 const safe=safeGmailHtml('<p>Readable <a href="https://example.test/">link</a><script>bad()</script></p>');
 return Response.json({bounded:!/<iframe\b/i.test(value),readable:safe.includes('Readable'),scriptRemoved:!/<script\b/i.test(safe),linkProtected:safe.includes('rel="noopener noreferrer"')});
}};
