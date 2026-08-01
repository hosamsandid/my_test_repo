// Doc generator orchestration (docs/journey-spec-concept.md §3.2, #707).
//
// Wires the pure pieces (render.js / coverage.js) to the filesystem: load every
// journey, pair it with the manifest a green run left under the artifacts dir,
// render one Markdown page per journey under the output dir, copy each referenced
// screenshot alongside it (so a page + its images form one self-contained bundle
// that CI can upload as a single artifact), and write the coverage report.
//
// The artifacts dir is parameterisable (E2E_ARTIFACTS_DIR / opts.artifactsDir) so
// docgen runs identically on a local run's e2e/artifacts and on CI-downloaded
// artifacts (§3.2). All provenance is read from each manifest, so output is a pure
// function of the committed journeys + the input artifacts.
'use strict';

const fs = require('fs');
const path = require('path');

const { loadJourneysDir, JOURNEYS_DIR } = require('../journey-runner/loader');
const { renderJourneyPage, pageFileName, assetDirFor, screenshotIndex } = require('./render');
const { readNavPages } = require('./nav-pages');
const { readChapters } = require('./walkthrough');
const { computeCoverage, renderCoverageReport } = require('./coverage');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ARTIFACTS = path.resolve(__dirname, '..', 'artifacts');
const DEFAULT_OUT = path.resolve(REPO_ROOT, 'docs', 'user-guide');

// Read a journey's run manifest, or null when the artifacts dir has none for it
// (journey not captured by the last green run — its page renders narrative-only).
function readManifest(artifactsDir, journeyId) {
  const file = path.join(artifactsDir, journeyId, 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Repo-relative POSIX path for a journey's source YAML (used in the page header).
function sourcePathFor(journeysDir, journeyId) {
  const abs = path.join(journeysDir, `${journeyId}.yaml`);
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

// Copy the screenshots a manifest references from the artifacts dir into the
// page's asset dir under the output root. Returns the count copied.
function copyScreenshots(manifest, artifactsDir, outDir, assetDir) {
  if (!manifest) return 0;
  const srcDir = path.join(artifactsDir, manifest.journeyId);
  const destDir = path.join(outDir, assetDir);
  let copied = 0;
  for (const { file } of manifest.screenshots || []) {
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) continue; // manifest can outlive a pruned capture
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, file));
    copied += 1;
  }
  return copied;
}

// Generate the whole user guide + coverage report. Returns a summary the CLI logs.
function generate(opts = {}) {
  const journeysDir = opts.journeysDir || JOURNEYS_DIR;
  const artifactsDir = opts.artifactsDir || process.env.E2E_ARTIFACTS_DIR || DEFAULT_ARTIFACTS;
  const outDir = opts.outDir || DEFAULT_OUT;

  const journeys = loadJourneysDir(journeysDir);
  fs.mkdirSync(outDir, { recursive: true });

  const pages = [];
  for (const journey of journeys) {
    const manifest = readManifest(artifactsDir, journey.id);
    const assetDir = assetDirFor(journey);
    const markdown = renderJourneyPage(journey, manifest, {
      sourcePath: sourcePathFor(journeysDir, journey.id),
      assetDir,
    });
    const fileName = pageFileName(journey);
    fs.writeFileSync(path.join(outDir, fileName), markdown);
    const captured = copyScreenshots(manifest, artifactsDir, outDir, assetDir);
    pages.push({
      journeyId: journey.id,
      file: fileName,
      screenshots: manifest ? screenshotIndex(manifest).size : 0,
      copied: captured,
      hasManifest: Boolean(manifest),
    });
  }

  // Coverage report (real inventories unless the caller overrides for tests).
  const navPages = opts.navPages || readNavPages(opts.navSpecPath);
  const chapters = opts.chapters || readChapters(opts.walkthroughPath);
  const coverage = computeCoverage({ journeys, navPages, chapters });
  const coveragePath = path.join(outDir, 'coverage.md');
  fs.writeFileSync(coveragePath, renderCoverageReport(coverage));

  return { outDir, pages, coverage, coveragePath };
}

module.exports = {
  generate,
  readManifest,
  copyScreenshots,
  sourcePathFor,
  REPO_ROOT,
  DEFAULT_ARTIFACTS,
  DEFAULT_OUT,
};
