'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { HEADING, pluginPromptLine, pluginCapabilitiesSection } = require('./plugin-prompt');

test('empty grant → no section (absent entirely, not an empty heading)', () => {
  assert.equal(pluginCapabilitiesSection([]), null);
  assert.equal(pluginCapabilitiesSection(null), null);
  assert.equal(pluginCapabilitiesSection(undefined), null);
});

test('an authored promptLine is used verbatim (whitespace collapsed)', () => {
  const line = pluginPromptLine({ id: 'dummy-echo', promptLine: 'Echo   with\n`aee-echo`.' });
  assert.equal(line, '- Echo with `aee-echo`.');
});

test('no promptLine falls back to a generic line naming the CLI', () => {
  assert.equal(
    pluginPromptLine({ id: 'p', name: 'Sandbox', cliName: 'aee-sbx' }),
    '- You can use the **Sandbox** plugin via `aee-sbx` — run `aee-sbx --help`.',
  );
});

test('no promptLine and no CLI still yields an honest line (fail-soft)', () => {
  assert.equal(pluginPromptLine({ id: 'p' }), '- You can use the **p** plugin.');
});

test('a malformed entry is dropped', () => {
  assert.equal(pluginPromptLine(null), null);
  assert.equal(pluginPromptLine({}), null);
});

test('section carries the heading, intro and one line per granted plugin', () => {
  const section = pluginCapabilitiesSection([
    { id: 'dummy-echo', name: 'Dummy Echo', cliName: 'aee-echo', promptLine: 'Echo through the broker with `aee-echo`.' },
    { id: 'sbx', name: 'Sandbox', cliName: 'aee-sbx' },
  ]);
  assert.match(section, new RegExp(`^## ${HEADING}\\n`));
  assert.match(section, /exit codes/); // the contract reminder in the intro
  assert.match(section, /- Echo through the broker with `aee-echo`\./);
  assert.match(section, /- You can use the \*\*Sandbox\*\* plugin via `aee-sbx`/);
  // Exactly two bullet lines.
  assert.equal((section.match(/^- /gm) || []).length, 2);
});
