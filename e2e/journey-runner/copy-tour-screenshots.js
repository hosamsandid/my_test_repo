// Tour-screenshot vendoring step (Helper Chat tour, #1736).
//
// A green journey run writes the captured PNGs under e2e/artifacts/<journey>/,
// but that directory is gitignored and lives outside the admin-console image
// build context, so the tour would 404 on every screenshot in a built image.
// This script copies exactly the screenshots the generated tour manifest
// references into admin-console/api/helper-chat/tour-screenshots/, where they
// are committed and baked into the image by the Dockerfile's
// `COPY api/helper-chat ./api/helper-chat` (see admin-console/api/api.js
// TOUR_ARTIFACTS_DIR). It reads the manifest (not a directory glob) so the
// committed set can never drift from what the tour actually shows.
//
//   node journey-runner/copy-tour-screenshots.js          # sync the PNGs
//   node journey-runner/copy-tour-screenshots.js --check   # exit 1 if stale
//
// Intended order (see `make tour-screenshots`): run the journeys, then
// `make tour-manifest` (regenerates the manifest from e2e/artifacts, pruning
// steps whose PNG is missing), then this script. The scheduled
// tour-screenshots workflow runs the same three steps and commits the diff.
const fs = require('fs');
const path = require('path');
const { ARTIFACTS_DIR, OUTPUT_PATH } = require('./build-tour-manifest');

// Committed destination — alongside the generated manifest so both travel with
// the admin-console image (same vendoring rationale as tour-manifest.json).
const DEST_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'admin-console',
  'api',
  'helper-chat',
  'tour-screenshots',
);

// The screenshot paths the manifest references, e.g. "team-setup/create-launcher.png".
function manifestScreenshotPaths(manifestPath = OUTPUT_PATH) {
  const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const paths = [];
  for (const chapter of doc.chapters || []) {
    for (const step of chapter.steps || []) {
      if (step.screenshotPath) paths.push(step.screenshotPath);
    }
  }
  return paths;
}

// Plan the sync: which referenced PNGs exist under the artifacts dir (to copy)
// and which are missing (a warning — a manifest step with no capture). Pure so
// it can be reasoned about without touching disk beyond the existence probe.
function planCopy({ screenshotPaths, artifactsDir = ARTIFACTS_DIR }) {
  const copy = [];
  const missing = [];
  for (const rel of screenshotPaths) {
    const src = path.join(artifactsDir, rel);
    if (fs.existsSync(src)) copy.push(rel);
    else missing.push(rel);
  }
  return { copy, missing };
}

// Remove every PNG under DEST_DIR so a screenshot dropped from the manifest is
// also dropped from the committed set (no stale orphans). Non-PNG files (a
// README) are left untouched.
function clearDest(destDir = DEST_DIR) {
  if (!fs.existsSync(destDir)) return;
  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    const p = path.join(destDir, entry.name);
    if (entry.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else if (entry.name.endsWith('.png')) fs.rmSync(p, { force: true });
  }
}

function copyOne(rel, { artifactsDir = ARTIFACTS_DIR, destDir = DEST_DIR } = {}) {
  const src = path.join(artifactsDir, rel);
  const dst = path.join(destDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

module.exports = {
  DEST_DIR,
  manifestScreenshotPaths,
  planCopy,
  clearDest,
  copyOne,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const check = process.argv.includes('--check');

  // The check only means something with real captures to compare against. On a
  // fresh checkout / the podman-free CI lane there is no e2e/artifacts, so skip
  // rather than flag every committed PNG as an orphan (mirrors
  // build-tour-manifest's makeArtifactChecker skipping when the dir is absent).
  let hasArtifacts = false;
  try {
    hasArtifacts =
      fs.statSync(ARTIFACTS_DIR).isDirectory() &&
      fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    hasArtifacts = false;
  }
  if (check && !hasArtifacts) {
    process.stdout.write('no journey artifacts present — skipping tour-screenshots check.\n');
    process.exit(0);
  }

  const screenshotPaths = manifestScreenshotPaths();
  const { copy, missing } = planCopy({ screenshotPaths });

  for (const rel of missing) {
    process.stderr.write(
      `warning: manifest references ${rel} but e2e/artifacts/${rel} is absent — not copied\n`,
    );
  }

  if (check) {
    // Stale iff any referenced+captured PNG differs from (or is absent in) the
    // committed set. Extra committed PNGs not in the manifest are stale too.
    const committed = new Set();
    const walk = (dir, prefix = '') => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else if (e.name.endsWith('.png')) committed.add(rel);
      }
    };
    walk(DEST_DIR);

    let stale = false;
    for (const rel of copy) {
      const src = fs.readFileSync(path.join(ARTIFACTS_DIR, rel));
      const dstPath = path.join(DEST_DIR, rel);
      if (!fs.existsSync(dstPath) || !src.equals(fs.readFileSync(dstPath))) {
        stale = true;
        process.stderr.write(`stale: ${rel} differs from the captured artifact\n`);
      }
      committed.delete(rel);
    }
    for (const orphan of committed) {
      stale = true;
      process.stderr.write(`stale: committed ${orphan} is not referenced by the manifest\n`);
    }
    if (stale) {
      process.stderr.write(
        'tour-screenshots are stale — run `make tour-screenshots` and commit the result.\n',
      );
      process.exit(1);
    }
    process.stdout.write('tour-screenshots are up to date.\n');
    process.exit(0);
  }

  clearDest();
  for (const rel of copy) copyOne(rel);
  process.stdout.write(
    `Vendored ${copy.length} tour screenshot(s) into ${DEST_DIR}` +
      (missing.length ? ` (${missing.length} missing, see warnings)` : '') +
      '\n',
  );
}
