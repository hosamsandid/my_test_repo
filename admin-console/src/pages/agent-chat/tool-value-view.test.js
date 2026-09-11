import test from 'node:test';
import assert from 'node:assert/strict';
import { renderableRows, looksLikeMarkdown } from './tool-value-view.js';

test('renderableRows: flat object — one row per field, unwrapped at depth 0', () => {
  const rows = renderableRows({ file_path: '/a/b.txt', offset: 1180, limit: 40 });
  assert.deepEqual(
    rows.map((r) => [r.key, r.depth, r.kind, r.value]),
    [
      ['file_path', 0, 'scalar', '/a/b.txt'],
      ['offset', 0, 'scalar', 1180],
      ['limit', 0, 'scalar', 40],
    ],
  );
});

test('renderableRows: a multi-line string leaf is classified "multiline", not escaped', () => {
  const rows = renderableRows({ command: 'echo hi\necho bye' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'multiline');
  assert.equal(rows[0].value, 'echo hi\necho bye');
});

test('renderableRows: a markdown-like multi-line string leaf is classified "markdown"', () => {
  const rows = renderableRows({ stdout: '# Heading\n\nSome **bold** text.' });
  assert.equal(rows[0].kind, 'markdown');
});

test('renderableRows: a bullet-list body is classified "markdown"', () => {
  const rows = renderableRows({ notes: 'Summary:\n- one\n- two' });
  assert.equal(rows[0].kind, 'markdown');
});

test('renderableRows: nested object renders a branch row followed by indented children', () => {
  const rows = renderableRows({ meta: { a: 1, b: 2 }, top: 'x' });
  assert.deepEqual(
    rows.map((r) => [r.key, r.depth, r.kind]),
    [
      ['meta', 0, 'object'],
      ['a', 1, 'scalar'],
      ['b', 1, 'scalar'],
      ['top', 0, 'scalar'],
    ],
  );
});

test('renderableRows: nested array renders a branch row followed by indented items', () => {
  const rows = renderableRows({ items: ['x', 'y'] });
  assert.deepEqual(
    rows.map((r) => [r.key, r.depth, r.kind, r.value]),
    [
      ['items', 0, 'array', ['x', 'y']],
      ['[0]', 1, 'scalar', 'x'],
      ['[1]', 1, 'scalar', 'y'],
    ],
  );
});

test('renderableRows: array of objects nests two levels deep', () => {
  const rows = renderableRows({ list: [{ id: 1 }] });
  assert.deepEqual(
    rows.map((r) => [r.key, r.depth, r.kind]),
    [
      ['list', 0, 'array'],
      ['[0]', 1, 'object'],
      ['id', 2, 'scalar'],
    ],
  );
});

test('renderableRows: empty object/array leaves are their own kind, not flattened away', () => {
  const rows = renderableRows({ opts: {}, tags: [] });
  assert.deepEqual(
    rows.map((r) => [r.key, r.kind]),
    [
      ['opts', 'empty-object'],
      ['tags', 'empty-array'],
    ],
  );
});

test('renderableRows: top-level empty object/array', () => {
  assert.deepEqual(renderableRows({}), [{ path: '', key: null, depth: 0, kind: 'empty-object', value: {} }]);
  assert.deepEqual(renderableRows([]), [{ path: '', key: null, depth: 0, kind: 'empty-array', value: [] }]);
});

test('renderableRows: top-level bare string (no field name)', () => {
  const rows = renderableRows('just a string');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, null);
  assert.equal(rows[0].kind, 'scalar');
  assert.equal(rows[0].value, 'just a string');
});

test('renderableRows: top-level array of scalars starts at depth 0, no wrapper row', () => {
  const rows = renderableRows(['a', 'b']);
  assert.deepEqual(
    rows.map((r) => [r.key, r.depth]),
    [['[0]', 0], ['[1]', 0]],
  );
});

test('renderableRows: null/number/boolean scalars pass through untouched', () => {
  const rows = renderableRows({ a: null, b: 42, c: true });
  assert.deepEqual(rows.map((r) => r.value), [null, 42, true]);
  assert.ok(rows.every((r) => r.kind === 'scalar'));
});

test('renderableRows: a very long scalar string leaf is truncated and flagged', () => {
  const long = 'x'.repeat(5000);
  const rows = renderableRows({ blob: long });
  assert.equal(rows[0].truncated, true);
  assert.equal(rows[0].value.length, 4000);
});

test('renderableRows: a huge array is capped with a trailing "more" marker', () => {
  const big = Array.from({ length: 250 }, (_, i) => i);
  const rows = renderableRows({ items: big });
  // branch row + 200 items + one "more" marker row
  assert.equal(rows.length, 1 + 200 + 1);
  assert.equal(rows[rows.length - 1].value, '(50 more)');
});

test('looksLikeMarkdown: recognises code fences, headings, lists, bold, links', () => {
  assert.ok(looksLikeMarkdown('```js\ncode\n```'));
  assert.ok(looksLikeMarkdown('# Title\nbody'));
  assert.ok(looksLikeMarkdown('- item one\n- item two'));
  assert.ok(looksLikeMarkdown('1. first\n2. second'));
  assert.ok(looksLikeMarkdown('see **this** part'));
  assert.ok(looksLikeMarkdown('a [link](https://example.com) here'));
});

test('looksLikeMarkdown: plain multi-line text is not markdown', () => {
  assert.equal(looksLikeMarkdown('line one\nline two\nline three'), false);
  assert.equal(looksLikeMarkdown('just one line'), false);
  assert.equal(looksLikeMarkdown(42), false);
});

// #2198 review finding: a shell `#`-comment line (and the issue's own
// motivating heredoc example) matches MARKDOWN_PATTERN, which would
// otherwise re-interpret a Bash `command` Input as markdown instead of
// showing the literal text the agent ran (AC2). `isInput: true` must force
// it to 'multiline' regardless of what `looksLikeMarkdown` itself reports.
test('renderableRows: a shell command with "#" comments stays "multiline" for Input, even though it reads as markdown', () => {
  const command = 'set -e\n# build the project\nnpm run build\n# run tests\nnpm test';
  assert.equal(looksLikeMarkdown(command), true); // the heuristic alone still fires

  const inputRows = renderableRows({ command }, { isInput: true });
  assert.equal(inputRows[0].kind, 'multiline');
  assert.equal(inputRows[0].value, command);

  // Same string with no `isInput` flag (e.g. a Result) is unaffected —
  // markdown detection stays enabled there, matching AC4.
  const resultRows = renderableRows({ stdout: command });
  assert.equal(resultRows[0].kind, 'markdown');
});

test('renderableRows: the issue #2197 heredoc example also stays literal for Input', () => {
  const heredocBody = '## Problem\n\nIn the Agent Chat session log, a Bash tool call renders its command as raw JSON.';
  const rows = renderableRows({ command: heredocBody }, { isInput: true });
  assert.equal(rows[0].kind, 'multiline');
  assert.equal(rows[0].value, heredocBody);
});

test('renderableRows: isInput leaves non-markdown-like plain multiline Input untouched', () => {
  const rows = renderableRows({ command: 'echo hi\necho bye' }, { isInput: true });
  assert.equal(rows[0].kind, 'multiline');
});
