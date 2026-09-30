import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEffectiveCredential, personalCredentialChangeNotice, loadPersonalCredentialChangeNotice } from './effective-identity-view.js';

const teamCred = { id: 'team-pat', name: 'Team PAT' };

test('#2560 personal source (another admin): names the admin, marks the team token overridden', () => {
  const out = describeEffectiveCredential({
    kindLabel: 'GitHub token', source: 'personal', owner: { label: 'Alice Admin', isYou: false },
    credential: null, teamCredential: { ...teamCred, inUse: false, overridden: true },
  });
  assert.equal(out.headline, "Team Admin's personal GitHub token — Alice Admin");
  assert.match(out.detail, /as Alice Admin/);
  assert.equal(out.teamNote, "Team GitHub token Team PAT (team-pat): not in use (overridden by the Team Admin's personal GitHub token).");
  assert.equal(out.tone, 'info');
});

test('#2560 personal source (caller owns it): says "you" and names the own credential', () => {
  const out = describeEffectiveCredential({
    kindLabel: 'SSH key', source: 'personal', owner: { label: 'Alice', isYou: true },
    credential: { id: 'alice-key', name: 'Laptop' }, teamCredential: null,
  });
  assert.equal(out.headline, 'Your personal SSH key — Laptop (alice-key)');
  assert.match(out.detail, /as you\./);
  assert.equal(out.teamNote, null);
});

test('#2560 team / global / none', () => {
  const team = describeEffectiveCredential({
    kindLabel: 'GitHub token', source: 'team', credential: teamCred, teamCredential: { ...teamCred, inUse: true, overridden: false },
  });
  assert.match(team.headline, /^Team GitHub token — Team PAT \(team-pat\)$/);
  assert.equal(team.teamNote, null);
  assert.match(describeEffectiveCredential({ kindLabel: 'GitHub token', source: 'global' }).headline, /^Global service/);
  const none = describeEffectiveCredential({ kindLabel: 'GitHub token', source: 'none' });
  assert.equal(none.headline, 'None configured');
  assert.equal(none.tone, 'warning');
});

test('#2560 orphaned personal credential is a warning problem state', () => {
  const out = describeEffectiveCredential({
    kindLabel: 'GitHub token', source: 'team', problem: 'orphaned',
    owner: { label: 'a deleted user', isYou: false }, credential: teamCred, teamCredential: { ...teamCred, inUse: true },
  });
  assert.equal(out.tone, 'warning');
  assert.match(out.problem, /no longer a user/);
});

const mine = (displayName, source, extra = {}) => ({
  agentId: displayName.toLowerCase(), displayName,
  github: { source, owner: source === 'personal' ? { label: 'Me', isYou: true } : null, ...extra },
  ssh: { source: 'none' },
});

test('#2560 AC4: adding names the teams that now use it and says "next start"', () => {
  const text = personalCredentialChangeNotice({
    kind: 'github', action: 'added', teams: [mine('Alpha', 'personal'), mine('Beta', 'personal')],
  });
  assert.match(text, /2 of your teams \(Alpha, Beta\)/);
  assert.match(text, /automatic work and in-container GitHub actions/);
  assert.match(text, /next start/);
});

test('#2560 AC4: no teams → no notice', () => {
  assert.equal(personalCredentialChangeNotice({ kind: 'github', action: 'added', teams: [] }), null);
  assert.equal(personalCredentialChangeNotice({ kind: 'ssh', action: 'added', teams: [mine('Alpha', 'personal')] }), null);
});

test('#2560 AC5: deleting says what each team falls back to, including nothing', () => {
  const text = personalCredentialChangeNotice({
    kind: 'github', action: 'deleted',
    teams: [mine('Alpha', 'team', { teamCredential: teamCred }), mine('Beta', 'none'), mine('Gamma', 'global')],
  });
  assert.match(text, /Alpha falls back to the team GitHub token Team PAT \(team-pat\)/);
  assert.match(text, /Beta has no GitHub token at all any more/);
  assert.match(text, /Gamma falls back to a global service credential/);
  assert.match(text, /next start/);
});

test('#2560 loadPersonalCredentialChangeNotice reads /api/me/baseline-teams and swallows failures', async () => {
  let asked = null;
  const text = await loadPersonalCredentialChangeNotice(async (url) => { asked = url; return { teams: [mine('Alpha', 'personal')] }; }, { kind: 'github', action: 'added' });
  assert.equal(asked, '/api/me/baseline-teams');
  assert.match(text, /your team \(Alpha\)/);
  assert.equal(await loadPersonalCredentialChangeNotice(async () => { throw new Error('502'); }, { kind: 'github', action: 'added' }), null);
});
