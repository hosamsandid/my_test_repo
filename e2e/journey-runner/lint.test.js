// Journey-linter tests (#706) — pure, `node --test`, no Playwright.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCatalog, lintJourney, lintAll } = require('./lint');

const catalog = loadCatalog();

// Minimal valid journey scaffold we can mutate per test.
function journey(overrides = {}) {
  return {
    journeyVersion: 1,
    id: 'x',
    title: 'X',
    steps: [{ action: { do: 'wizard.open' } }],
    ...overrides,
  };
}

test('the real journeys directory is lint-clean', () => {
  const { errors, journeyCount } = lintAll({ catalog });
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.ok(journeyCount >= 1);
});

test('unknown step name is rejected with a listing message', () => {
  const errs = lintJourney(journey({ steps: [{ action: { do: 'wizard.nope' } }] }), catalog);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /unknown step "wizard\.nope"/);
  assert.match(errs[0], /Known steps:/);
});

test('unknown step param is rejected', () => {
  const errs = lintJourney(
    journey({ steps: [{ action: { do: 'wizard.selectProcessTemplate', templateName: 'Core SDLC', bogus: 1 } }] }),
    catalog,
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /unknown param "bogus"/);
});

test('missing required step param is rejected', () => {
  const errs = lintJourney(
    journey({ steps: [{ action: { do: 'wizard.selectProcessTemplate' } }] }),
    catalog,
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /missing required param "templateName"/);
});

test('optional param may be omitted (createFixtureEnv.branch)', () => {
  const errs = lintJourney(
    journey({
      steps: [{ action: { do: 'env.createFixtureEnv', id: 'e', name: 'E', repoUrl: 'http://x' } }],
    }),
    catalog,
  );
  assert.deepEqual(errs, []);
});

test('unknown fixture is rejected', () => {
  const errs = lintJourney(
    journey({ fixtures: [{ fixture: 'nope' }] }),
    catalog,
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /unknown fixture "nope"/);
});

test('fixture missing a required param is rejected', () => {
  const errs = lintJourney(
    journey({ fixtures: [{ fixture: 'teamEnv', params: { teamId: 't' } }] }),
    catalog,
  );
  assert.ok(errs.some((e) => /missing required param "envId"/.test(e)));
});

test('duplicate screenshot ids across journeys are flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-shots-'));
  const body = (id) => `journeyVersion: 1
id: ${id}
title: ${id}
steps:
  - action: { do: wizard.open }
    screenshot: shared-shot
`;
  fs.writeFileSync(path.join(dir, 'a.yaml'), body('a'));
  fs.writeFileSync(path.join(dir, 'b.yaml'), body('b'));
  const { errors } = lintAll({ dir, catalog });
  assert.ok(errors.some((e) => /screenshot id "shared-shot" also used by/.test(e)), errors.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lintAll surfaces a structural schema failure as a lint error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-bad-'));
  fs.writeFileSync(path.join(dir, 'bad.yaml'), 'id: x\ntitle: X\nsteps: []\n'); // no journeyVersion
  const { errors } = lintAll({ dir, catalog });
  assert.ok(errors.some((e) => /journeyVersion must be 1/.test(e)), errors.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});
