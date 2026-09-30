import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #2651 "plugin not installed" grant rows.
 *
 * Which grants are orphaned and what their labels say is decided by the pure
 * `uninstalledGrantRows` (plugin-grant-view.test.js). `AgentEditForm.jsx` is
 * JSX, which `node --test` does not load (#651), so this reads the source and
 * checks the WIRING: the rows are computed from the live grant, rendered with
 * a status and a Revoke that deactivates the grant, and shown even when no
 * plugin is installed at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'AgentEditForm.jsx'), 'utf8');
const start = SRC.indexOf('export function PluginGrantSection(');
const end = SRC.indexOf('export function PluginServiceAccountSection(');
const SECTION = SRC.slice(start, end);

test('the section slice is found', () => {
  assert.ok(start > 0 && end > start);
});

test('orphaned grants are computed from the optimistic grant and the installed list', () => {
  assert.match(SECTION, /const orphans = React\.useMemo\(\(\) => uninstalledGrantRows\(grant, installed\), \[grant, installed\]\);/);
});

test('each orphan row shows its id and status', () => {
  assert.match(SECTION, /<span style=\{\{ fontWeight: 600 \}\}>\{row\.id\}<\/span>/);
  assert.match(SECTION, /<span style=\{[^}]*\}\}>\{row\.status\}<\/span>/);
  assert.match(SECTION, /\{UNINSTALLED_GRANT_HINT\}/);
});

test('the Revoke button deactivates the grant at its stored granularity and is labelled', () => {
  const btn = SECTION.match(/<button\s+type="button"[\s\S]*?<\/button>/);
  assert.ok(btn, 'Revoke button not found');
  assert.match(btn[0], /aria-label=\{row\.revokeLabel\}/);
  assert.match(btn[0], /disabled=\{busy\}/);
  assert.match(btn[0], /onClick=\{\(\) => onToggle\(row\.id, false, row\.granularity\)\}/);
  assert.match(btn[0], />\s*Revoke\s*<\/button>/);
});

test('orphans are rendered under the picker and keep the tab visible with nothing installed', () => {
  assert.match(SECTION, /if \(installed\.length === 0 && !orphanList\) \{/);
  assert.match(SECTION, /disabled=\{busy\}\s*\/>\s*\{orphanList\}\s*<\/div>/);
});
