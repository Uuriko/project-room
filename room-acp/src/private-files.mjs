// Credential/state file privacy is an OS property, not a JSON convention.
// Windows chmod does not implement owner/group distinctions. Use the bundled
// Windows PowerShell/.NET ACL API; no shell, downloaded tool, or credential in process arguments/output.
import { constants, mkdirSync, chmodSync, lstatSync, fstatSync, openSync, closeSync,
  readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, parse } from 'node:path';
import { randomUUID } from 'node:crypto';

const windows = process.platform === 'win32';
const powershell = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
  $r = $reader.ReadToEnd() | ConvertFrom-Json
  $p = [IO.Path]::GetFullPath([string]$r.path)
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
  $entry = if ($r.directory) { [IO.DirectoryInfo]::new($p) } else { [IO.FileInfo]::new($p) }
  $cursor = if ($r.operation -eq 'create-directory') { $entry.Parent } else { $entry }
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'link' }
    $cursor = if ($cursor -is [IO.DirectoryInfo]) { $cursor.Parent } else { $cursor.Directory }
  }
  if ($r.operation -eq 'secure-new' -or $r.operation -eq 'create-directory') {
    if ($r.operation -eq 'secure-new') {
      $old = $entry.GetAccessControl()
      if ($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'owner' }
    }
    $acl = if ($r.directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = if ($r.directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in $trusted) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    if ($r.operation -eq 'create-directory') {
      # Apply ACL at creation, then publish by an exclusive same-parent move.
      # DirectoryInfo.Create alone silently accepts an existing directory.
      $temporary = [IO.DirectoryInfo]::new([IO.Path]::Combine($entry.Parent.FullName, '.room-private-' + [Guid]::NewGuid().ToString('N')))
      $temporary.Create($acl)
      try {
        try { [IO.Directory]::Move($temporary.FullName, $p) }
        catch [IO.IOException] {
          if ([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)) { [Console]::Out.Write('exists'); exit 0 }
          throw
        }
      } finally { if ([IO.Directory]::Exists($temporary.FullName)) { $temporary.Delete($false) } }
    } else { $entry.SetAccessControl($acl) }
  }
  $acl = $entry.GetAccessControl()
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($r.operation -eq 'parent') {
    if ($owner -notin $trusted) { throw 'parent owner' }
  } elseif ($owner -ne $user.Value) { throw 'owner' }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if ($rules.Count -eq 0) { throw 'empty ACL' }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($r.operation -eq 'parent' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($rule.IdentityReference.Value -in $trusted) { continue }
    # Parent read/traverse is harmless; others must not replace our directory.
    $danger = if ($r.operation -eq 'parent') { 0xD0156 } else { 0x1F01FF }
    if (([int]$rule.FileSystemRights -band $danger) -ne 0) { throw 'foreign grant' }
  }
  [Console]::Out.Write('private')
} catch { [Console]::Error.Write('Private state ACL could not be verified'); exit 1 }
`;

function refuse() {
  const error = new Error('Private state requires private files and directories with current-user ownership and no links');
  error.code = 'private_state_not_private';
  throw error;
}
function noLinkedComponents(path) {
  let cursor = resolve(path);
  for (;;) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) refuse();
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
function windowsAcl(path, directory, operation = 'verify') {
  noLinkedComponents(operation === 'create-directory' ? dirname(path) : path);
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) refuse();
  try {
    const output = execFileSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershell], {
        input: JSON.stringify({path: resolve(path), directory, operation}), encoding: 'utf8',
        // First launch on a cold Windows host can exceed ten seconds.
        windowsHide: true, timeout: 30000, maxBuffer: 16384,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    if (operation === 'create-directory' && output === 'exists') return false;
    if (output !== 'private') refuse();
    return true;
  } catch { refuse(); }
}
export function assertPrivatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) refuse();
  if (windows) windowsAcl(path, directory);
  else if (!process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077)) refuse();
  return stat;
}
export function syncPrivateDirectory(path) {
  // Node cannot provide a directory fsync handle on Windows. File fsync remains
  // mandatory; do not misreport a committed rename as a failed directory flush.
  // This is process-interruption recovery, not a power-loss durability promise.
  if (windows) return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function ensurePrivateDirectory(path, {recursive = false, exclusive = false} = {}) {
  path = resolve(path);
  if (windows) {
    const parent = dirname(path);
    if (recursive) {
      try { lstatSync(parent); } catch (error) {
        if (error.code !== 'ENOENT' || parent === parse(parent).root) throw error;
        ensurePrivateDirectory(parent, {recursive: true});
      }
    }
    // No broad HOME/.config ACL rewrite: inspect the parent only.
    windowsAcl(parent, true, 'parent');
  }
  let created = false;
  if (windows) {
    created = windowsAcl(path, true, 'create-directory');
    if (!created && exclusive) throw Object.assign(new Error('Private directory already exists'), {code: 'EEXIST'});
  } else {
    try { created = mkdirSync(path, {recursive, mode: 0o700}) !== undefined || !recursive; }
    catch (error) { if (error.code !== 'EEXIST' || exclusive) throw error; }
  }
  assertPrivatePath(path, true);
  if (created) syncPrivateDirectory(dirname(path));
  return path;
}
export function openNewPrivateFile(path) {
  assertPrivatePath(dirname(path), true);
  const fd = openSync(path, 'wx', 0o600);
  try {
    if (windows) windowsAcl(path, false, 'secure-new');
    else chmodSync(path, 0o600);
    assertPrivatePath(path);
    return fd;
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(path); } catch { /* no credentials have been written */ }
    throw error;
  }
}
export function openPrivateRead(path) {
  const before = assertPrivatePath(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino) refuse();
    if (windows) windowsAcl(path, false);
    else if (!process.getuid || actual.uid !== process.getuid() || actual.mode & 0o077) refuse();
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
export function readPrivateJson(path, maxBytes = 131072) {
  const fd = openPrivateRead(path);
  try {
    if (fstatSync(fd).size > maxBytes) throw Error('Private state exceeds its size limit');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
export function atomicPrivateJson(path, value, {maxBytes = 131072} = {}) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > maxBytes) throw Error('Private state exceeds its size limit');
  assertPrivatePath(dirname(path), true);
  try { assertPrivatePath(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = path + '.' + randomUUID(); let fd;
  try {
    fd = openNewPrivateFile(temp);
    writeFileSync(fd, serialized); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    assertPrivatePath(path);
    syncPrivateDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
