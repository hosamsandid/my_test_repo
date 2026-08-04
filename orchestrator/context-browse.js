'use strict';

// context-browse.js — pure helpers for BROWSING the read-only host-folder
// context mount (#1286, follow-up to #1283).
//
// The mount lives at `/context` inside the agent's container and nowhere else:
// the admin console reads the pool volume from its OWN container, so it can
// neither see nor safely re-mount that host directory. The only place the
// folder exists is the agent container — so listing/reading it runs there, as a
// one-shot exec (container-exec.js), and this module owns everything that can
// be decided without I/O:
//
//   • the request-side path guard (what a caller may ask for at all),
//   • the browse program executed inside the container (its own guard —
//     realpath containment under /context, so a symlink pointing at the host's
//     filesystem cannot be followed),
//   • parsing/normalising what comes back.
//
// Dependency-free and unit-tested (`node --test orchestrator/context-browse.test.js`)
// in the process-template.js / context-mount.js discipline: the trust decisions
// are readable in one file, and the fs/exec side stays a thin adapter.

const { CONTEXT_MOUNT_TARGET } = require('./context-mount');

// Read cap for the file viewer — same 512 KB the workspace browser uses, so a
// context file and a workspace file behave identically in the UI.
const CONTEXT_FILE_MAX_BYTES = 512 * 1024;

// Cap for the raw download / inline-image path. Higher than the viewer cap
// (whole PDFs and spreadsheets are the point of this feature) but still bounded:
// the bytes travel base64-encoded through an exec pipe, so this is deliberately
// not "unlimited" the way the workspace `/download` stream is.
const CONTEXT_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

// Defensive bound on a caller-supplied relative path.
const MAX_REL_LEN = 4096;

// Upper bound on entries returned for one directory. A synced host folder can
// hold anything; the UI is a tree, not a data grid.
const MAX_LIST_ENTRIES = 5000;

// Timeout for one browse exec. Generous — a cloud-synced folder may need to
// materialise a placeholder file on first read — but never unbounded.
const BROWSE_TIMEOUT_MS = 20000;

function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// Validate + normalise a caller-supplied path RELATIVE to the mount root.
// Returns { ok: true, rel } (rel is '' for the mount root itself) or
// { ok: false, error }. Absolute paths, `..` traversal, NUL/control characters
// and absurd lengths are refused here; symlink containment can only be decided
// inside the container and is enforced by the browse program.
function normalizeContextRel(input) {
  const raw = input == null ? '' : String(input);
  if (raw.length > MAX_REL_LEN) return { ok: false, error: 'path too long' };
  if (hasControlChar(raw)) return { ok: false, error: 'path contains control characters' };
  // Tolerate a leading slash (the UI keys the mount root as '/context') but
  // never let it mean "absolute host path" — everything is relative to the root.
  const stripped = raw.replace(/^\/+/, '');
  const segments = [];
  for (const seg of stripped.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return { ok: false, error: 'invalid path' };
    segments.push(seg);
  }
  return { ok: true, rel: segments.join('/') };
}

