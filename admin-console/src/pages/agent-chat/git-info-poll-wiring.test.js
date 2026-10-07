// Source guard (#651 style — the JSX itself is not executed under node:test)
// for #2923: ChatPanel must not request git-info on the critical path of
// opening a chat. The arming decision lives in the pure, unit-tested
// git-info-poll.js; this pins that ChatPanel routes the poll through it and
// that the history backfill is what arms it.
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

test('#2923: the git-info poll waits for gitInfoPollArmed', () => {
  const poll = block(panel, '1b. Git info polling', '2. Backfill on roomId change');
  assert.match(poll, /gitInfoPollArmed\(\{/);
  assert.match(poll, /if \(!agent\?\.id \|\| !gitInfoArmed\) return;/);
  assert.match(poll, /\}, \[agent\?\.id, gitInfoArmed\]\);/);
  assert.match(poll, /setInterval\(loadGitInfo, GIT_INFO_POLL_MS\)/);
});

test('#2923: git-info is requested nowhere else in ChatPanel', () => {
  assert.equal(panel.split('/git-info`').length - 1, 1);
});

test('#2923: the settled history backfill arms the poll for its room', () => {
  const backfill = block(panel, '2. Backfill on roomId change', '2b. Scroll-up backfill');
  assert.match(backfill, /\.finally\(\(\) => \{\s*if \(cancelled\) return;\s*setLoading\(false\);\s*setHistoryLoadedFor\(roomId\);/);
});
