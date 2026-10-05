import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard for the skill detail panel's "Copies & origin"
// tab (#2840, #651). Grouping, labels, origin text and drift explanations are
// unit-tested in skill-copies-view.test.js; this checks the JSX actually uses
// them and that the retired Lineage / Usage tabs are gone.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'SkillsRegistry.jsx'), 'utf8');

test('the panel offers Content, Versions and Copies & origin only (#2840 AC1)', () => {
  const tabs = SRC.slice(SRC.indexOf('const VIEWER_TABS = ['), SRC.indexOf('const VIEWER_TAB_IDS'));
  assert.match(tabs, /label: 'Content'/);
  assert.match(tabs, /label: 'Versions'/);
  assert.match(tabs, /\{ id: COPIES_TAB_ID, label: 'Copies & origin' \}/);
  assert.doesNotMatch(tabs, /Lineage|Usage/);
  assert.doesNotMatch(SRC, /function (LineageTab|UsageTab)\b/);
});

test('old tab ids from deep links and the downstream badge resolve to the merged tab (#2840 AC1)', () => {
  assert.match(SRC, /resolveViewerTab\(skill\.initialTab, VIEWER_TAB_IDS\)/);
  assert.match(SRC, /resolveViewerTab\(tabParam, VIEWER_TAB_IDS\)/);
  assert.match(SRC, /initialTab: COPIES_TAB_ID/);
  assert.doesNotMatch(SRC, /initialTab: 'usage'/);
});

test('CopiesTab renders the grouped view, origin sentence, filter and resync actions once (#2840 AC2-AC11)', () => {
  const start = SRC.indexOf('function CopiesTab(');
  const body = SRC.slice(start, SRC.indexOf('const VIEWER_TABS = ['));
  assert.ok(start > 0);
  assert.match(body, /buildCopiesView\(copies, \{ agents, teamNames \}\)/);
  assert.match(body, /describeOrigin\(origin, \{ agents, teamNames, sourceGone \}\)/);
  assert.match(body, /shouldOfferCopyFilter\(view\.total\)/);
  assert.match(body, /filterCopyGroups\(view\.groups, query\)/);
  assert.match(body, /DRIFT_LEGEND_ORDER\.map/);
  assert.match(body, /Only this copy exists\./);
  assert.equal(body.match(/<CopyResyncAction /g).length, 1);
  assert.equal(body.match(/<BulkResyncActions /g).length, 1);
  // AC14: the tier is shown as text in the label, never also as a SourceBadge.
  assert.doesNotMatch(body, /<SourceBadge/);
});

test('drift badges carry the plain-language tooltip; the viewer gets every agent (#2840 AC9/AC15)', () => {
  assert.match(SRC, /title=\{driftTooltip\(state\) \|\|/);
  assert.match(SRC, /agents=\{agentDirectory\} teamNames=\{teamNames\}/);
  assert.match(SRC, /agentDirectory=\{agentDirectory\}/);
});
