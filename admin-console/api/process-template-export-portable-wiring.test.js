'use strict';

// Route wiring for the team export (#2813 AC8/AC11/AC12): GET
// /api/process/template must hand each member's portable settings to
// buildProcessTemplate, which only serializes what it is given. api.js cannot
// be `require`d in a unit test, so — like env-prompt-rebuild-wiring.test.js —
// this reads the route source; the serialization itself is covered by
// process-template-portable-settings.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function routeSource(signature) {
  const start = API_SRC.indexOf(signature);
  assert.ok(start >= 0, `route not found: ${signature}`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  return API_SRC.slice(start, end);
}

test('GET /api/process/template hands the github flags, prompt mode, model and memory to the exported role', () => {
  const src = routeSource("app.get('/api/process/template'");
  const role = src.slice(src.indexOf('roleEntries.push({'), src.indexOf('graphAgents.push({'));
  assert.match(role, /cfg\.github && typeof cfg\.github === 'object' \? \{ github: cfg\.github \} : \{\}/, 'AC11');
  assert.match(role, /\n\s*promptMode,\n/, 'AC12');
  assert.match(role, /\{ model: cfg\.modelOverride \}/, 'AC8');
  assert.match(role, /\{ memoryLimit: cfg\.memoryLimit \}/, 'AC2');
  assert.match(src, /buildProcessTemplate\(/);
});
