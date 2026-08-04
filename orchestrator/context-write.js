'use strict';

// context-write.js — pure helpers for WRITING into a read-WRITE host-folder
// context mount (follow-up to #1286's read-only browsing).
//
// Same shape and discipline as context-browse.js: the mount lives ONLY inside
// the agent's container, so every mutation runs there as a one-shot exec
// (container-exec.js), and this module owns everything decidable without I/O:
//
//   • the request-side path guard (reuses normalizeContextRel from browse),
//   • the WRITE_PROGRAM executed inside the container — its own guard is a
//     realpath containment check under /context, identical to the browse
//     program, so a symlink pointing at the host filesystem is never followed;
//   • the argv builders and the error-code → HTTP-status table.
//
// Writes only reach here for a mount whose `readWrite` is true (enforced by the
// orchestrator route before this runs) AND only ever land on a read-write bind
// mount — a read-only mount rejects every write at the kernel (EROFS), which is
// the ultimate backstop no matter what the control plane believes.
//
// Upload is NOT a WRITE_PROGRAM mode: file bytes cannot travel through an argv
// (ARG_MAX) or stdin (container-exec is stdin-less), so the orchestrator streams
// them in via the libpod archive endpoint. This module still owns the one exec
// upload needs — `prepare-upload`, which validates the target directory and
// returns the collision-free container path the archive extraction targets.
//
// Dependency-free and unit-tested (`node --test orchestrator/context-write.test.js`).

const { CONTEXT_MOUNT_TARGET } = require('./context-mount');
const { normalizeContextRel, statusForBrowseCode } = require('./context-browse');

// Hard cap on a single uploaded file. Matches the workspace upload limit so the
// two surfaces behave the same; the bytes travel as a raw octet-stream to the
// orchestrator and then a tar into the container, never base64-inflated.
const CONTEXT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// Timeout for one write exec. A delete of a large tree or a rename on a
// cloud-synced folder can take a moment; still bounded.
const WRITE_TIMEOUT_MS = 30000;

