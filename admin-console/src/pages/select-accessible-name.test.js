import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading guard for axe `select-name` (WCAG 4.1.2) on the GitHub Event
// Log and Token Usage pages (#2703). Without an accessible name a screen reader
// announces only "combo box". The JSX is uncovered by convention (#651), so
// this asserts over the source: every <select> must either carry a non-empty
// aria-label or sit inside an enclosing <label> element (implicit label).

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['GithubEventLog.jsx', 'TokenUsage.jsx'];

// Every `<select ...>` opening tag with its offset and line number. The scan
// skips `{…}` attribute expressions so an arrow's `=>` doesn't end the tag.
export function selectTags(src) {
  const tags = [];
  const re = /<select\b/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push({ tag: src.slice(m.index, i + 1), index: m.index, line: src.slice(0, m.index).split('\n').length });
  }
  return tags;
}

export function hasAccessibleName(src, { tag, index }) {
  if (/\baria-label="[^"]+"/.test(tag) || /\baria-labelledby=/.test(tag)) return true;
  const before = src.slice(0, index);
  return before.lastIndexOf('<label') > before.lastIndexOf('</label>');
}

for (const file of FILES) {
  test(`${file}: every <select> has an accessible name`, () => {
    const src = fs.readFileSync(path.join(here, file), 'utf8');
    const tags = selectTags(src);
    assert.ok(tags.length > 0, `expected at least one <select> in ${file}`);
    const unnamed = tags.filter((t) => !hasAccessibleName(src, t)).map((t) => `${file}:${t.line}`);
    assert.deepEqual(unnamed, []);
  });
}

test('the named controls use labels matching their purpose', () => {
  const ev = fs.readFileSync(path.join(here, 'GithubEventLog.jsx'), 'utf8');
  const tu = fs.readFileSync(path.join(here, 'TokenUsage.jsx'), 'utf8');
  const labelOf = (src, value) => selectTags(src)
    .filter((t) => t.tag.startsWith(`<select value={${value}}`))
    .map((t) => (t.tag.match(/aria-label="([^"]*)"/) || [])[1]);
  assert.deepEqual(labelOf(ev, 'rangeKey'), ['Time range']);
  assert.deepEqual(labelOf(tu, 'rangeKey'), ['Time range', 'Time range', 'Time range']);
  assert.deepEqual(labelOf(tu, 'groupBy'), ['Group by']);
  assert.deepEqual(labelOf(tu, 'model'), ['Model']);
});

test('hasAccessibleName: guard is not vacuous', () => {
  const arrow = '<select onChange={e => f(e)} style={s}></select>';
  assert.equal(selectTags(arrow)[0].tag, '<select onChange={e => f(e)} style={s}>');
  const bare = '<div><select value={x}></select></div>';
  assert.equal(hasAccessibleName(bare, selectTags(bare)[0]), false);
  const closed = '<label>A</label><select value={x}></select>';
  assert.equal(hasAccessibleName(closed, selectTags(closed)[0]), false);
  const empty = '<select aria-label="" value={x}></select>';
  assert.equal(hasAccessibleName(empty, selectTags(empty)[0]), false);
  const wrapped = '<label>Team<select value={x}></select></label>';
  assert.equal(hasAccessibleName(wrapped, selectTags(wrapped)[0]), true);
  const named = '<select value={x} aria-label="Time range"></select>';
  assert.equal(hasAccessibleName(named, selectTags(named)[0]), true);
});
