import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard: the process/maintenance status lines render their timestamps
 * through the shared friendly <WhenCell> ("2 hours ago", exact on hover), the
 * same treatment the credential/connection tables and the GitHub Events log
 * use — not a raw new Date(...).toLocaleString() machine string.
 *
 * WhenCell's formatting is unit-tested via ../../components/format-when.js;
 * this only pins that these call sites keep using it (readFileSync source
 * check, per the #651 no-JSX-render convention).
 */
const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const FILES = [
  './FlowAnomaliesPanel.jsx',
  './ImprovementsPanel.jsx',
  '../MaintenanceMode.jsx',
];

for (const rel of FILES) {
  test(`${rel} uses the shared WhenCell for status timestamps`, () => {
    const src = read(rel);
    assert.match(src, /import WhenCell from '[^']*components\/WhenCell'/, `${rel} should import WhenCell`);
    assert.match(src, /<WhenCell\s+iso=/, `${rel} should render <WhenCell iso=…>`);
    assert.doesNotMatch(src, /toLocaleString\(/, `${rel} should not render a raw toLocaleString timestamp`);
  });
}
