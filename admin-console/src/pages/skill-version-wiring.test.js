// #2839 — source-reading guards that the version JSX (Versions tab, diff modal,
// old-version mode of the editor) actually uses the pure skill-version-view
// helpers and the version API (JSX itself stays uncovered, #651).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODAL = fs.readFileSync(path.join(here, 'SkillEditorModal.jsx'), 'utf8');
const DIFF = fs.readFileSync(path.join(here, 'SkillVersionDiffModal.jsx'), 'utf8');
const REGISTRY = fs.readFileSync(path.join(here, 'SkillsRegistry.jsx'), 'utf8');

function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}(`);
  const end = src.indexOf('\nfunction ', start + 1);
  assert.ok(start > 0, `${name} not found — re-point this guard`);
  return src.slice(start, end > start ? end : undefined);
}

test('Versions tab: rows, working-copy row, two-version selection and "content not available"', () => {
  const tab = fnSrc(REGISTRY, 'VersionsTab');
  assert.match(tab, /versionRows\(lineage\?\.versions\)/);
  assert.match(tab, /toggleCompareSelection\(/);
  assert.match(tab, /normalizeComparePair\(rows, picked\[0\], picked\[1\]\)/);
  assert.match(tab, /Working copy \(unversioned changes\)/);
  assert.match(tab, /Content not available/);
  assert.match(tab, />Open</);
  assert.match(tab, /Compare with current/);
  assert.match(tab, /onCompare\(r\.ref, 'working'\)/);
  assert.match(tab, /r\.current && <Chip label="current"/, 'current comes from the server flag (exactly one)');
});

test('SkillViewer: opens the editor on a version, mounts the diff modal, reloads lineage after a save/restore', () => {
  const viewer = fnSrc(REGISTRY, 'SkillViewer');
  assert.match(viewer, /versionActionPermission\(skill, caller, agentTeamId\)/);
  assert.match(viewer, /installableAgents \?\? \[\]\)\.find\(a => a\.id === skill\.agentId\)\?\.parentTeamId/);
  assert.match(viewer, /version=\{openVersion\}/);
  assert.match(viewer, /versionPermission=\{versionPerm\}/);
  assert.match(viewer, /<SkillVersionDiffModal skill=\{skill\} from=\{comparePair\.from\} to=\{comparePair\.to\}/);
  assert.match(viewer, /if \(lineage\) reloadLineage\(\)/);
});

test('diff modal: server diff, session-remembered mode, unchanged toggle, +/− markers, no-differences text', () => {
  assert.match(DIFF, /\/versions\/diff\?/);
  assert.match(DIFF, /readDiffMode\(/);
  assert.match(DIFF, /writeDiffMode\(/);
  assert.match(DIFF, /sessionStorage/);
  assert.match(DIFF, /visibleDiffFiles\(data\.files, showUnchanged\)/);
  assert.match(DIFF, /buildUnifiedRows\(ops\)/);
  assert.match(DIFF, /buildSplitRows\(ops\)/);
  assert.match(DIFF, /fileNote\(file\)/);
  assert.match(DIFF, /'\+': '\+', '-': '−'/, 'lines carry a +/− marker, not just colour');
  assert.match(DIFF, /No differences/);
  assert.match(DIFF, /Show unchanged files/);
  assert.match(DIFF, /width: '96vw', height: '94vh'/, 'full-screen like the editor');
});

test('editor old-version mode: snapshot listing, banner, compare, confirmed restore, edit from version', () => {
  assert.match(MODAL, /\/versions\/\$\{encodeURIComponent\(versionHash\)\}\/files\?/);
  assert.match(MODAL, /\/versions\/\$\{encodeURIComponent\(versionHash\)\}\/file\?/);
  assert.match(MODAL, /const readOnly = readOnlyProp \|\| !!versionView/);
  assert.match(MODAL, /You are viewing an old version/);
  assert.match(MODAL, /versionLabel\(/);
  assert.match(MODAL, /kind: 'compare'/);
  assert.match(MODAL, /kind: 'confirm-restore'/);
  assert.match(MODAL, /\/restore\?[\s\S]*?method: 'POST'[\s\S]*?baseHash: currentHash/);
  assert.match(MODAL, /e\.status === 409/);
  assert.match(MODAL, /planEditFromVersion\(diff\)/);
  assert.match(MODAL, /encoding: 'base64'/);
  assert.match(MODAL, /decodeVersionFile\(/);
  assert.match(MODAL, /applyVersionPlan\(createModel\(listingNow\), planned\.plan, planned\.contents\)/);
  assert.match(MODAL, /d\.hash !== planned\.expectHash/, 'a concurrent edit is not silently overwritten');
  // restore / edit-from are disabled without permission and on the current version
  assert.match(MODAL, /disabled=\{versionBusy \|\| !restorePerm\.ok \|\| versionIsCurrent\}/);
  assert.match(MODAL, /disabled=\{versionBusy \|\| !editFromPerm\.ok \|\| versionIsCurrent\}/);
});
