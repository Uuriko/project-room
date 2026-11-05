// A conservative collision guard, not a TOML validator. Tokenize strings and
// comments so quoted keys count, but examples inside values/comments do not.
// No config values are included in errors. Unknown syntax fails without writes.
import { BEGIN, END, planMarked } from './files.mjs';
import { mkdirSync, lstatSync, readFileSync, openSync, closeSync, writeFileSync, fchmodSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const codexConfigPath=(home,env={})=>join(env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home,'.codex'),'config.toml');
function configFile(path) {
  try {
    const stat=lstatSync(path);
    if(!stat.isFile() || stat.nlink!==1 || process.getuid && stat.uid!==process.getuid())throw Error('Codex config must be an owned regular file without links; no files changed');
    return {stat,text:readFileSync(path,'utf8')};
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export function writeCodexConfig(file) {
  const prior=configFile(file.path);
  if((prior?.text ?? null)!==file.before)throw Error('Codex config changed during setup; retry after reviewing it. No files changed');
  const directory=dirname(file.path);mkdirSync(directory,{recursive:true,mode:0o700});
  const temp=join(directory,'.project-room-'+randomUUID()+'.tmp');let fd;
  try {
    fd=openSync(temp,'wx',prior ? prior.stat.mode & 0o777 : 0o600);
    fchmodSync(fd,prior ? prior.stat.mode & 0o777 : 0o600);
    writeFileSync(fd,file.contents);fsyncSync(fd);closeSync(fd);fd=undefined;
    const current=configFile(file.path);
    if((current?.text ?? null)!==file.before || Boolean(current)!==Boolean(prior)
      || prior && (current.stat.ino!==prior.stat.ino || current.stat.mode!==prior.stat.mode))
      throw Error('Codex config changed during setup; retry after reviewing it. No files changed');
    renameSync(temp,file.path);
    const parent=openSync(directory,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

const conflict = () => new Error('Existing Codex config conflicts with the project-room server. Back up the selected Codex config.toml and reconcile its existing project-room settings manually, then retry. This check does not change files.');

function tokens(text) {
  const out = [];
  let i = 0, lineStart = true;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { if (c === '\n') { out.push({ kind: 'newline' }); lineStart = true; } i++; continue; }
    if (c === '#') {
      const end = text.indexOf('\n', i), stop = end < 0 ? text.length : end;
      const comment = text.slice(i, stop).trimEnd();
      if (lineStart && (comment === BEGIN || comment === END)) out.push({ kind: 'marker', value: comment, start: i, end: stop < text.length ? stop + 1 : stop });
      i = stop; continue;
    }
    lineStart = false;
    if (c === '"' || c === "'") {
      const multiline = text.slice(i, i + 3) === c.repeat(3);
      const delimiter = multiline ? c.repeat(3) : c;
      const start = i;
      i += delimiter.length;
      let closed = false;
      while (i < text.length) {
        if (c === '"' && text[i] === '\\') { i += 2; continue; }
        if (text.startsWith(delimiter, i)) {
          i += delimiter.length;
          // TOML multiline strings may finish with four or five quotes.
          if (multiline) { let extra = 0; while (text[i] === c && extra++ < 2) i++; }
          closed = true; break;
        }
        i++;
      }
      if (!closed) throw conflict();
      let value = null;
      if (!multiline) {
        const raw = text.slice(start, i);
        if (c === "'") value = raw.slice(1, -1);
        else {
          try { value = JSON.parse(raw.replace(/\\(?:U([0-9a-fA-F]{8})|.)/g, (match, hex) => hex ? JSON.stringify(String.fromCodePoint(parseInt(hex, 16))).slice(1, -1) : match)); }
          catch { throw conflict(); }
        }
      }
      out.push({ kind: 'word', value }); continue;
    }
    if ('[]{}=.,'.includes(c)) { out.push({ kind: c }); i++; continue; }
    const start = i;
    while (i < text.length && !/[\s\[\]{}=.,#"']/.test(text[i])) i++;
    if (i === start) throw conflict();
    out.push({ kind: 'word', value: text.slice(start, i) });
  }
  return out;
}

export function assertCodexConfigSafe(text) {
  if (!text) return null;
  const list = tokens(text);
  let i = 0, managed = false, seenBlock = false, section = [], span = null;
  const at = kind => list[i]?.kind === kind;
  const key = () => {
    const path = [];
    do {
      if (at('.')) i++;
      if (!at('word') || list[i].value === null) throw conflict();
      path.push(list[i++].value);
    } while (at('.'));
    return path;
  };
  const check = path => { if (!managed && path[0] === 'mcp_servers' && path[1] === 'project-room') throw conflict(); };
  const value = path => {
    // A directly assigned mcp_servers value (including an inline table) cannot
    // subsequently be extended with our generated server table.
    if (!managed && path.length === 1 && path[0] === 'mcp_servers') throw conflict();
    if (at('{')) {
      i++;
      while (i < list.length && !at('}')) {
        if (at('newline') || at(',')) { i++; continue; }
        const child = [...path, ...key()]; check(child);
        if (!at('=')) throw conflict(); i++; value(child);
      }
      if (!at('}')) throw conflict(); i++; return;
    }
    if (at('[')) {
      i++;
      while (i < list.length && !at(']')) { if (at('newline') || at(',')) i++; else value([...path, null]); }
      if (!at(']')) throw conflict(); i++; return;
    }
    // Scalars can contain punctuation (dates, floats); skip to the enclosing
    // value boundary. Quoted/multiline strings are already indivisible tokens.
    const start = i;
    while (i < list.length && !['newline', ',', '}', ']'].includes(list[i].kind)) i++;
    if (i === start) throw conflict();
  };
  while (i < list.length) {
    if (at('newline')) { i++; continue; }
    if (at('marker')) {
      const marker = list[i++];
      if (marker.value === BEGIN) { if (managed || seenBlock) throw conflict(); managed = true; seenBlock = true; span = { start: marker.start }; }
      else { if (!managed) throw conflict(); managed = false; span.end = marker.end; }
      continue;
    }
    if (at('[')) {
      i++; const array = at('['); if (array) i++;
      section = key(); check(section);
      if (!managed && array && section.length === 1 && section[0] === 'mcp_servers') throw conflict();
      if (!at(']')) throw conflict(); i++;
      if (array) { if (!at(']')) throw conflict(); i++; }
      continue;
    }
    const path = [...section, ...key()]; check(path);
    if (!at('=')) throw conflict(); i++; value(path);
  }
  if (managed) throw conflict();
  return span;
}

export function planCodexConfig(before, block) {
  const span = assertCodexConfigSafe(before);
  const wrapped = planMarked(null, block);
  if (span) return before.slice(0, span.start) + wrapped + before.slice(span.end);
  return (before ?? "") + (before && !before.endsWith("\n") ? "\n" : "") + wrapped;
}
