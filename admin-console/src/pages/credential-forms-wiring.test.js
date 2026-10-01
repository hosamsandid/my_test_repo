// Source guards for the #2654 credential-form fixes (the #651 JSX convention:
// JSX is not rendered under node:test, so the wiring is regex-matched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8')
  // Strip comments so a prose mention is never read as code.
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const sshKeys = read('SshKeys.jsx');
const githubTokens = read('GithubTokens.jsx');
const idField = read('../components/IdField.jsx');
const ownership = read('../components/CredentialOwnership.jsx');

test('IdField labels its input (New Key / New Token ID field)', () => {
  assert.match(idField, /const inputId = useId\(\);/);
  assert.match(idField, /<label htmlFor=\{inputId\}[^>]*>\s*\{label\}/);
  assert.match(idField, /<input\s+id=\{inputId\}/);
});

test('ScopeTab exposes its selected state', () => {
  assert.match(ownership, /<button\s+type="button"\s+aria-pressed=\{!!active\}/);
});

test('Copy public key goes through copyText and reports a failure', () => {
  assert.match(sshKeys, /import \{ copyText, COPY_FAILED_HINT \} from '..\/components\/copy-text.js';/);
  assert.match(sshKeys, /if \(await copyText\(publicKey\)\) \{/);
  assert.match(sshKeys, /publicKeyRef\.current\?\.select\(\);\s*setCopyFailed\(true\);/);
  assert.match(sshKeys, /\{copyFailed && \(\s*<div role="alert"[^>]*>\s*\{COPY_FAILED_HINT\}\s*<\/div>/);
  assert.match(sshKeys, /<textarea\s+ref=\{publicKeyRef\}/);
  assert.doesNotMatch(sshKeys, /navigator\.clipboard/);
});

test('GitHub token inputs are masked (create + replace)', () => {
  assert.doesNotMatch(githubTokens, /<textarea\s+value=\{(token|rotateToken)\}/);
  assert.match(githubTokens, /<PasswordField\s+id="github-token-value"\s+value=\{token\}/);
  assert.match(githubTokens, /<label htmlFor="github-token-value"/);
  assert.match(githubTokens, /<PasswordField\s+value=\{rotateToken\}/);
});
