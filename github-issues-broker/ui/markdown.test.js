'use strict';

// Tests for the safe GFM renderer (#1642, Item 3). Covers the AC1 element set
// (headings, bold/italic, ordered & unordered lists, inline & fenced code,
// links, tables, horizontal rules) and, crucially, AC2 safety: untrusted GitHub
// content never becomes raw HTML or executable content.

const test = require('node:test');
const assert = require('node:assert');
const md = require('./markdown');

test('headings render at the right level', () => {
  assert.match(md.render('# Title'), /<h1>Title<\/h1>/);
  assert.match(md.render('### Sub'), /<h3>Sub<\/h3>/);
});

test('bold, italic and strikethrough', () => {
  assert.match(md.render('**b** and *i* and ~~s~~'), /<strong>b<\/strong>/);
  assert.match(md.render('**b** and *i* and ~~s~~'), /<em>i<\/em>/);
  assert.match(md.render('**b** and *i* and ~~s~~'), /<del>s<\/del>/);
});

test('unordered and ordered lists', () => {
  assert.match(md.render('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(md.render('1. a\n2. b'), /<ol><li>a<\/li><li>b<\/li><\/ol>/);
});

test('inline code and fenced code (contents are escaped, not interpreted)', () => {
  assert.match(md.render('use `x < y`'), /<code>x &lt; y<\/code>/);
  const fenced = md.render('```\n<script>bad</script>\n```');
  assert.match(fenced, /<pre><code>&lt;script&gt;bad&lt;\/script&gt;<\/code><\/pre>/);
});

test('links open in a new tab with rel=noopener (AC3)', () => {
  const out = md.render('[GH](https://github.com/x)');
  assert.match(out, /<a href="https:\/\/github\.com\/x" target="_blank" rel="noopener">GH<\/a>/);
});

test('tables render as GFM tables', () => {
  const out = md.render('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(out, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
});

test('horizontal rule', () => {
  assert.match(md.render('---'), /<hr \/>/);
});

test('a null / empty body renders to empty string', () => {
  assert.equal(md.render(null), '');
  assert.equal(md.render(''), '');
});

// ── safety (AC2) ─────────────────────────────────────────────────────────────
test('raw HTML in the source is escaped, never interpreted', () => {
  const out = md.render('hello <img src=x onerror=alert(1)> world');
  assert.ok(!/<img src=x/.test(out), 'raw <img> tag must not survive');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a javascript: link drops the href but keeps the text', () => {
  const out = md.render('[click](javascript:alert(1))');
  assert.ok(!/href="javascript:/i.test(out), 'javascript: href must be dropped');
  assert.match(out, /click/);
});

test('a data: image src is dropped (alt kept as text)', () => {
  const out = md.render('![x](data:text/html;base64,PHN2Zz4=)');
  assert.ok(!/src="data:/i.test(out), 'data: src must be dropped');
});

test('sanitizeUrl only admits http(s)/mailto', () => {
  assert.equal(md.sanitizeUrl('https://a.com'), 'https://a.com');
  assert.equal(md.sanitizeUrl('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(md.sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(md.sanitizeUrl('  vbscript:x'), null);
});

test('emphasis does not fire inside a link URL with underscores', () => {
  const out = md.render('[t](https://a.com/foo_bar_baz)');
  assert.match(out, /href="https:\/\/a\.com\/foo_bar_baz"/);
  assert.ok(!/<em>/.test(out), 'no spurious emphasis inside the href');
});
