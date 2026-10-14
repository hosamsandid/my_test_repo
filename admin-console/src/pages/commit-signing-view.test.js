// #2938: commit-signing view helpers. Run: node --test src/pages/commit-signing-view.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signingFormValue, signingFormError, signingPayload, signingCell, signingRecommendation,
  signingScopesPresent, describeEffectiveSigning, SIGNING_SETUP_HREF, SIGNING_UPLOAD_HINT,
  personalSshUsageCell, signingUsageLine, signingDeleteImpact, personalSshChangeNotice, loadPersonalSshChangeNotice,
} from './commit-signing-view.js';
import { personalCredentialChangeNotice } from './effective-identity-view.js';

const signer = { id: 'k', scope: 'team', signing: { name: 'Bot', email: 'bot@corp.com' } };

test('form value, validation and payload (create omits, edit clears)', () => {
  assert.deepEqual(signingFormValue(signer), { enabled: true, name: 'Bot', email: 'bot@corp.com' });
  assert.deepEqual(signingFormValue(null, { enabled: true }), { enabled: true, name: '', email: '' });
  assert.equal(signingFormError({ enabled: false }), null);
  assert.match(signingFormError({ enabled: true, name: '', email: 'a@b.co' }), /name/);
  assert.match(signingFormError({ enabled: true, name: 'A<', email: 'a@b.co' }), /</);
  assert.match(signingFormError({ enabled: true, name: 'A', email: 'x' }), /valid email/);
  assert.equal(signingFormError({ enabled: true, name: 'A', email: 'a@b.co' }), null);
  assert.deepEqual(signingPayload({ enabled: true, name: ' A ', email: ' a@b.co ' }), { name: 'A', email: 'a@b.co' });
  assert.equal(signingPayload({ enabled: false }), undefined);
  assert.equal(signingPayload({ enabled: false }, { previous: signer.signing }), null);
});

test('table cell names the commit identity', () => {
  assert.equal(signingCell(signer).label, 'Signs as Bot <bot@corp.com>');
  assert.equal(signingCell({ id: 'x' }), null);
});

test('recommendation shows only while no visible key signs, names enforcement and links to setup', () => {
  const r = signingRecommendation([{ id: 'deploy', scope: 'team' }]);
  assert.match(r.text, /recommended/);
  assert.match(r.text, /mandatory/);
  assert.match(r.text, /2026-10-23/);
  assert.equal(r.href, SIGNING_SETUP_HREF);
  assert.equal(signingRecommendation([signer]), null);
  assert.match(signingRecommendation([], { context: 'github' }).text, /tokens/);
  assert.match(signingRecommendation(null, { context: 'team' }).text, /team/);
});

test('scopes present map system to global', () => {
  assert.deepEqual(signingScopesPresent([signer, { scope: 'system', signing: { email: 'a@b.co' } }, { scope: 'personal' }]), ['team', 'global']);
});

test('upload hint says Signing Key and verified email', () => {
  assert.match(SIGNING_UPLOAD_HINT, /Signing Key/);
  assert.match(SIGNING_UPLOAD_HINT, /verified email/);
});

test('effective signing row per source', () => {
  assert.equal(describeEffectiveSigning({ source: 'none' }).tone, 'warning');
  assert.match(describeEffectiveSigning({ source: 'team', credential: { id: 'k', name: 'Bot key' }, identity: { name: 'Bot', email: 'b@c.co' } }).detail, /Bot <b@c.co>/);
  assert.match(describeEffectiveSigning({ source: 'personal', owner: { label: 'Alice', isYou: false } }).headline, /Alice/);
  assert.match(describeEffectiveSigning({ source: 'personal', owner: { isYou: true }, credential: { id: 'mine' } }).headline, /Your personal/);
  assert.match(describeEffectiveSigning({ source: 'global' }).headline, /Global/);
});

// ── #2959: which key signs, on the SSH Keys page ─────────────────────────────

const ident = { name: 'uitest bot', email: 'uitest@example.com' };
const transportRow = { id: 'ui-tester', name: 'ui-tester', scope: 'personal', userId: 'u1', activePersonal: true };
const signRow = (over = {}) => ({ id: 'uitest-sign-a', name: 'uitest-sign-a', scope: 'personal', userId: 'u1', activePersonal: false, signing: ident,
  signingUsage: { tier: 'personal', active: true, signsFirstId: 'uitest-sign-a', nextId: null }, ...over });
