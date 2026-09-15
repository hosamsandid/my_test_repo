// admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the plugin-event plugin picker.
 *
 * The option rules live in `plugin-event-options.js` (unit-tested). What that
 * test cannot see is whether `TriggerForm` still *calls* them: TriggersPanel.jsx
 * is JSX, which `node --test` never loads (#651), so a revert to a free-text
 * `FormInput` for `pluginId` would leave every pure test green while the form
 * silently went back to accepting typos. Same spirit as
 * `rail-lifecycle-wiring.test.js`: wiring, never copy.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

// Comments are stripped first so a comment *naming* a symbol can't stand in
// for the call that should be there.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const triggers = code(read('TriggersPanel.jsx'));

test('TriggerForm imports the pure picker module and the shared grant resolver', () => {
  assert.match(triggers, /import \{ pluginEventOptions, defaultPluginId \} from '\.\/plugin-event-options\.js'/);
  assert.match(triggers, /import \{ effectiveGrantFor \} from '\.\.\/plugin-grant-view\.js'/);
});

test('the option list is derived by the pure module from the fetched registry + grant', () => {
  assert.match(triggers, /pluginEventOptions\(\{ \.\.\.pluginInputs, currentId: form\.pluginId, draft: isDraftMode \}\)/);
  assert.match(triggers, /apiCall\('GET', '\/api\/plugins'\)/);
  assert.match(triggers, /effectiveGrantFor\(agent, parentTeam\)/);
});

test('pluginId is a <select> bound to the form, not a free-text FormInput', () => {
  // The select: value + onChange on the same control.
  assert.match(triggers, /<select\s+value=\{form\.pluginId\}\s+onChange=\{e => set\('pluginId', e\.target\.value\)\}/);
  // The old field must be gone — a `label="Plugin id"` FormInput was the free-text door.
  assert.doesNotMatch(triggers, /label="Plugin id"/);
  // And the options must render the module's `disabled` flag, or an ungranted
  // plugin would be selectable again.
  assert.match(triggers, /disabled=\{o\.disabled\}/);
});

test('the single-choice auto-pick is wired', () => {
  assert.match(triggers, /defaultPluginId\(pluginPick\.options\)/);
});

test('eventFilter stays free text (the manifest declares no event names)', () => {
  assert.match(triggers, /label="Event filter \(optional\)"/);
});

test('the payload filter is authored through the pure plugin-event-filter module', () => {
  assert.match(triggers, /import \{ parsePayloadFilter, formatPayloadFilter, payloadFilterSummary \} from '\.\/plugin-event-filter\.js'/);
  // Initial value comes from the stored object, the wire value from the parser…
  assert.match(triggers, /payloadFilter:\s*formatPayloadFilter\(initialValues\?\.payloadFilter\)/);
  assert.match(triggers, /body\.payloadFilter = parsedPayloadFilter\.value/);
  // …and a parse error blocks the save with its own message, before the prompt check.
  const err = triggers.indexOf("setFormError(parsedPayloadFilter.error)");
  const prompt = triggers.indexOf("setFormError('Prompt is required.')");
  assert.ok(err !== -1 && prompt !== -1 && err < prompt, 'payload-filter validation must precede the prompt check');
  // The field itself, and the row summary.
  assert.match(triggers, /label="Payload filter \(optional\)"/);
  assert.match(triggers, /payloadFilterSummary\(trigger\.payloadFilter\)/);
});