// The program executed inside the agent container for a mutation. Like the
// browse program it ALWAYS exits 0 and writes a single JSON object to stdout —
// a result or `{error, code}` — so the exec adapter never reads exit codes.
const WRITE_PROGRAM = [
  'import json, os, shutil, sys',
  '',
  'ROOT = "' + CONTEXT_MOUNT_TARGET + '"',
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
  '# Resolve a caller rel path under the mount root, refusing anything that',
  '# escapes it (via `..` already stripped request-side, or via a symlink here).',
  'def resolve(root, rel):',
  '    target = os.path.realpath(os.path.join(root, rel))',
  '    if not contained(target, root):',
  '        fail("invalid path", "invalid-path")',
  '    return target',
  '',
  '# For an entry we intend to remove/rename we must operate on the LINK, not',
  '# its target — so resolve the parent, then join the plain basename.',
  'def resolve_entry(root, rel):',
  '    rel = rel.strip("/")',
  '    if not rel:',
  '        fail("refusing to touch the mount root", "invalid-path")',
  '    parent_rel, _, base = rel.rpartition("/")',
  '    parent = os.path.realpath(os.path.join(root, parent_rel))',
  '    if not contained(parent, root):',
  '        fail("invalid path", "invalid-path")',
  '    full = os.path.join(parent, base)',
  '    # The joined path itself must stay inside (guards `base` == ".." slipping',
  '    # through, though the request guard already rejects it).',
  '    if not contained(os.path.realpath(parent), root) or not contained(full, root):',
  '        fail("invalid path", "invalid-path")',
  '    return full, base',
  '',
  'def unique_name(base_dir, entry):',
  '    # entry may carry subdirs (folder upload); only the leaf is de-duplicated.',
  '    head, _, leaf = entry.rpartition("/")',
  '    candidate = entry',
  '    if not os.path.exists(os.path.join(base_dir, candidate)):',
  '        return candidate',
  '    stem, dot, ext = leaf.partition(".")',
  '    suffix = ("." + ext) if dot else ""',
  '    n = 2',
  '    while n < 10000:',
  '        leaf2 = stem + " (" + str(n) + ")" + suffix',
  '        cand = (head + "/" + leaf2) if head else leaf2',
  '        if not os.path.exists(os.path.join(base_dir, cand)):',
  '            return cand',
  '        n += 1',
  '    return (head + "/" + leaf + " (" + str(os.getpid()) + ")") if head else (leaf + " (" + str(os.getpid()) + ")")',
  '',
  'def do_delete(root, rel):',
  '    full, _ = resolve_entry(root, rel)',
  '    if not os.path.lexists(full):',
  '        fail("not found", "not-found")',
  '    is_dir = os.path.isdir(full) and not os.path.islink(full)',
  '    try:',
  '        if is_dir:',
  '            shutil.rmtree(full)',
  '        else:',
  '            os.remove(full)',
  '    except PermissionError:',
  '        fail("permission denied", "denied")',
  '    except OSError as exc:',
  '        if getattr(exc, "errno", 0) == 30:',
  '            fail("the host folder is mounted read-only", "read-only")',
  '        fail("delete failed", "io-error")',
  '    emit({"deleted": rel, "type": "dir" if is_dir else "file"})',
  '',
  'def do_move(root, from_rel, to_dir_rel):',
  '    src, base = resolve_entry(root, from_rel)',
  '    if not os.path.lexists(src):',
  '        fail("source not found", "not-found")',
  '    dest_dir = resolve(root, to_dir_rel)',
  '    if not os.path.isdir(dest_dir):',
  '        fail("target directory not found", "not-a-dir")',
  '    # No moving a directory into itself or one of its own descendants.',
  '    if os.path.isdir(src) and (dest_dir == src or dest_dir.startswith(src + os.sep)):',
  '        fail("cannot move a folder into itself", "invalid-path")',
  '    if os.path.realpath(os.path.dirname(src)) == os.path.realpath(dest_dir):',
  '        fail("item is already in that directory", "no-op")',
  '    dest = os.path.join(dest_dir, base)',
  '    if os.path.lexists(dest):',
  '        fail("an item with that name already exists there", "exists")',
  '    try:',
  '        os.rename(src, dest)',
  '    except PermissionError:',
  '        fail("permission denied", "denied")',
  '    except OSError as exc:',
  '        if getattr(exc, "errno", 0) == 30:',
  '            fail("the host folder is mounted read-only", "read-only")',
  '        fail("move failed", "io-error")',
  '    emit({"moved": base})',
  '',
  'def do_prepare_upload(root, dir_rel, name):',
  '    base_dir = resolve(root, dir_rel)',
  '    if not os.path.isdir(base_dir):',
  '        fail("target directory not found", "not-a-dir")',
  '    # `name` is sanitised segment-by-segment by the orchestrator; re-clean it',
  '    # here defensively and refuse anything that could escape the base dir.',
  '    parts = [p for p in name.replace("\\\\", "/").split("/") if p not in ("", ".", "..")]',
  '    if not parts:',
  '        fail("invalid filename", "invalid-path")',
  '    entry = "/".join(parts)',
  '    if not contained(os.path.realpath(os.path.join(base_dir, entry)), root):',
  '        fail("invalid path", "invalid-path")',
  '    emit({"base": base_dir, "entry": unique_name(base_dir, entry)})',
  '',
  'def main():',
  '    mode = sys.argv[1] if len(sys.argv) > 1 else ""',
  '    if not os.path.isdir(ROOT):',
  '        fail("context folder is not mounted", "not-mounted")',
  '    root = os.path.realpath(ROOT)',
  '    if mode == "delete":',
  '        do_delete(root, sys.argv[2] if len(sys.argv) > 2 else "")',
  '    if mode == "move":',
  '        do_move(root, sys.argv[2] if len(sys.argv) > 2 else "", sys.argv[3] if len(sys.argv) > 3 else "")',
  '    if mode == "prepare-upload":',
  '        do_prepare_upload(root, sys.argv[2] if len(sys.argv) > 2 else "", sys.argv[3] if len(sys.argv) > 3 else "")',
  '    fail("unknown mode", "bad-mode")',
  '',
  'main()',
].join('\n');

