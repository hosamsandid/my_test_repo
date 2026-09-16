'use strict';

// Pre-flight sizing for the per-directory ZIP download (#2318).
//
// The workspace file tree lets you download one directory as a single ZIP
// (`GET /api/agents/:agentId/workspace/zip`). Unlike the whole-agent export it
// applies NO content exclusions (#2318 D1): `.git`, `node_modules`, build
// output and dotfiles are all in, so an extracted repository folder stays a
// working git clone. That decision removes the only natural bound on the
// archive, which is why the size/count PRE-CHECK below is not a nicety but the
// one real safeguard:
//
//   The GCP load balancer caps the TOTAL response duration at 300 s
//   (`timeoutSec: 300` in deploy/k8s/overlays/{preprod,test}/app/ingress.yaml),
//   not idle time. A directory large enough to outlast that would stream a
//   PARTIAL ZIP that still opens as if complete — the worst possible failure,
//   because a truncated archive looks fine until a file is missing. So the byte
//   and file-count ceilings exist to refuse the pathological case up front,
//   with an actionable message, rather than silently truncate it.
//
// The limits are deliberately GENEROUS. A whole real agent workspace is already
// exported within budget at "hundreds of MB over tens of thousands of files"
// (~545 MB; api.js:4508-4537), and a single directory is a subset of that — so
// a normal repository working copy always downloads. This guards the
// pathological case; it is not a routine limit.
//
// The FILE COUNT, not the byte total, is often the binding constraint: a
// directory of 200k tiny files can outlast the 300 s cap while being small in
// bytes (the `zip` binary does per-file work). Both are checked.
//
// React-free and fs-thin so it can be unit-tested with plain `node --test` over
// a temp directory tree.

const fs = require('fs');
const path = require('path');

// 2 GiB — comfortably above a large repo working copy, well under anything that
// could not be zipped and streamed inside the 300 s response cap.
const WORKSPACE_ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

// 100k regular files. A whole workspace runs to "tens of thousands"; 100k is
// generous headroom for one directory while staying below the ~200k point at
// which per-file `zip` work threatens the 300 s cap.
const WORKSPACE_ZIP_MAX_FILES = 100000;

// A valid, empty ZIP: just the 22-byte End Of Central Directory record (no
// entries). An empty target directory must download as this rather than as a
// `zip` "nothing to do" error or a zero-byte file (#2318 AC13).
const EMPTY_ZIP = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, // "PK\x05\x06" EOCD signature
  0x00, 0x00, 0x00, 0x00, // disk number / disk with central directory
  0x00, 0x00, 0x00, 0x00, // entries on this disk / total entries
  0x00, 0x00, 0x00, 0x00, // central directory size
  0x00, 0x00, 0x00, 0x00, // central directory offset
  0x00, 0x00,             // comment length
]);

/**
 * Walk a directory tree measuring the archive that would be built from it:
 * total regular-file bytes, the regular-file count, and the number of
 * archivable entries (files + subdirectories).
 *
 * Symbolic links are SKIPPED, never followed (#2318 D5 / AC6) — matching the
 * export's `// skip symlinks for safety` rule (api.js). This is a containment
 * requirement: following an outward-pointing link would pull content from
 * outside the agent workspace into the measurement and, later, the archive.
 * Because links are the only way to create a cycle, a plain recursive walk of
 * the remaining real directories always terminates.
 *
 * Walks the WHOLE tree (no early exit) so an oversize refusal can name the
 * ACTUAL byte total and file count (#2318 AC8). A stat-only walk is far cheaper
 * than the `zip` it guards, so it stays well inside the response budget even
 * for the directories it ends up refusing.
 *
 * An unreadable subdirectory is skipped here rather than throwing — the real
 * `zip` run is what surfaces a permission failure to the client as a failed
 * download, so the measurement must not pre-empt it with a 500.
 *
 * @param {string} root  absolute path to the directory to measure
 * @param {{maxBytes?: number, maxFiles?: number}} [limits]
 * @returns {Promise<{bytes:number, files:number, entries:number, over:boolean}>}
 *   `entries` is 0 exactly when the tree holds nothing to archive (the empty
 *   case). `over` is true when either ceiling is exceeded.
 */
async function measureWorkspaceDir(root, limits = {}) {
  const maxBytes = limits.maxBytes ?? WORKSPACE_ZIP_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? WORKSPACE_ZIP_MAX_FILES;
  let bytes = 0;
  let files = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable subdir — leave it to the real zip run to report
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue; // never follow (D5)
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        entries += 1;
        stack.push(full);
      } else if (d.isFile()) {
        entries += 1;
        files += 1;
        try {
          const st = await fs.promises.stat(full);
          bytes += st.size;
        } catch { /* vanished mid-walk — count the entry, skip its bytes */ }
      }
      // sockets/fifos/devices: nothing an archive should carry
    }
  }
  return { bytes, files, entries, over: bytes > maxBytes || files > maxFiles };
}

/** Human-readable byte size for the refusal message (1024-based). */
function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const shown = i === 0 ? String(v) : v.toFixed(1);
  return `${shown} ${units[i]}`;
}

/**
 * The AC8 refusal text: names the actual size and file count, and points to an
 * alternative (a smaller subdirectory, or the whole-workspace export). Kept
 * here so the message and the thresholds live together.
 *
 * @param {{bytes:number, files:number}} measured
 */
function describeOversizeDir(measured) {
  const { bytes, files } = measured;
  return `This directory is too large to download as a ZIP `
    + `(${formatBytes(bytes)}, ${files} file${files === 1 ? '' : 's'}). `
    + `Download a smaller subdirectory, or use "Export agent workspace as ZIP" `
    + `for the whole workspace.`;
}

module.exports = {
  WORKSPACE_ZIP_MAX_BYTES,
  WORKSPACE_ZIP_MAX_FILES,
  EMPTY_ZIP,
  measureWorkspaceDir,
  formatBytes,
  describeOversizeDir,
};
