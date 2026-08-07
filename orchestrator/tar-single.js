'use strict';

// tar-single.js — build a minimal POSIX ustar archive in memory, with no
// dependency, for the context-mount upload path.
//
// The read-write host-folder mount (this feature) lives only inside the agent
// container. File bytes get there through the libpod archive endpoint
// (`PUT /containers/{id}/archive?path=<dir>`), which extracts a tar under a
// container directory — the same mechanism as `podman cp`. That is the only
// upload channel that avoids ARG_MAX (argv) and container-exec's deliberate
// stdin-less design, and it stays byte-exact (no base64 inflation).
//
// We only ever build a handful of small entries (one file, occasionally with a
// folder-upload subpath), so this is intentionally tiny: a single regular-file
// entry type, name split across name/prefix when long, everything else zero.
// Extraction (Docker/podman `archive.Untar`) creates missing parent directories
// for a file entry, so no explicit directory entries are emitted.
//
// Unit-tested (`node --test orchestrator/tar-single.test.js`).

const BLOCK = 512;

function writeString(buf, str, offset, len) {
  const b = Buffer.from(String(str), 'utf8');
  const n = Math.min(b.length, len - 1); // leave room for a NUL terminator
  b.copy(buf, offset, 0, n);
  // remaining bytes are already zero (Buffer.alloc)
}

// Octal field: right-justified, NUL-terminated (ustar convention: value in
// `len-1` octal digits then a NUL). Numbers that don't fit throw — our sizes
// (< 8 GiB) and modes always do.
function writeOctal(buf, value, offset, len) {
  const digits = len - 1;
  const oct = Math.floor(value).toString(8);
  if (oct.length > digits) {
    throw new RangeError(`value ${value} does not fit in ${digits} octal digits`);
  }
  const padded = oct.padStart(digits, '0');
  Buffer.from(padded, 'ascii').copy(buf, offset);
  buf[offset + digits] = 0;
}

// Split a POSIX path into { name, prefix } so long paths fit the 100/155 fields.
// Returns null when it can't (a single component longer than 100 bytes).
function splitName(path) {
  const p = String(path).replace(/^\/+/, '');
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  // Find a split point on a '/' so that name <= 100 and prefix <= 155.
  let idx = p.length;
  while ((idx = p.lastIndexOf('/', idx - 1)) > 0) {
    const name = p.slice(idx + 1);
    const prefix = p.slice(0, idx);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  return null;
}

// Build one 512-byte ustar header for a regular file.
function buildHeader({ name, mode = 0o644, size, mtime }) {
  const split = splitName(name);
  if (!split) throw new RangeError(`path too long for ustar: ${name}`);
  const h = Buffer.alloc(BLOCK);
  writeString(h, split.name, 0, 100);      // name
  writeOctal(h, mode & 0o7777, 100, 8);     // mode
  writeOctal(h, 0, 108, 8);                 // uid
  writeOctal(h, 0, 116, 8);                 // gid
  writeOctal(h, size, 124, 12);             // size
  writeOctal(h, Math.floor(mtime), 136, 12); // mtime
  // checksum field (148, 8): filled with spaces while checksumming
  h.fill(0x20, 148, 156);
  h[156] = 0x30;                            // typeflag '0' (regular file)
  // linkname (157, 100) stays zero
  Buffer.from('ustar\0', 'ascii').copy(h, 257); // magic
  Buffer.from('00', 'ascii').copy(h, 263);      // version
  // uname/gname/devmajor/devminor stay zero
  if (split.prefix) writeString(h, split.prefix, 345, 155); // prefix

  // Checksum: unsigned sum of all header bytes (with the checksum field as
  // spaces). Stored as six octal digits, a NUL, then a space — the layout GNU
  // tar and podman's Go tar reader both accept.
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  Buffer.from((sum & 0x1fffff).toString(8).padStart(6, '0'), 'ascii').copy(h, 148);
  h[154] = 0;    // NUL
  h[155] = 0x20; // space
  return h;
}

// Pad a payload buffer up to the next 512-byte boundary.
function padTo512(len) {
  const rem = len % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

// Build a tar Buffer from entries `[{ name, body:Buffer, mode?, mtime? }]`.
// `name` is a POSIX relative path (folder-upload subpaths allowed). The archive
// ends with the two zero blocks a valid tar requires.
function buildTar(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildTar requires at least one entry');
  }
  const parts = [];
  for (const e of entries) {
    const body = Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body || '');
    const header = buildHeader({
      name: e.name,
      mode: typeof e.mode === 'number' ? e.mode : 0o644,
      size: body.length,
      mtime: typeof e.mtime === 'number' ? e.mtime : Math.floor(Date.now() / 1000),
    });
    parts.push(header, body);
    const pad = padTo512(body.length);
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}

module.exports = { buildTar, buildHeader, splitName, BLOCK };
