// Filesystem loader for a journey artifacts tree (#709). The recorder (#705)
// writes one directory per journey under e2e/artifacts/:
//
//   artifacts/<journeyId>/manifest.json
//   artifacts/<journeyId>/<stepId>.png
//
// A baseline (downloaded from the last green main run) and the current PR run
// share that layout, so loadArtifactsRoot() flattens either into a single Map
// keyed by "<journeyId>/<stepId>" — the exact key compare.compareSets() wants.
// Kept out of compare.js so the comparison stays fs-free and unit-testable.

const fs = require('fs');
const path = require('path');

// Load every journey manifest under `root` into a flat capture Map.
// Missing root (e.g. no baseline was ever published) yields an empty set
// rather than throwing — a first-ever run legitimately has no baseline.
function loadArtifactsRoot(root) {
  const captures = new Map();
  const journeys = [];
  if (!root || !fs.existsSync(root)) return { root, captures, journeys };

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const journeyDir = path.join(root, entry.name);
    const manifestPath = path.join(journeyDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid manifest at ${manifestPath}: ${err.message}`);
    }
    journeys.push({ journeyId: manifest.journeyId, title: manifest.title, dir: journeyDir });

    for (const shot of manifest.screenshots || []) {
      const file = path.join(journeyDir, shot.file);
      if (!fs.existsSync(file)) continue;
      const id = `${manifest.journeyId}/${shot.stepId}`;
      captures.set(id, {
        id,
        journeyId: manifest.journeyId,
        journeyTitle: manifest.title,
        stepId: shot.stepId,
        file: shot.file,
        path: file,
        viewport: shot.viewport || manifest.viewport || null,
        buffer: fs.readFileSync(file),
      });
    }
  }
  return { root, captures, journeys };
}

module.exports = { loadArtifactsRoot };
