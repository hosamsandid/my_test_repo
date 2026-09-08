// Run: node --test admin-console/src/pages/tiered-resource-form-wiring.test.js
//
// #2083 — the source-reading drift guard (#651) over the two forms that gained
// an ownership control: the Working Environments create/edit panel and the MCP
// Servers create panel. Neither page contained the string `teamId` before this
// ticket, so this is the first ownership UI either has ever had.
//
// What it protects:
//
//  1. Both render the SHARED `CredentialOwnership` component. A second,
//     differently-worded picker for the same three tiers is precisely the drift
//     the #1928/#1929 shared-component discipline exists to prevent — and here
//     it would be worse than cosmetic, because the two pickers would disagree
//     about who may create a shared record.
//  2. The ownership actually reaches the request body. A control whose value is
//     never posted looks completely correct on screen and silently creates
//     team-tier records forever.
//  3. The environment form seeds from the RECORD, not from the create default.
//     This is the one non-obvious bug in the feature: the panel both creates and
//     edits, so a create-shaped seed would post `{scope:'team'}` over a shared
//     environment on the next ordinary save — and the server would accept it
//     from a System Admin, because for them that is a legal re-tier. The MCP
//     panel is create-only and correctly does NOT seed from a record.

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

const ENV = stripComments(read('WorkingEnvironments.jsx'));
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

test('both forms render the ONE shared ownership control', () => {
  for (const [label, src] of [['WorkingEnvironments.jsx', ENV], ['McpServers.jsx', MCP]]) {
    assert.match(src, /import CredentialOwnership from '\.\.\/components\/CredentialOwnership'/,
      `${label} must import the shared control`);
    assert.match(src, /<CredentialOwnership\b/, `${label} must render it`);
    // Exactly one instance per file: the environment panel serves create AND
    // edit from one component, so a second control would mean the two modes had
    // been forked.
    assert.equal((src.match(/<CredentialOwnership\b/g) || []).length, 1,
      `${label} must render exactly one ownership control`);
    // And no hand-rolled tier picker beside it.
    assert.doesNotMatch(src, /scope === 'system' \?/, `${label} must not re-implement the tier choice`);
  }
});

test('the ownership reaches the request body on both forms', () => {
  const envForm = componentBody(ENV, 'EnvironmentForm');
  const mcpForm = componentBody(MCP, 'CreateServerForm');
  for (const [label, body] of [['EnvironmentForm', envForm], ['CreateServerForm', mcpForm]]) {
    assert.match(body, /\.\.\.ownershipPayload\(ownership\),/,
      `${label} must spread the ownership into the save body`);
    // The spread has to be INSIDE the onSave/onSave-body call, not merely
    // present in the file.
    const saveAt = body.indexOf('onSave({');
    assert.ok(saveAt > 0, `${label} must have an onSave body`);
    assert.ok(body.indexOf('...ownershipPayload(ownership),') > saveAt,
      `${label}: the ownership spread must be inside the save body`);
  }
});

test('the environment form seeds from the record; the create-only MCP form does not', () => {
  const envForm = componentBody(ENV, 'EnvironmentForm');
  assert.match(envForm, /ownershipFromRecord\(initial, \{ isSysAdmin, adminTeamIds \}\)/,
    'a create-shaped seed would silently un-share a shared environment on the next save');
  assert.doesNotMatch(envForm, /useState\(\s*\(\) => defaultOwnership\(/,
    'the environment panel edits as well as creates, so defaultOwnership alone is wrong here');

  const mcpForm = componentBody(MCP, 'CreateServerForm');
  assert.match(mcpForm, /defaultOwnership\(\{ isSysAdmin, adminTeamIds \}\)/);
  assert.doesNotMatch(mcpForm, /ownershipFromRecord\(/,
    'this panel only creates — seeding from a record would be dead code implying an edit mode');
});

test('only a System Admin may re-tier an existing environment — the control says so', () => {
  const envForm = componentBody(ENV, 'EnvironmentForm');
  // Parity with what the server would refuse (canRetierEnvironment), rendered
  // as a read-only control rather than a button that 403s — the
  // `settingsSubject` convention from concept §6, implementation note 2.
  assert.match(envForm, /canReassignCredentialClient\(\{ isSysAdmin \}\)/);
  assert.match(envForm, /disabled=\{ownershipLocked\}/);
  // Gated on isEdit: a System Admin AND a Team Admin may both still CREATE,
  // and locking the control on a create would leave a Team Admin unable to name
  // their own team.
  assert.match(envForm, /const ownershipLocked = isEdit && !canReassignCredentialClient/);
});

test('both forms resolve the caller the same way, from the session and not from a prop', () => {
  for (const [label, src] of [['WorkingEnvironments.jsx', ENV], ['McpServers.jsx', MCP]]) {
    assert.match(src, /import \{ useAuth \} from '\.\.\/auth\/AuthContext'/,
      `${label}: AuthContext lives under auth/, not context/`);
    assert.match(src, /const isSysAdmin = !!user\?\.admin;/, label);
    assert.match(src, /const adminTeamIds = adminTeamIdsOf\(user\);/, label);
    // The team list comes from the admin endpoint the other three ownership
    // forms use, so all four offer the same set.
    assert.match(src, /useApi\('\/api\/admin\/teams'\)/, label);
  }
});
