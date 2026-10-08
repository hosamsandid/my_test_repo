// #2938: drift guard — every credential surface carries the commit-signing
// controls and the non-blocking recommendation. The wording/logic is tested in
// commit-signing-view.test.js; this only checks the JSX wires it in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('SSH Keys: signing fields on create (both modes) and edit, public key reveal, hint, ?new=signing', () => {
  const src = read('./SshKeys.jsx');
  assert.match(src, /<SigningFields value=\{signing\} onChange=\{setSigning\} \/>/);
  assert.match(src, /signing: signingPayload\(signing\) \}\)/g);
  assert.equal(src.match(/signing: signingPayload\(signing\)/g).length, 2, 'paste and generate both send signing');
  assert.match(src, /<SigningEditSection key=\{editTarget\.id\}/);
  assert.match(src, /SIGNING_UPLOAD_HINT/);
  assert.match(src, /signingRecommendation\(rows\)/);
  assert.match(src, /searchParams\.get\('new'\) !== 'signing'/);
});

test('GitHub Tokens and the team panel show the recommendation linking to setup', () => {
  const tokens = read('./GithubTokens.jsx');
  assert.match(tokens, /signingRecommendation\(sshKeysData, \{ context: 'github' \}\)/);
  assert.match(tokens, /<Link to=\{signingHint\.href\}>/);
  const team = read('./agent-chat/TeamEnvironmentPanel.jsx');
  assert.match(team, /\{data\.signing && <EffectiveSigningRow view=\{data\.signing\} \/>\}/);
  assert.match(team, /<Link to=\{hint\.href\}>/);
});
