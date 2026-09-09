/**
 * bundle-download.js — writing a flow bundle out as a JSON file.
 *
 * The canvas toolbar's **Export** has always done this inline in
 * `ProcessCanvas.jsx`; #2053 gives the Flows rail context menu an *Export…*
 * entry on both draft and team rows, so the two would otherwise be two copies
 * of the same filename rule and the same object-URL dance — and a filename that
 * drifts between two export buttons on one page is exactly the kind of
 * inconsistency this ticket exists to remove.
 *
 * The naming decision is pure and unit-tested; the browser half is the thin
 * adapter beside it (per the #651 convention).
 */

/**
 * The download filename for a bundle.
 *
 * Everything outside `[a-z0-9._-]` becomes a hyphen so the name is safe on every
 * filesystem, and a nameless bundle falls back to `process` — the pre-#2053
 * behaviour, kept byte-identical so an existing export does not suddenly change
 * its filename.
 *
 * @param {string} [name] the bundle's `name`
 * @returns {string} e.g. `Simple SDLC` -> `Simple-SDLC.process.json`
 */
export function bundleFilename(name) {
  const base = typeof name === 'string' && name ? name : 'process';
  return `${base.replace(/[^a-z0-9._-]/gi, '-')}.process.json`;
}

/**
 * Storage metadata that must never leave in an export (#2068).
 *
 * A draft's `createdBy` and access set are stored beside the bundle, not part of
 * it — the same rule the Copilot history follows. Exporting them would put a
 * list of colleagues' user ids into a file that gets mailed around, and the
 * import side already refuses to honour them, so carrying them out is pure leak
 * with no matching capability. A team-template export never has them.
 */
const NON_PORTABLE_FIELDS = ['createdBy', 'accessUserIds'];

/** The portable form of a bundle: everything except the storage metadata. */
export function portableBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  const out = { ...bundle };
  for (const f of NON_PORTABLE_FIELDS) delete out[f];
  return out;
}

/**
 * Write `bundle` to the user's downloads as pretty-printed JSON.
 *
 * No-op for a falsy bundle (a draft that failed to load), so a caller can hand
 * over whatever it has without a guard of its own.
 */
export function downloadBundle(bundle) {
  if (!bundle) return;
  const blob = new Blob([JSON.stringify(portableBundle(bundle), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = bundleFilename(bundle.name);
  a.click();
  URL.revokeObjectURL(a.href);
}
