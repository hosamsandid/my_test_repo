import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// #2760 AC5 wiring guard — the JSX is uncovered by a renderer (#651), so the
// facts the pure `pool-cap-view.js` relies on are checked in the source:
// both surfaces that show a pooled role's instance count read it against the
// cap and mark an over-cap count.

const here = dirname(fileURLToPath(import.meta.url));
const sourceOf = (rel) => readFileSync(join(here, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('rail: "Instances (n)" label and marker use the role template\'s poolMaxInstances', () => {
  const src = sourceOf('../agent-chat/AgentList.jsx');
  assert.match(src, /const cap = roleAgent\.poolMaxInstances \?\? null;/);
  assert.match(src, /poolInstancesLabel\(instances\.length, cap\)/);
  assert.match(src, /const capView = poolCapView\(instances\.length, cap\);/);
  assert.match(src, /\{capView\.over && \(\s*<AlertTriangle/);
  assert.match(src, /title=\{`Live pool instances of [^`]*\$\{capView\.title\}`\}/);
});

test('API: the roster ships poolMaxInstances on pooled role templates', () => {
  const api = readFileSync(join(here, '../../../api/api.js'), 'utf8');
  assert.match(api, /!cfg\.poolInstance && cfg\.pool && typeof cfg\.pool === 'object' && cfg\.pool\.enabled === true \? \{\s*poolMaxInstances:/);
});

test('Scaling section: both hosts pass the live count from the team pool-control read', () => {
  const section = sourceOf('./ScalingSection.jsx');
  assert.match(section, /\{live && <LiveInstances count=\{live\.count\} cap=\{live\.cap\} \/>\}/);
  assert.match(section, /const view = poolCapView\(count, cap\);/);
  assert.match(section, /title=\{view\.title\}/);
  assert.match(section, /\{view\.over && \(/);
  const inspector = sourceOf('./NodeInspector.jsx');
  assert.match(inspector, /useApi\(isPooledRoleNode \? poolControlUrl\(memberCfg\) : null\)/);
  assert.match(inspector, /live=\{livePoolCount\(poolControl, memberCfg\.id\)\}/);
  const form = sourceOf('../agent-lifecycle/AgentEditForm.jsx');
  assert.match(form, /useApi\(poolControlUrl\(agent\)\)/);
  assert.match(form, /live=\{livePoolCount\(poolControl, agent\.id\)\}/);
});
