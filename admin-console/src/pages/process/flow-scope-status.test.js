import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  flowScopeStatus, flowNotFoundCopy, MAX_ECHOED_SCOPE_LENGTH,
} from './flow-scope-status.js';

const teams = [{ id: 'alpha', role: 'team' }];
const drafts = [{ id: 'd1', name: 'Untitled flow' }];

test('no selection is "none"', () => {
  assert.equal(flowScopeStatus({ proc: null, teams, drafts }), 'none');
  assert.equal(flowScopeStatus({ proc: '', teams, drafts }), 'none');
});

test('a known team or visible draft is "ok"', () => {
  assert.equal(flowScopeStatus({ proc: 'alpha', teams, drafts }), 'ok');
  assert.equal(flowScopeStatus({ proc: 'draft:d1', teams, drafts }), 'ok');
});

test('the transient import scope is "ok" without consulting the lists', () => {
  assert.equal(flowScopeStatus({ proc: 'import', teams: null, drafts: null }), 'ok');
});

test('never decides before both lists have loaded (no "not found" flash)', () => {
  for (const [t, d] of [[null, drafts], [teams, null], [null, null], [undefined, undefined]]) {
    assert.equal(flowScopeStatus({ proc: 'ghost', teams: t, drafts: d, verifiedScope: 'ghost' }), 'loading');
  }
});

test('an unknown scope asks for one verifying refetch before "not-found"', () => {
  assert.equal(flowScopeStatus({ proc: 'ghost', teams, drafts }), 'verify');
  assert.equal(flowScopeStatus({ proc: 'draft:gone', teams, drafts }), 'verify');
  // A refetch made for a different scope does not count.
  assert.equal(flowScopeStatus({ proc: 'ghost', teams, drafts, verifiedScope: 'other' }), 'verify');
});

test('still unknown after the refetch for that scope is "not-found"', () => {
  assert.equal(flowScopeStatus({ proc: 'ghost', teams, drafts, verifiedScope: 'ghost' }), 'not-found');
  assert.equal(flowScopeStatus({ proc: 'draft:gone', teams, drafts, verifiedScope: 'draft:gone' }), 'not-found');
});

test('a scope that appears after the refetch is "ok", not "not-found"', () => {
  const later = [...drafts, { id: 'fresh' }];
  assert.equal(flowScopeStatus({ proc: 'draft:fresh', teams, drafts: later, verifiedScope: 'draft:fresh' }), 'ok');
});

test('a team id and a draft id do not stand in for each other', () => {
  // `?proc=d1` is a team lookup; `?proc=draft:alpha` a draft lookup.
  assert.equal(flowScopeStatus({ proc: 'd1', teams, drafts, verifiedScope: 'd1' }), 'not-found');
  assert.equal(flowScopeStatus({ proc: 'draft:alpha', teams, drafts, verifiedScope: 'draft:alpha' }), 'not-found');
});

test('not-found copy names the id, distinguishes drafts, and offers a way back', () => {
  const team = flowNotFoundCopy('does-not-exist');
  assert.equal(team.title, 'Flow "does-not-exist" not found');
  assert.match(team.hint, /deleted/);
  assert.match(team.hint, /access/);
  assert.equal(team.backLabel, 'Back to Flows');
  assert.equal(flowNotFoundCopy('draft:abc').title, 'Draft "abc" not found');
});

test('not-found copy truncates an over-long id', () => {
  const long = 'x'.repeat(MAX_ECHOED_SCOPE_LENGTH + 20);
  assert.equal(flowNotFoundCopy(long).title, `Flow "${'x'.repeat(MAX_ECHOED_SCOPE_LENGTH)}…" not found`);
});

// ── #651 wiring guard ────────────────────────────────────────────────────────
// Briefings.jsx is JSX and cannot be loaded by node --test; pin the wiring so
// the pure decision above cannot silently fall out of the page.

const HERE = path.dirname(fileURLToPath(import.meta.url));
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
}
const page = code(fs.readFileSync(path.join(HERE, '..', 'Briefings.jsx'), 'utf8'));

test('Briefings feeds flowScopeStatus null lists until each has loaded', () => {
  assert.ok(page.includes(
    'flowScopeStatus({ proc, teams: agents ? teams : null, drafts: draftsList ? drafts : null, verifiedScope, })',
  ));
});

test('Briefings refetches both lists for a "verify" scope, then marks it verified', () => {
  assert.ok(page.includes("if (scopeStatus !== 'verify') return;"));
  assert.ok(page.includes('Promise.all([refetchAgents(), refetchDrafts()]).then(() => { if (!cancelled) setVerifiedScope(proc); });'));
});

test('Briefings renders the not-found state ahead of the graph panel', () => {
  const notFound = page.indexOf("{scopeStatus === 'not-found' ? ( <FlowNotFound proc={proc} onBack={() => setSearchParams({})} /> ) : proc ? (");
  const panel = page.indexOf('<ProcessGraphPanel key={proc}');
  assert.ok(notFound > -1, 'not-found branch missing');
  assert.ok(panel > notFound, 'not-found branch must guard the graph panel');
});

test('FlowNotFound renders the pure copy (title, hint, back button)', () => {
  const start = page.indexOf('function FlowNotFound(');
  const body = page.slice(start, page.indexOf('export default function Briefings', start));
  assert.ok(start > -1);
  for (const s of ['flowNotFoundCopy(proc)', '{copy.title}', '{copy.hint}', 'onClick={onBack}', '{copy.backLabel}']) {
    assert.ok(body.includes(s), `FlowNotFound missing ${s}`);
  }
});
