'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi, extractAuthUrl, extractToken } = require('./llm-auth-flow');

test('stripAnsi removes CSI color/cursor sequences', () => {
  const raw = '\x1b[1m\x1b[38;5;208mBrowser didn\'t open?\x1b[0m Use the url below';
  assert.equal(stripAnsi(raw), "Browser didn't open? Use the url below");
});

test('stripAnsi removes OSC hyperlink wrappers but keeps visible text', () => {
  const raw = '\x1b]8;;https://example.com\x07visible\x1b]8;;\x07 rest';
  assert.equal(stripAnsi(raw), 'visible rest');
});

test('stripAnsi turns carriage returns into newlines', () => {
  assert.equal(stripAnsi('a\r\nb\rc'), 'a\n\nb\nc');
});

test('stripAnsi leaves plain bracketed text alone', () => {
  assert.equal(stripAnsi('[Runner] step [2m done'), '[Runner] step [2m done');
});

test('extractAuthUrl finds the claude.ai authorize URL', () => {
  const out = stripAnsi(
    'Opening browser…\n' +
    'If it does not open, visit:\n' +
    '\x1b[36mhttps://claude.ai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=xyz\x1b[0m\n' +
    'Paste code here if prompted >'
  );
  const url = extractAuthUrl(out);
  assert.ok(url);
  assert.ok(url.startsWith('https://claude.ai/oauth/authorize?'));
  assert.ok(url.includes('client_id=abc'));
});

test('extractAuthUrl reassembles a URL wrapped across terminal lines', () => {
  const out = 'visit: https://claude.ai/oauth/auth\norize?client_id=abc&state=xyz\n\nPaste code:';
  const url = extractAuthUrl(out);
  assert.equal(url, 'https://claude.ai/oauth/authorize?client_id=abc&state=xyz');
});

test('extractAuthUrl ignores non-oauth URLs', () => {
  assert.equal(extractAuthUrl('see https://claude.ai/download and https://docs.claude.com/x'), null);
});

test('extractToken finds a long-lived subscription token', () => {
  const tok = 'sk-ant-oat01-' + 'A'.repeat(40) + '-XyZ_12';
  const out = `Success!\nYour token:\n${tok}\nStore it safely.`;
  assert.equal(extractToken(out), tok);
});

test('extractToken does not match ordinary api keys', () => {
  assert.equal(extractToken('ANTHROPIC_API_KEY=sk-ant-api03-' + 'B'.repeat(40)), null);
});
