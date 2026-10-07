// #2858 — source-reading wiring guard (#651): the JSX itself is not unit-tested,
// so this asserts every in-scope live-team label editor goes through
// SuffixedLabelInput (base + suffix chip), that the Flow editor and the
// Triggers tab provide the team's suffix, and that Team Settings hosts the
// central "Label suffix" control. The split/join logic is unit-tested in
// label-suffix-view.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

test('every label field in the hand-off / channel / gate / event dialogs is a SuffixedLabelInput (AC1)', () => {
  const src = read('EdgeDialogs.jsx');
  assert.match(src, /import SuffixedLabelInput from '..\/..\/components\/SuffixedLabelInput';/);
  for (const setter of ['setLabel', 'setGateLabel', 'setRejectLabel', 'setLabelName']) {
    assert.doesNotMatch(src, new RegExp(`<input [^>]*onChange=\\{e => ${setter}\\(e\\.target\\.value\\)\\}`), `${setter} must use SuffixedLabelInput`);
    assert.match(src, new RegExp(`<SuffixedLabelInput [^>]*onChange=\\{${setter}\\}`), setter);
  }
  assert.equal((src.match(/<SuffixedLabelInput /g) || []).length, 11);
  // The gate's failure label lives in the shared ReadinessGateFields (#2912).
  const gate = read('ReadinessGateFields.jsx');
  assert.match(gate, /import SuffixedLabelInput from '..\/..\/components\/SuffixedLabelInput';/);
  assert.match(gate, /<SuffixedLabelInput value=\{value\.failureLabel\} onChange=\{v => set\(\{ failureLabel: v \}\)\}/);
});

test('an outcome\'s setLabel action uses the suffixed field', () => {
  assert.match(read('RoutingSection.jsx'), /<SuffixedLabelInput value=\{action\.label \|\| ''\} placeholder="label" onChange=\{v => onChange\(\{ \.\.\.action, type: 'setLabel', label: v \}\)\}/);
});

test('both human-role editors show bases and keep foreign labels unstamped (AC4)', () => {
  for (const f of ['HumanNodeInspector.jsx', 'HumanRegistryPanel.jsx']) {
    const src = read(f);
    assert.match(src, /const suffixCtx = useLabelSuffix\(\);/, f);
    assert.match(src, /useState\(labelListToText\(human\.emits, suffixCtx\)\)/, f);
    assert.match(src, /const emits = labelListFromText\(emitsText, suffixCtx, human\.emits\);/, f);
  }
});

test('the label registry shows base + chip', () => {
  assert.match(read('LabelRegistryPanel.jsx'), /<SuffixedLabelText label=\{row\.name\}/);
});

test('the Flow editor provides the suffix for a live team only (AC5, drafts out of scope)', () => {
  const src = read('../ProcessCanvas.jsx');
  assert.match(src, /parallelismTeamCfg && !imported && !proposal \? labelSuffixContextFor\(parallelismTeamCfg\) : null/);
  assert.match(src, /<LabelSuffixContext\.Provider value=\{labelSuffixCtx\}>/);
});

test('the Triggers tab stamps requireLabel and labelFilter through the suffixed field and shows the claim as base + chip + :wip', () => {
  const src = read('../agent-chat/TriggersPanel.jsx');
  assert.match(src, /<SuffixedLabelInput\s+type="text"\s+value=\{form\.requireLabel\}\s+onChange=\{v => set\('requireLabel', v\)\}/);
  assert.match(src, /<SuffixedLabelInput\s+type="text"\s+value=\{form\.labelFilter\}\s+onChange=\{v => set\('labelFilter', v\)\}/);
  assert.match(src, /<SuffixedLabelText label=\{`\$\{form\.labelFilter\.trim\(\)\}:wip`\} \/>/);
  assert.match(src, /<LabelSuffixContext\.Provider value=\{outerSuffixCtx \|\| ownSuffixCtx\}>/);
  assert.match(src, /setOwnSuffixCtx\(labelSuffixContextFor\(teamCfg\)\)/);
});

test('Team Settings → General hosts the central Label suffix control (AC6/AC9)', () => {
  const form = read('../agent-lifecycle/AgentEditForm.jsx');
  assert.match(form, /\{isTeam && activeTab === 'general' && \(\s+<LabelSuffixSection key=\{agent\.labelSuffix \|\| ''\} team=\{agent\} onApplied=\{onImmediateApply\} \/>/);
  const sec = read('../agent-lifecycle/LabelSuffixSection.jsx');
  const dry = sec.indexOf('post({ suffix: value, dryRun: true })');
  const confirm = sec.indexOf('<ConfirmDialog');
  const apply = sec.indexOf('post({ suffix: value })');
  assert.ok(dry > 0 && apply > dry && confirm > 0, 'preview first, apply only from the confirmation');
  assert.match(sec, /onConfirm=\{apply\}/);
  assert.match(sec, /labelSuffixError\(value\)/);
  assert.match(sec, /post\(\{ retry: true \}\)/);
  assert.match(sec, /\/label-suffix`/);
});
