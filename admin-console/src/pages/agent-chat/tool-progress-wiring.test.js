import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard (#651) for the Session Log's tool-progress folding
// and CI-wait card (#2841). The pure modules (tool-progress.js, ci-wait-view.js)
// cover every decision; this pins that the JSX actually uses them.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('SessionLogPanel pairs tools via tool-progress.js and ends historical runs', () => {
  const src = read('SessionLogPanel.jsx');
  assert.match(src, /import \{ mergeToolPairs \} from '\.\/tool-progress\.js'/);
  assert.match(src, /mergeToolPairs\(mergeThinkingTokens\(scopedEvents\), \{ ended: staticOnly \}\)/);
  assert.doesNotMatch(src, /function mergeToolPairs/, 'no second local copy of the pairing');
  assert.match(src, /repoDirectory=\{repoDirectory\}/);
});

test('LogEvent threads run + repoDirectory into ToolBlock and renders orphan heartbeats', () => {
  const src = read('LogEvent.jsx');
  assert.match(src, /run=\{event\.run\}/);
  assert.match(src, /repoDirectory=\{repoDirectory\}/);
  assert.match(src, /case 'tool_progress_orphan':[\s\S]*orphanHeartbeatSummary\(event\)/);
});

test('ToolBlock renders the run cue and CI-wait card from the pure helpers', () => {
  const src = read('ToolBlock.jsx');
  assert.match(src, /toolRunView\(run, !pending\)/);
  assert.match(src, /ciWaitCard\(toolUse, toolResult, repoDirectory\)/);
  assert.match(src, /toolHeaderText\(/);
  // The PR link must not be nested inside the toggle <button>.
  const btnStart = src.indexOf('<button');
  const btnEnd = src.indexOf('</button>');
  const link = src.indexOf('href={ci.url}');
  assert.ok(btnStart > 0 && btnEnd > btnStart && link > btnEnd, 'PR link sits after the header button');
});
