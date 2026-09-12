import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TEAM_ID_SUFFIX,
  TEAM_NAME_SUFFIX,
  previewTeamId,
  previewTeamName,
  convertDialogCopy,
  convertConsequences,
  convertBusyNotice,
  convertResultNotice,
} from './convert-to-team-view.js';

const AGENT = { id: 'research-assistant', displayName: 'Research Assistant', role: 'agent' };

test('the previewed team identity is derived from the agent', () => {
  assert.equal(previewTeamId(AGENT), 'research-assistant-team');
  assert.equal(previewTeamName(AGENT), 'Research Assistant Team');
});

test('a nameless agent falls back to its id, never to "undefined Team"', () => {
  assert.equal(previewTeamName({ id: 'bot-7' }), 'bot-7 Team');
  assert.equal(previewTeamName({ id: 'bot-7', displayName: '   ' }), 'bot-7 Team');
  assert.equal(previewTeamName(null), '');
  assert.equal(previewTeamId(null), '');
});

// ── AC2: the confirmation names what happens and that it is one-way ─────────

test('the confirm names the agent and the action', () => {
  const copy = convertDialogCopy(AGENT);
  assert.equal(copy.title, 'Convert "Research Assistant" into a team?');
  assert.equal(copy.confirmLabel, 'Convert into a team');
  assert.equal(typeof copy.maxWidth, 'number');
});

test('the confirm still reads sensibly for an agent with no display name', () => {
  assert.equal(convertDialogCopy({ id: 'bot-7' }).title, 'Convert "bot-7" into a team?');
  assert.equal(convertDialogCopy(null).title, 'Convert "this assistant" into a team?');
});

test('AC2 — the consequences name the new team, what survives, and the one-way door', () => {
  const lines = convertConsequences(AGENT);
  const blob = lines.join(' ');
  assert.ok(lines.length >= 4);
  assert.match(blob, /Research Assistant Team/);
  assert.match(blob, /research-assistant-team/);
  // What survives — the questions users actually have.
  for (const kept of [/history/i, /system prompt/i, /skills/i, /triggers/i, /environment/i]) {
    assert.match(blob, kept);
  }
  // And the two things that change.
  assert.match(blob, /restarts/i);
  assert.match(blob, /cannot be undone/i);
});

// ── the busy refusal (the in-flight-run edge case) ──────────────────────────

test('a busy refusal is turned into a sentence naming why', () => {
  assert.match(
    convertBusyNotice({ warning: true, busy: true, activeTriggers: [] }),
    /working on a message right now.*restarts it/s,
  );
  assert.match(
    convertBusyNotice({ warning: true, busy: false, activeTriggers: ['nightly-sweep'] }),
    /1 active trigger run \(nightly-sweep\)/,
  );
  assert.match(
    convertBusyNotice({ warning: true, busy: true, activeTriggers: ['a', 'b'] }),
    /working on a message right now and has 2 active trigger runs \(a, b\)/,
  );
});

test('a warning with no detail still says something actionable', () => {
  assert.match(convertBusyNotice({ warning: true }), /This assistant is busy\./);
});

test('a successful response is not mistaken for a busy refusal', () => {
  assert.equal(convertBusyNotice({ id: 'a', teamId: 'a-team' }), null);
  assert.equal(convertBusyNotice(null), null);
  assert.equal(convertBusyNotice({ warning: false }), null);
});

// ── the success notice ─────────────────────────────────────────────────────

test('the success notice names the team and points at the next step', () => {
  const notice = convertResultNotice({ id: 'a', teamId: 'a-team', teamName: 'A Team' });
  assert.match(notice, /"A Team"/);
  assert.match(notice, /second member/i);
});

test('AC5 — a partial conversion reports its warnings rather than saying "done"', () => {
  const notice = convertResultNotice({
    id: 'a', teamId: 'a-team', teamName: 'A Team',
    warnings: ["skill 'cobol' could not be copied into the new team's pool: EACCES"],
  });
  assert.match(notice, /Some steps reported a problem: skill 'cobol' could not be copied/);
});

test('a response without a team id yields no notice', () => {
  assert.equal(convertResultNotice(null), null);
  assert.equal(convertResultNotice({ warning: true }), null);
});

// ── drift guard: the derivation is mirrored from the orchestrator ───────────

test('the derived suffixes match the orchestrator that actually mints the team', () => {
  // The dialog promises the user a specific team id and name; the orchestrator
  // is what creates them. If the two ever diverge the confirmation lies, and no
  // other test in either package would notice — so read the source of record.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, '..', '..', '..', '..', 'orchestrator', 'team-conversion.js'),
    'utf8',
  );
  const idSuffix = /TEAM_ID_SUFFIX\s*=\s*'([^']*)'/.exec(src);
  const nameSuffix = /TEAM_NAME_SUFFIX\s*=\s*'([^']*)'/.exec(src);
  assert.ok(idSuffix && nameSuffix, 'orchestrator/team-conversion.js no longer declares the suffixes — re-point this guard');
  assert.equal(idSuffix[1], TEAM_ID_SUFFIX);
  assert.equal(nameSuffix[1], TEAM_NAME_SUFFIX);
});
