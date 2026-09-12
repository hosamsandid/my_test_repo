// Run: node --test admin-console/src/pages/tiered-resource-form-wiring.test.js
//
// #2169 (epic #2166 A3) — the source-reading drift guard (#651) over the two
// forms that used to carry the shared `CredentialOwnership` picker: the
// Working Environments create/edit panel and the MCP Servers create panel.
// #2083 gave both forms that control; this ticket removes it from both — an
// environment/MCP server's visibility is derived from its owning team, never
// chosen on the form that creates or edits it. This file used to assert the
// control's PRESENCE (#2083); it now asserts its ABSENCE, mirroring
// `agent-chat/team-environment-tabs-wiring.test.js`'s "the team panel renders
// no ownership/team picker" guard for the same reason stated there: the
// record already belongs to a team, so this is not a re-tier surface.
//
// #2170 (epic #2166 A4) renamed the Working Environments page to Environment
// Templates and RETIRED its Global toggle outright (replaced by the
// `isTemplate` flag, set implicitly by the page rather than a form checkbox) —
// the environment-side assertions below were updated from "the toggle
// survives" to "the toggle is gone" accordingly. The MCP form's OWN,
// independent Global toggle (#2158) is untouched by this ticket and keeps its
// original assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dirname, f), 'utf8');

function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const ENV = stripComments(read('EnvironmentTemplates.jsx'));
const MCP = stripComments(read('McpServers.jsx'));

// The enclosing function's body, so an assertion cannot drift into a
// neighbouring component. Scanned with the `^(?:export default )?function `
// anchor rather than `indexOf('\nfunction ')`, which runs off the end of the
// file when the next declaration is an `export default function`.
function componentBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found — this guard needs re-pointing`);
  const rest = src.slice(at + 1);
  const next = rest.search(/^(?:export default )?function /m);
  return next === -1 ? src.slice(at) : src.slice(at, at + 1 + next);
}

test('neither form renders the shared ownership control any more', () => {
  for (const [label, src] of [['EnvironmentTemplates.jsx', ENV], ['McpServers.jsx', MCP]]) {
    assert.doesNotMatch(src, /CredentialOwnership/,
      `${label}: the record already belongs to its team — this is not a re-tier surface`);
    assert.doesNotMatch(src, /ownershipPayload/, `${label} must not post an ownership tier`);
    assert.doesNotMatch(src, /ownershipFromRecord|defaultOwnership\(/, `${label} must not seed an ownership control that no longer exists`);
    assert.doesNotMatch(src, /teamId/, `${label}: no team-assignment field belongs on this form`);
    assert.doesNotMatch(src, /adminTeamIds/, `${label}: no ownership control left to feed it`);
  }
});

test('the environment form no longer fetches the team list just to feed the removed control', () => {
  // The env form still needs plenty of other lists (ssh keys, tokens, llm
  // endpoints, toolchains, mcp servers/credentials) — only the admin-teams
  // fetch, which fed CredentialOwnership alone, should be gone.
  assert.doesNotMatch(ENV, /useApi\('\/api\/admin\/teams'\)/);
});

test('the MCP server form no longer fetches the team list just to feed the removed control', () => {
  assert.doesNotMatch(MCP, /useApi\('\/api\/admin\/teams'\)/);
});

test('the MCP form still imports useAuth, for the surviving Global toggle', () => {
  assert.match(MCP, /import \{ useAuth \} from '\.\.\/auth\/AuthContext'/, 'McpServers.jsx');
});

test('the environment form has no Global toggle at all — retired by #2170, replaced by isTemplate', () => {
  assert.doesNotMatch(ENV, /useAuth/, 'EnvironmentTemplates.jsx must not import useAuth — no client-side admin check is needed');
  assert.doesNotMatch(ENV, /isSysAdmin/, 'EnvironmentTemplates.jsx must not resolve isSysAdmin — the removed Global toggle was its only use');
  assert.doesNotMatch(ENV, /isGlobal/i, 'EnvironmentTemplates.jsx must not reference the retired Global flag');
});

test('the MCP server form still resolves isSysAdmin from the session, for the surviving Global toggle', () => {
  const mcpForm = componentBody(MCP, 'CreateServerForm');
  assert.match(mcpForm, /const isSysAdmin = !!user\?\.admin;/);
  assert.match(mcpForm, /isGlobal/);
  assert.match(mcpForm, /\(isSysAdmin \? \{ global: isGlobal \} : \{\}\)/);
});