const team = ({ ssh = 'ui-tester', signing = 'uitest-sign-a', fallback = { source: 'none', credential: null } } = {}) => ({
  agentId: 'uitest-speckit-lean', displayName: 'uitest Spec-Kit Lean',
  ssh: { source: 'personal', owner: { isYou: true }, credential: { id: ssh, name: ssh } },
  signing: signing
    ? { source: 'personal', owner: { isYou: true }, credential: { id: signing, name: signing }, identity: ident, fallback }
    : { source: 'none' },
});

test('#2959 transport key ≠ signing key: the signing key is never "Not in use" (AC1)', () => {
  const rows = [transportRow, signRow()];
  const cell = personalSshUsageCell(signRow(), { rows, teams: [team()] });
  assert.equal(cell.label, 'Not used for git transport');
  assert.equal(cell.active, true);
  assert.equal(cell.signing.label, 'Signs commits (personal) — uitest Spec-Kit Lean');
  assert.match(cell.signing.title, /uitest bot <uitest@example.com>/);
  // The transport key keeps its #2655 label and has no signing line.
  const t = personalSshUsageCell(transportRow, { rows, teams: [team()] });
  assert.equal(t.label, 'Active (personal)');
  assert.equal(t.signing, null);
});

test('#2959 transport key = signing key: one row, both roles', () => {
  const row = signRow({ id: 'ui-tester', name: 'ui-tester', activePersonal: true, signingUsage: { tier: 'personal', active: true, signsFirstId: 'ui-tester', nextId: null } });
  const cell = personalSshUsageCell(row, { rows: [row], teams: [team({ ssh: 'ui-tester', signing: 'ui-tester' })] });
  assert.equal(cell.label, 'Active (personal)');
  assert.equal(cell.signing.label, 'Signs commits (personal) — uitest Spec-Kit Lean');
});

test('#2959 no signing key: no signing line, no signing impact, #2655 wording unchanged', () => {
  const inactive = { ...transportRow, id: 'spare', activePersonal: false };
  const cell = personalSshUsageCell(inactive, { rows: [transportRow, inactive], teams: [team({ signing: null })] });
  assert.equal(cell.label, 'Not in use');
  assert.equal(cell.signing, null);
  assert.equal(signingUsageLine(transportRow), null);
  assert.equal(signingDeleteImpact(transportRow, { teams: [team({ signing: null })] }), null);
});

test('#2959 two personal keys with a signing identity: the second says which one signs first', () => {
  const first = signRow({ signingUsage: { tier: 'personal', active: true, signsFirstId: 'uitest-sign-a', nextId: 'scratch' } });
  const second = signRow({ id: 'scratch', name: 'Scratch', signingUsage: { tier: 'personal', active: false, signsFirstId: 'uitest-sign-a', nextId: null } });
  const rows = [transportRow, first, second];
  const cell = personalSshUsageCell(second, { rows, teams: [team()] });
  assert.equal(cell.label, 'Not in use'); // neither transport nor signing
  assert.equal(cell.signing.label, 'Signing identity set — not used: uitest-sign-a signs first');
  assert.equal(cell.signing.active, false);
  assert.equal(signingDeleteImpact(second, { rows, teams: [team()] }), null);
  // Deleting the first one hands signing to the second (AC3).
  const impact = signingDeleteImpact(first, { rows, teams: [team()] });
  assert.match(impact.intro, /changes the signing identity of your team/);
  assert.deepEqual(impact.items, ['uitest Spec-Kit Lean — then signed with your personal signing key Scratch (scratch)']);
});