// argv builders. The mode is code-controlled; only the pre-normalised rel paths
// / sanitised name come from the caller, and each is a distinct argv element —
// never interpolated into a shell string (there is no shell in this path).
function buildDeleteArgv(rel) {
  return ['python3', '-c', WRITE_PROGRAM, 'delete', String(rel || '')];
}

function buildMoveArgv(fromRel, toDirRel) {
  return ['python3', '-c', WRITE_PROGRAM, 'move', String(fromRel || ''), String(toDirRel || '')];
}

function buildPrepareUploadArgv(dirRel, name) {
  return ['python3', '-c', WRITE_PROGRAM, 'prepare-upload', String(dirRel || ''), String(name || '')];
}

// HTTP status for a write error code. Reuses the browse table and adds the
// write-only codes so the orchestrator route and console proxy can't drift.
function statusForWriteCode(code) {
  switch (code) {
    case 'exists':
      return 409;
    case 'no-op':
      return 400;
    case 'read-only':
      return 403;
    default:
      return statusForBrowseCode(code);
  }
}

// ustar's name field is 100 bytes; a single path component longer than that
// cannot be represented (there is no '/' to split on into the 155-byte prefix),
// so components are capped here. The extension is preserved when trimming a
// leaf so `report.<verylong>.xlsx` keeps its `.xlsx`.
const MAX_SEGMENT_BYTES = 100;

function capSegmentBytes(seg) {
  if (Buffer.byteLength(seg) <= MAX_SEGMENT_BYTES) return seg;
  const dot = seg.lastIndexOf('.');
  const ext = dot > 0 ? seg.slice(dot) : '';
  const room = MAX_SEGMENT_BYTES - Buffer.byteLength(ext);
  let stem = dot > 0 ? seg.slice(0, dot) : seg;
  // Trim the stem byte-wise (UTF-8 safe: drop trailing chars until it fits).
  while (stem && Buffer.byteLength(stem) > Math.max(room, 1)) stem = stem.slice(0, -1);
  const out = (stem + ext) || seg.slice(0, MAX_SEGMENT_BYTES);
  return Buffer.byteLength(out) <= MAX_SEGMENT_BYTES ? out : Buffer.from(out).slice(0, MAX_SEGMENT_BYTES).toString('utf8');
}

// Sanitise ONE path segment for an upload entry — the same allowlist the
// workspace upload uses, so a file lands with the same name on either surface.
// Returns '' for a segment that sanitises to nothing (caller drops it).
function sanitizeUploadSegment(seg) {
  const s = String(seg == null ? '' : seg);
  // basename first (strip any directory component a single segment shouldn't
  // carry), then the allowlist, then trim, then cap to the ustar name field.
  const bare = s.split(/[\\/]/).pop();
  const cleaned = bare.replace(/[^\w\-. ()[\]]/g, '_').trim();
  return cleaned ? capSegmentBytes(cleaned) : cleaned;
}

// Turn a caller-supplied relative file path (flat name or folder-upload
// subpath) into a clean, containment-safe entry: each segment sanitised,
// `.`/`..`/empty dropped. Returns '' when nothing survives (caller rejects).
function sanitizeUploadName(name) {
  const raw = String(name == null ? '' : name).replace(/\\/g, '/');
  const out = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') continue;
    const clean = sanitizeUploadSegment(seg);
    if (clean && clean !== '.' && clean !== '..') out.push(clean);
  }
  return out.join('/');
}

module.exports = {
  CONTEXT_UPLOAD_MAX_BYTES,
  WRITE_TIMEOUT_MS,
  WRITE_PROGRAM,
  normalizeContextRel, // re-exported for symmetry with context-browse
  buildDeleteArgv,
  buildMoveArgv,
  buildPrepareUploadArgv,
  statusForWriteCode,
  sanitizeUploadSegment,
  sanitizeUploadName,
};