// The program executed inside the agent container. Kept as a line array so the
// Python source stays readable and free of JS template-literal escaping.
//
// Contract: it ALWAYS exits 0 and always writes a single JSON object to stdout —
// either a result or `{error, code}`. That keeps the exec adapter free of
// exit-code archaeology and makes every failure mode explicit.
const BROWSE_PROGRAM = [
  'import base64, json, os, sys',
  '',
  'ROOT = "' + CONTEXT_MOUNT_TARGET + '"',
  'MAX_ENTRIES = ' + MAX_LIST_ENTRIES,
  '',
  'def emit(obj):',
  '    sys.stdout.write(json.dumps(obj))',
  '    sys.exit(0)',
  '',
  'def fail(msg, code):',
  '    emit({"error": msg, "code": code})',
  '',
  'def contained(p, root):',
  '    return p == root or p.startswith(root + os.sep)',
  '',
  'def describe(base, name, root):',
  '    full = os.path.join(base, name)',
  '    info = {"name": name, "type": "file", "size": 0, "mtime": 0, "hidden": name.startswith(".")}',
  '    try:',
  '        st = os.stat(full)',
  '        info["size"] = st.st_size',
  '        info["mtime"] = int(st.st_mtime * 1000)',
  '        if os.path.isdir(full):',
  '            info["type"] = "dir"',
  '        elif not os.path.isfile(full):',
  '            info["type"] = "other"',
  '    except OSError:',
  '        info["type"] = "other"',
  '        return info',
  '    # A symlink escaping the mount is listed but never navigable: the read',
  '    # path realpath-checks too, so this only makes the UI honest.',
  '    try:',
  '        if os.path.islink(full) and not contained(os.path.realpath(full), root):',
  '            info["type"] = "other"',
  '            info["escapes"] = True',
  '    except OSError:',
  '        info["type"] = "other"',
  '    return info',
  '',
  'def main():',
  '    mode = sys.argv[1] if len(sys.argv) > 1 else ""',
  '    rel = sys.argv[2] if len(sys.argv) > 2 else ""',
  '    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 0',
  '    if not os.path.isdir(ROOT):',
  '        fail("context folder is not mounted", "not-mounted")',
  '    root = os.path.realpath(ROOT)',
  '    target = os.path.realpath(os.path.join(root, rel))',
  '    if not contained(target, root):',
  '        fail("invalid path", "invalid-path")',
  '    if not os.path.exists(target):',
  '        fail("not found", "not-found")',
  '    if mode == "list":',
  '        if not os.path.isdir(target):',
  '            fail("not a directory", "not-a-dir")',
  '        try:',
  '            names = sorted(os.listdir(target))',
  '        except PermissionError:',
  '            fail("permission denied", "denied")',
  '        except OSError:',
  '            fail("listing failed", "io-error")',
  '        truncated = len(names) > MAX_ENTRIES',
  '        items = [describe(target, n, root) for n in names[:MAX_ENTRIES]]',
  '        emit({"path": rel, "items": items, "truncated": truncated})',
  '    if mode == "read":',
  '        if not os.path.isfile(target):',
  '            fail("not a file", "not-a-file")',
  '        try:',
  '            size = os.path.getsize(target)',
  '            with open(target, "rb") as fh:',
  '                data = fh.read(limit) if limit > 0 else fh.read()',
  '            mtime = int(os.path.getmtime(target) * 1000)',
  '        except PermissionError:',
  '            fail("permission denied", "denied")',
  '        except OSError as exc:',
  '            # A cloud-sync placeholder (OneDrive/iCloud "online-only" file)',
  '            # exists and stats fine but cannot be hydrated from inside the',
  '            # container — the kernel answers EDEADLK/EAGAIN. Report that as',
  '            # its own state: the fix is on the host, not here.',
  '            if getattr(exc, "errno", 0) in (11, 35):',
  '                fail("file is online-only on the host and was not downloaded", "not-materialised")',
  '            fail("read failed", "io-error")',
  '        emit({"path": rel, "size": size, "read": len(data), "truncated": size > len(data),',
  '              "mtime": mtime, "encoding": "base64",',
  '              "content": base64.b64encode(data).decode("ascii")})',
  '    fail("unknown mode", "bad-mode")',
  '',
  'main()',
].join('\n');

// argv for a directory listing / a capped file read. The mode and the numeric
// cap are code-controlled; only `rel` comes from the caller, and it arrives
// pre-normalised and as a distinct argv element — never interpolated into a
// shell string (there is no shell in this path at all).
function buildListArgv(rel) {
  return ['python3', '-c', BROWSE_PROGRAM, 'list', String(rel || '')];
}

function buildReadArgv(rel, maxBytes) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : CONTEXT_FILE_MAX_BYTES;
  return ['python3', '-c', BROWSE_PROGRAM, 'read', String(rel || ''), String(cap)];
}

// Parse the program's stdout. Returns { ok: true, result } or { ok: false,
// error, code } — the latter both for an explicit error envelope and for
// unparseable output (a crashed interpreter, a truncated pipe).
function parseBrowseOutput(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  if (!text) return { ok: false, error: 'no output from context browse', code: 'exec-failed' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'unreadable output from context browse', code: 'exec-failed' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'unreadable output from context browse', code: 'exec-failed' };
  }
  if (parsed.error) {
    return { ok: false, error: String(parsed.error), code: String(parsed.code || 'error') };
  }
  return { ok: true, result: parsed };
}

// HTTP status for a browse error code — one table so the orchestrator route and
// the console proxy can't drift apart.
function statusForBrowseCode(code) {
  switch (code) {
    case 'invalid-path':
    case 'not-a-dir':
    case 'not-a-file':
    case 'bad-mode':
      return 400;
    case 'denied':
      return 403;
    // The file is there but the host never downloaded it — not our failure,
    // and not a 404 either: it exists and will read fine once materialised.
    case 'not-materialised':
      return 409;
    case 'not-found':
    case 'not-mounted':
      return 404;
    default:
      return 500;
  }
}

// Stable ordering for a listing: directories first, then case-insensitive by
// name — identical to the workspace browser's `/tree`, so the two trees read
// the same way.
function sortContextItems(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => {
    const aDir = a && a.type === 'dir';
    const bDir = b && b.type === 'dir';
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    return String(a && a.name).localeCompare(String(b && b.name), undefined, { sensitivity: 'base' });
  });
  return list;
}

module.exports = {
  CONTEXT_FILE_MAX_BYTES,
  CONTEXT_DOWNLOAD_MAX_BYTES,
  MAX_LIST_ENTRIES,
  BROWSE_TIMEOUT_MS,
  BROWSE_PROGRAM,
  normalizeContextRel,
  buildListArgv,
  buildReadArgv,
  parseBrowseOutput,
  statusForBrowseCode,
  sortContextItems,
};
