// Screenshot / manifest recorder (docs/journey-spec-concept.md §2.3 + §7, #705).
//
// Enforces the contract "captures happen ONLY in a passing run": every capture
// is buffered in memory during the run and written to disk only by flush(),
// which the runner calls after the LAST step has passed. A journey that throws
// mid-way never reaches flush(), so a failing journey publishes nothing — no
// half-written artifact set, no stale manifest.
//
// Determinism (§7): the viewport / colorScheme / reducedMotion are pinned on the
// Playwright `journeys` project (playwright.config.js). Here we additionally
// inject an animation-killing stylesheet at capture time and mask volatile
// regions (timestamps, generated ids) via the locators the step modules export.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ARTIFACTS_ROOT = path.resolve(__dirname, '..', 'artifacts');
const STYLE_PATH = path.resolve(__dirname, 'determinism.css');

function resolveCommitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// makeRecorder(journey, { registry, now }) — `registry.volatileLocators(page)`
// supplies the masks; `now` is injectable for deterministic tests.
function makeRecorder(journey, { registry = null, now = () => new Date().toISOString() } = {}) {
  const staged = []; // { stepId, buffer }

  return {
    // Buffer a full-page screenshot for a named point. No file is touched yet.
    async capture(page, stepId) {
      const mask = registry ? registry.volatileLocators(page) : [];
      const buffer = await page.screenshot({
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        stylePath: fs.existsSync(STYLE_PATH) ? STYLE_PATH : undefined,
        mask,
      });
      staged.push({ stepId, buffer, viewport: page.viewportSize() });
    },

    stagedCount: () => staged.length,

    // Write every buffered capture + a manifest. Idempotent per run; only called
    // after all steps passed. Returns the manifest for the caller to log/attach.
    async flush({ commitSha = resolveCommitSha() } = {}) {
      const dir = path.join(ARTIFACTS_ROOT, journey.id);
      fs.mkdirSync(dir, { recursive: true });
      const timestamp = now();
      const shots = [];
      for (const { stepId, buffer, viewport } of staged) {
        const file = `${stepId}.png`;
        fs.writeFileSync(path.join(dir, file), buffer);
        shots.push({ stepId, file, viewport });
      }
      const manifest = {
        journeyId: journey.id,
        title: journey.title,
        commitSha,
        timestamp,
        viewport: staged[0]?.viewport || null,
        screenshots: shots,
      };
      fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      return manifest;
    },
  };
}

module.exports = { makeRecorder, ARTIFACTS_ROOT, STYLE_PATH, resolveCommitSha };
