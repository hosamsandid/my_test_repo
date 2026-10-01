// Source-reading drift guard (#651) for #2712 — the GitHub integration box's
// Recheck button. The state decisions live in github-health-recheck.js (unit
// tested); this pins that GithubHealthBadge actually wires them, and that the
// fix did not change the shared useApi hook other consumers rely on (AC7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const badge = () => {
  const src = stripComments(read('TeamEnvironmentPanel.jsx'));
  const start = src.indexOf('function GithubHealthBadge(');
  assert.ok(start >= 0, 'GithubHealthBadge exists');
  const end = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, end);
};

test('the badge imports the recheck state module', () => {
  assert.match(
    stripComments(read('TeamEnvironmentPanel.jsx')),
    /import \{[^}]*recheckReducer[^}]*\} from '\.\/github-health-recheck\.js'/,
  );
});

test('Recheck runs its own request, not useApi refetch', () => {
  const src = badge();
  assert.doesNotMatch(src, /refetch/);
  assert.match(src, /useReducer\(recheckReducer, initialRecheckState\)/);
  assert.match(src, /onClick=\{runRecheck\}/);
  assert.match(src, /if \(!url \|\| busy\.current\) return;/, 'no overlapping rechecks');
  assert.match(src, /busy\.current = true;/);
  assert.match(src, /dispatch\(\{ type: 'start' \}\);/);
  assert.match(src, /result = \{ type: 'success', data: await apiCall\('GET', url\) \};/);
  assert.match(src, /catch \{\s*result = \{ type: 'failure' \};/);
  assert.match(src, /dispatch\(\{ \.\.\.result, at: Date\.now\(\) \}\);/);
});

test('the busy state is held for the minimum duration before the result lands (AC6)', () => {
  const src = badge();
  assert.match(src, /const wait = remainingBusyMs\(startedAt, Date\.now\(\)\);/);
  assert.match(src, /if \(wait > 0\) await new Promise\(\(r\) => setTimeout\(r, wait\)\);/);
  assert.ok(src.indexOf('remainingBusyMs(') < src.indexOf('dispatch({ ...result'), 'wait before dispatching the result');
});

test('the busy flag is released after a recheck so the button works again', () => {
  const src = badge();
  const guard = src.indexOf('if (gen !== generation.current) return;');
  const release = src.indexOf('busy.current = false;\n    dispatch');
  assert.ok(guard >= 0 && release > guard);
});

test('a recheck in flight for a previous environment never lands on the new one', () => {
  const src = badge();
  assert.match(src, /const gen = generation\.current;/);
  assert.match(src, /if \(gen !== generation\.current\) return;/);
  assert.match(src, /dispatch\(\{ type: 'reset' \}\);\s*return \(\) => \{ generation\.current \+= 1; busy\.current = false; \};\s*\}, \[url\]\);/);
});

test('the initial load counts as a completed check', () => {
  assert.match(badge(), /if \(initial\) dispatch\(\{ type: 'loaded', at: Date\.now\(\) \}\);\s*\}, \[initial\]\);/);
});

test('the shown result is the latest recheck, else the initial load, and a failed recheck keeps the box (AC2, AC5)', () => {
  const src = badge();
  assert.match(src, /const data = recheck\.data \|\| initial;/);
  assert.match(src, /if \(!envId \|\| \(error && !data\)\) return null;/);
});

test('the button renders the busy state from describeRecheck (AC1)', () => {
  const src = badge();
  assert.match(src, /const view = describeRecheck\(recheck\);/);
  assert.match(src, /disabled=\{view\.disabled\}/);
  assert.match(src, /\{view\.disabled && <Loader2 /);
  assert.match(src, /\{view\.buttonLabel\}/);
});

test('the completion / failure note is rendered inside the status box (AC3, AC5)', () => {
  const src = badge();
  assert.match(src, /\{view\.note && \(/);
  assert.match(src, /view\.note\.tone === 'error' \? 'var\(--eb-status-error\)' : 'var\(--eb-text-muted\)'/);
  assert.match(src, /\{view\.note\.text\}/);
});

test('useApi keeps its "no loading flip on refetch" semantics (AC7)', () => {
  const src = stripComments(read('../../hooks/useApi.js'));
  assert.match(src, /if \(!hasData\.current\) setLoading\(true\);/);
});
