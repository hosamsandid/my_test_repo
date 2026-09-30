// admin-console/src/pages/agent-chat/cron-builder-wiring.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the cron schedule builder + trigger form save path (#2625).
 *
 * The rules live in `cron-format.js` (unit-tested). TriggersPanel.jsx is JSX,
 * which `node --test` never loads (#651), so this pins the wiring the pure
 * tests cannot see: the builder must not re-parse its own emissions (the
 * Custom-mode bounce), the form must gate saving on the builder's validation,
 * and a failed save must be caught and shown instead of rethrown.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

// Comments are stripped first so a comment *naming* a symbol can't stand in
// for the call that should be there.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const src = code(read('TriggersPanel.jsx'));
const builder = src.slice(src.indexOf('function CronBuilder('), src.indexOf('function toDatetimeLocal('));

test('CronBuilder re-parses `value` only when it changes from outside', () => {
  assert.match(builder, /const lastEmitted = useRef\(value\)/);
  assert.match(builder, /if \(value === lastEmitted\.current\) return;/);
  assert.match(builder, /lastEmitted\.current = cron;/);
  // The old unconditional round trip is gone.
  assert.doesNotMatch(builder, /useEffect\(\(\) => \{ setS\(parseCronState\(value\)\); \}, \[value\]\)/);
});

test('the Schedule dropdown goes through switchCronMode (Custom pre-fill)', () => {
  assert.match(builder, /onChange=\{e => changeMode\(e\.target\.value\)\}/);
  assert.match(builder, /switchCronMode\(s, mode\)/);
});

test('the builder reports its validation error and the form gates saving on it', () => {
  assert.match(builder, /onChange\(cron, v\.ok \? null : Object\.values\(v\.errors\)\[0\]\)/);
  assert.match(src, /<CronBuilder value=\{form\.cron\} onChange=\{\(v, err\) => \{ set\('cron', v\); setCronError\(err\); \}\} \/>/);
  assert.match(src, /useState\(\(\) => cronExpressionError\(form\.cron\)\)/);
  assert.match(src, /if \(form\.type === 'cron' && cronError\) \{ setFormError\(/);
  assert.match(src, /disabled=\{submitDisabled\}/);
});

test('submit() catches a failed save and shows it; the panel no longer rethrows', () => {
  assert.match(src, /try \{\s*await onSave\(body\);\s*\} catch \(e\) \{\s*setFormError\(/);
  assert.doesNotMatch(src, /catch \(e\) \{\s*throw e;\s*\}/);
});
