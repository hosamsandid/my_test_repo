// Source guard (#651 style — the JSX itself is not executed under node:test)
// for #2683: ChatPanel must update the composer's loop banner from the live
// timeline, not only from its 15-s trigger poll. The decisions live in the
// pure, unit-tested loop-run-view.js (liveLoopSignal / runningLaunchedLoop);
// this pins that ChatPanel actually routes live events into them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(HERE, 'ChatPanel.jsx'), 'utf8');

function block(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `marker not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, `end marker not found after: ${start}`);
  return src.slice(i, j);
}

test('#2683: the live SSE handler hands loop signals to the loop handler', () => {
  const handler = block(panel, 'const handleEvent = useCallback(', 'const sseUrl');
  assert.match(handler, /const loopSignal = liveLoopSignal\(ev\.content\);/);
  assert.match(handler, /if \(loopSignal\) onLoopSignalRef\.current\?\.\(loopSignal\);/);
});

test('#2683: a finished signal clears the matching banner at once and re-reads the triggers', () => {
  const handler = block(panel, 'onLoopSignalRef.current = (signal) => {', '\n  };');
  assert.match(handler, /signal\.kind === 'finished' && signal\.triggerId/);
  assert.match(handler, /finishedLoopIdsRef\.current\.add\(signal\.triggerId\)/);
  assert.match(handler, /activeLoop\?\.id === signal\.triggerId\) \{ setActiveLoop\(null\); setLoopProgress\(null\); \}/);
  assert.match(handler, /refreshActiveLoop\(\);/);
});

test('#2683: the trigger poll skips loops the live timeline already reported finished', () => {
  const refresh = block(panel, 'const refreshActiveLoop = useCallback(', '}, [agent?.id, roomId]);');
  assert.match(refresh, /runningLaunchedLoop\(list, finishedLoopIdsRef\.current\)/);
  assert.doesNotMatch(refresh, /list\.find\(isLaunchedLoop\)/);
});
