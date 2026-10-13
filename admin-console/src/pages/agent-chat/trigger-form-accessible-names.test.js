import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading guard for axe `select-name` / `label` (WCAG 4.1.2) on the
// shared trigger form — Agent Chat → Triggers → Add/Edit Trigger and the
// composer's Start a loop panel (#2961). The visible captions are plain
// <div>s, so every control must name itself: a non-empty aria-label, or an
// aria-labelledby pointing at a caption id that exists in the file. The JSX is
// uncovered by convention (#651), hence the source scan (as in #2703).

const here = path.dirname(fileURLToPath(import.meta.url));
// Comments are blanked (newlines kept, so line numbers still match) — a
// comment mentioning `<input type="…">` is not a control.
const blank = (m) => m.replace(/[^\n]/g, ' ');
const SRC = fs.readFileSync(path.join(here, 'TriggersPanel.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/^\s*\/\/.*$/gm, blank);

// Every opening tag of `name` with its line number. The scan skips `{…}`
// attribute expressions so an arrow's `=>` doesn't end the tag.
export function openingTags(src, name) {
  const tags = [];
  const re = new RegExp(`<${name}\\b`, 'g');
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
    tags.push({ tag: src.slice(m.index, i + 1), line: src.slice(0, m.index).split('\n').length });
  }
  return tags;
}

// The caption ids declared in the file: `id={fieldId('x')}` / `id={someId}`.
export function captionIds(src) {
  const ids = new Set();
  for (const m of src.matchAll(/\bid=\{([^}]+\)?)\}/g)) ids.add(m[1].trim());
  return ids;
}

export function isNamed(tag, ids) {
  if (/\baria-label="[^"]+"/.test(tag)) return true;
  const ref = tag.match(/\baria-labelledby=\{([^}]+\)?)\}/);
  return !!ref && ids.has(ref[1].trim());
}

// Inputs a screen reader announces as a field. Checkboxes sit inside a
// <label> already; type="hidden" has no name to give.
const isNamedInputType = (tag) => !/\btype="(checkbox|hidden)"/.test(tag);

test('TriggersPanel.jsx: every <select> has an accessible name', () => {
  const ids = captionIds(SRC);
  const tags = openingTags(SRC, 'select');
  assert.ok(tags.length >= 15, `expected the trigger form's selects, found ${tags.length}`);
  const unnamed = tags.filter((t) => !isNamed(t.tag, ids)).map((t) => `TriggersPanel.jsx:${t.line}`);
  assert.deepEqual(unnamed, []);
});

test('TriggersPanel.jsx: every text/number/time input has an accessible name', () => {
  const ids = captionIds(SRC);
  const tags = [...openingTags(SRC, 'input'), ...openingTags(SRC, 'SuffixedLabelInput')]
    .filter((t) => isNamedInputType(t.tag));
  assert.ok(tags.length > 0);
  const unnamed = tags.filter((t) => !isNamed(t.tag, ids)).map((t) => `TriggersPanel.jsx:${t.line}`);
  assert.deepEqual(unnamed, []);
});

test('the named controls use their visible caption', () => {
  // aria-labelledby={fieldId('x')} → the caption text right after id={fieldId('x')}.
  const captionOf = (field) => {
    const at = SRC.indexOf(`id={fieldId('${field}')}`);
    assert.ok(at > 0, `no caption for ${field}`);
    const text = SRC.slice(SRC.indexOf('>', at) + 1).trimStart();
    return text.slice(0, text.search(/[\n<]/)).trim();
  };
  const labelledby = (attr) => openingTags(SRC, 'select')
    .filter((t) => t.tag.includes(`aria-labelledby={fieldId('${attr}')}`)).length;

  assert.equal(captionOf('type'), 'Type');
  assert.match(captionOf('verify-mode'), /^Who checks the work\? \(optional/);
  assert.equal(captionOf('stop-condition'), 'Done when…');
  assert.equal(captionOf('token-budget'), 'How much work can it do? (budget)');
  assert.equal(captionOf('gap'), 'Wait between tries');
  assert.equal(captionOf('repo'), 'Repository');
  assert.equal(captionOf('data-flow-repo'), 'Repository');
  assert.equal(captionOf('event'), 'Event');
  assert.equal(captionOf('comment-target'), 'Comments on');
  assert.equal(captionOf('plugin'), 'Plugin');
  for (const f of ['type', 'verify-mode', 'stop-condition', 'token-budget', 'gap', 'repo', 'data-flow-repo', 'event', 'comment-target', 'plugin']) {
    assert.equal(labelledby(f), 1, `one select labelled by ${f}`);
  }

  // The secondary verifier-agent select and the cron/once pickers.
  const sel = openingTags(SRC, 'select').map((t) => t.tag);
  assert.ok(sel.some((t) => t.includes('aria-label="Verifier agent"') && t.includes('form.verifyAgentId')));
  assert.ok(sel.some((t) => t.includes('aria-labelledby={scheduleCaptionId}') && t.includes('s.mode')));
  assert.ok(sel.some((t) => t.includes('aria-label="Day of week"') && t.includes('s.dow')));
  const inputs = openingTags(SRC, 'input').map((t) => t.tag);
  assert.ok(inputs.some((t) => t.includes('type="time"') && t.includes('aria-label="Time"')));
  assert.ok(inputs.some((t) => t.includes('type="datetime-local"') && t.includes('aria-labelledby={captionId}')));
  assert.match(SRC, /<div id=\{scheduleCaptionId\}[^>]*>\s*Schedule/);
  assert.match(SRC, /<div id=\{captionId\}[^>]*>\s*Date &amp; Time/);
});

test('isNamed: guard is not vacuous', () => {
  const ids = new Set(["fieldId('type')"]);
  const one = (s) => openingTags(s, 'select')[0].tag;
  assert.equal(one('<select onChange={e => f(e)} style={s}>'), '<select onChange={e => f(e)} style={s}>');
  assert.equal(isNamed(one('<select value={x}>'), ids), false);
  assert.equal(isNamed(one('<select aria-label="" value={x}>'), ids), false);
  assert.equal(isNamed(one("<select aria-labelledby={fieldId('nope')} value={x}>"), ids), false);
  assert.equal(isNamed(one("<select aria-labelledby={fieldId('type')} value={x}>"), ids), true);
  assert.equal(isNamed(one('<select aria-label="Time range" value={x}>'), ids), true);
});
