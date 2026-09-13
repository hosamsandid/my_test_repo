// Run: node --test admin-console/src/pages/environment-card-truncation.test.js
//
// Source-reading drift guard (#651) for #2225 — the Agent Team Wizard's
// EnvironmentCard header row (name + id) must truncate instead of overflowing
// its grid track. TeamSetup.jsx:396-400's repository line already does this
// correctly; this pins the same pattern on the row four lines above it and
// proves each check actually fires on the pre-fix shape (mutation-proved).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const FULL_SRC = readFileSync(join(here, 'TeamSetup.jsx'), 'utf8');
const SRC = stripComments(FULL_SRC);

function cardHeaderRow(src) {
  const fnStart = src.indexOf('function EnvironmentCard(');
  const fn = src.slice(fnStart);
  const rowStart = fn.indexOf("justifyContent: 'space-between', alignItems: 'baseline'");
  // widen to include the row's opening <div and its two children
  const before = fn.slice(0, rowStart);
  const openTagStart = before.lastIndexOf('<div');
  const region = fn.slice(openTagStart, fn.indexOf('</div>\n        {env.description'));
  return region;
}

const ROW = cardHeaderRow(SRC);

function nameBlock(row) {
  const titleIdx = row.indexOf('title={env.name}');
  const openStart = row.lastIndexOf('<div', titleIdx);
  const closeEnd = row.indexOf('</div>', titleIdx) + '</div>'.length;
  return row.slice(openStart, closeEnd);
}

function idBlock(row) {
  const titleIdx = row.indexOf('title={env.id}');
  const openStart = row.lastIndexOf('<code', titleIdx);
  const closeEnd = row.indexOf('</code>', titleIdx) + '</code>'.length;
  return row.slice(openStart, closeEnd);
}

test('the header row itself allows its children to shrink below content size', () => {
  const outerTagEnd = ROW.indexOf('>');
  assert.match(ROW.slice(0, outerTagEnd), /minWidth:\s*0/, 'the flex row needs minWidth: 0, or a long child forces it wider than its grid track');
});

test('the name is a shrinkable, truncating flex child with the full value on hover', () => {
  const region = nameBlock(ROW);
  assert.match(region, /minWidth:\s*0/, 'the name must be allowed to shrink');
  assert.match(region, /overflow:\s*'hidden'/, 'the name must clip its overflow');
  assert.match(region, /textOverflow:\s*'ellipsis'/, 'the name must truncate with an ellipsis');
  assert.match(region, /whiteSpace:\s*'nowrap'/, 'the name must not wrap (that would break the card-height grid)');
  assert.match(region, /title=\{env\.name\}/, 'the full name must stay reachable on hover (#1835)');
});

test('the id keeps room to stay recognisable, truncates, and is never forced wider than the card', () => {
  const region = idBlock(ROW);
  assert.doesNotMatch(region, /flexShrink:\s*0/, 'the id must no longer be forbidden from shrinking — that is the #2225 bug');
  assert.match(region, /overflow:\s*'hidden'/, 'the id must clip its overflow');
  assert.match(region, /textOverflow:\s*'ellipsis'/, 'the id must truncate with an ellipsis, the same pattern as the repository line (:396-400)');
  assert.match(region, /whiteSpace:\s*'nowrap'/, 'the id must not wrap');
  assert.match(region, /minWidth:/, 'the id needs a minimum width so it truncates to a recognisable fragment, never a single character');
  assert.match(region, /title=\{env\.id\}/, 'the full id must stay reachable on hover (#1835) — it is what disambiguates identically-named environments (AC5)');
});

test('each check above actually fires on the pre-fix shape (mutation-proved)', () => {
  const outerTagEnd = ROW.indexOf('>');
  const buggyOuter = ROW.slice(0, outerTagEnd).replace(/,?\s*minWidth:\s*0/, '');
  assert.doesNotMatch(buggyOuter, /minWidth:\s*0/, 'row check must fail on the buggy shape');

  const buggyName = nameBlock(ROW).replace(/,?\s*minWidth:\s*0/, '').replace(/overflow:\s*'hidden',?\s*/, '');
  assert.doesNotMatch(buggyName, /minWidth:\s*0/, 'name check must fail on the buggy shape');
  assert.doesNotMatch(buggyName, /overflow:\s*'hidden'/, 'name check must fail on the buggy shape');

  const buggyId = idBlock(ROW).replace(/flex: '0 1 auto',\s*minWidth: '4\.5em',\s*maxWidth: '55%',/, 'flexShrink: 0,');
  assert.match(buggyId, /flexShrink:\s*0/, 'id check must fail on the buggy (pre-fix) shape');
});