test('#2959 delete impact of the only personal signing key names the team fallback (AC3)', () => {
  const rows = [transportRow, signRow()];
  const fb = (fallback) => signingDeleteImpact(signRow(), { rows, teams: [team({ fallback })] }).items[0];
  assert.equal(fb({ source: 'team', credential: { id: 'bot', name: 'Team bot' } }), 'uitest Spec-Kit Lean — then signed with the team signing key Team bot (bot)');
  assert.equal(fb({ source: 'global', credential: null }), 'uitest Spec-Kit Lean — then signed with the global signing key');
  assert.equal(fb({ source: 'none', credential: null }), 'uitest Spec-Kit Lean — then unsigned');
  const legacy = team(); delete legacy.signing.fallback; // older orchestrator: no fallback
  assert.match(signingDeleteImpact(signRow(), { rows, teams: [legacy] }).items[0], /team's or the global signing key, or unsigned/);
  // Not Team Admin anywhere: still signs the caller's chat turns.
  const solo = signingDeleteImpact(signRow(), { rows, teams: [] });
  assert.match(solo.intro, /chat turns/);
  assert.deepEqual(solo.items, []);
});

test('#2959 team/system signing keys show the environments they sign for and their fallback (AC4)', () => {
  const row = { id: 'team-sign', name: 'Team bot', scope: 'team', signing: ident, signingUsage: { tier: 'shared', environments: [
    { id: 'e1', name: 'Env one', source: 'team', fallback: { source: 'team', keyId: 'team-2', name: 'Team bot 2' } },
    { id: 'e2', name: 'Env two', source: 'team', fallback: { source: 'none', keyId: null, name: null } },
  ] } };
  const line = signingUsageLine(row);
  assert.equal(line.label, 'Signs commits — 2 environments');
  assert.match(line.title, /Env one, Env two/);
  assert.equal(personalSshUsageCell(row), null);
  const impact = signingDeleteImpact(row);
  assert.deepEqual(impact.items, ['Env one — then signed with the team signing key Team bot 2 (team-2)', 'Env two — then unsigned']);
  const unused = { ...row, signingUsage: { tier: 'shared', environments: [] } };
  assert.equal(signingUsageLine(unused).label, 'Signing identity set — not used');
  assert.equal(signingDeleteImpact(unused), null);
});

test('#2959 post-create notice: signing outcome separate from transport, never "not in use" for a signing key (AC2)', () => {
  const text = personalSshChangeNotice({ action: 'added', teams: [team()], credentialId: 'uitest-sign-a', signing: ident });
  assert.doesNotMatch(text, /not in use/);
  assert.match(text, /now signs the commits of your team \(uitest Spec-Kit Lean\) as uitest bot <uitest@example.com>/);
  assert.match(text, /Git transport keeps using your personal SSH key ui-tester/);
  // Same key for both: the #2655 transport sentence follows the signing one.
  const both = personalSshChangeNotice({ action: 'added', teams: [team({ ssh: 'k', signing: 'k' })], credentialId: 'k', signing: ident });
  assert.match(both, /now signs the commits.*Your personal SSH key is now used by your team/);
  // A second signing key: transport AND signing say it is not used.
  const shadow = personalSshChangeNotice({ action: 'added', teams: [team()], credentialId: 'scratch', signing: ident });
  assert.match(shadow, /is not in use/);
  assert.match(shadow, /Its signing identity is not used: your personal SSH key uitest-sign-a signs first/);
  // No signing identity: unchanged #2655 wording.
  assert.equal(personalSshChangeNotice({ action: 'added', teams: [team()], credentialId: 'x' }),
    personalCredentialChangeNotice({ kind: 'ssh', action: 'added', teams: [team()], credentialId: 'x' }));
});

test('#2959 post-delete notice says what the teams now sign with', () => {
  const before = [team()];
  const after = [team({ signing: null })];
  const text = personalSshChangeNotice({ action: 'deleted', teams: after, credentialId: 'uitest-sign-a', signedTeamsBefore: before, wasTransport: false });
  assert.equal(text, 'Commit signing changed: uitest Spec-Kit Lean now creates unsigned commits.');
  const toTeam = [{ ...team(), signing: { source: 'team', credential: { id: 'bot', name: 'Team bot' } } }];
  assert.match(personalSshChangeNotice({ action: 'deleted', teams: toTeam, signedTeamsBefore: before, wasTransport: false }), /now signs with the team signing key Team bot \(bot\)/);
  assert.equal(personalSshChangeNotice({ action: 'deleted', teams: after, signedTeamsBefore: [], wasTransport: false }), null);
});

test('#2959 loadPersonalSshChangeNotice reads baseline teams and swallows failures', async () => {
  let asked = null;
  const text = await loadPersonalSshChangeNotice(async (url) => { asked = url; return { teams: [team()] }; },
    { action: 'added', credentialId: 'uitest-sign-a', signing: ident });
  assert.equal(asked, '/api/me/baseline-teams');
  assert.match(text, /now signs the commits/);
  assert.equal(await loadPersonalSshChangeNotice(async () => { throw new Error('502'); }, { action: 'added' }), null);
});
