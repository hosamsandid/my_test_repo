import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source-reading drift guard over the JSX that `node --test` cannot load
 * (the #651 convention, same shape as `agent-settings-wiring.test.js`).
 *
 * `ErrorBoundary.test.js` proves the boundary BEHAVES; this file proves it is
 * actually MOUNTED in the three places #1974 requires. Without it the class
 * could keep passing its own tests while a refactor quietly dropped it from
 * App.jsx and the white screen came back.
 */

function read(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/**
 * Strip comments before asserting a symbol is absent — the explanatory
 * comments name the very things being checked and would false-positive.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const APP = read('../App.jsx');
const CHAT_PANEL = read('../pages/agent-chat/ChatPanel.jsx');
const SESSION_LOG = read('../pages/agent-chat/SessionLogPanel.jsx');
const MESSAGE = read('../pages/agent-chat/Message.jsx');
const SKILL_MD = read('./SkillMarkdown.jsx');

/* ─── AC2 / AC3: the app-level boundary in App.jsx ─────────────────── */

test('App.jsx imports and mounts the RouteErrorBoundary (AC2)', () => {
  const src = stripComments(APP);
  assert.match(src, /import \{ RouteErrorBoundary \} from '\.\/components\/ErrorBoundary\.js'/);
  assert.match(src, /<RouteErrorBoundary>/);
  assert.match(src, /<\/RouteErrorBoundary>/);
});

test('the boundary sits INSIDE Shell and AROUND Suspense/Routes (AC2)', () => {
  const src = stripComments(APP);
  const shellOpen = src.indexOf('<Shell>');
  const boundaryOpen = src.indexOf('<RouteErrorBoundary>');
  const suspenseOpen = src.indexOf('<Suspense');
  const routesOpen = src.indexOf('<Routes>');
  const suspenseClose = src.indexOf('</Suspense>');
  const boundaryClose = src.indexOf('</RouteErrorBoundary>');
  const shellClose = src.indexOf('</Shell>');

  for (const [name, idx] of Object.entries({
    shellOpen, boundaryOpen, suspenseOpen, routesOpen, suspenseClose, boundaryClose, shellClose,
  })) {
    assert.ok(idx > -1, `${name} not found in App.jsx`);
  }
  // Shell OUTSIDE the boundary is the whole point: the nav must survive a page
  // crash. If the boundary ever wrapped Shell instead, a page throw would blank
  // the navigation too.
  assert.ok(shellOpen < boundaryOpen, 'Shell must open before the boundary');
  assert.ok(boundaryClose < shellClose, 'the boundary must close before Shell');
  // And the routed page area must be INSIDE it.
  assert.ok(boundaryOpen < suspenseOpen, 'Suspense must be inside the boundary');
  assert.ok(routesOpen < suspenseClose, 'Routes stays inside Suspense');
  assert.ok(suspenseClose < boundaryClose, 'the boundary must close after Suspense');
});

test('RouteErrorBoundary keys its reset on the route pathname (AC3)', () => {
  const src = stripComments(read('./ErrorBoundary.js'));
  // The reset must be driven by the location, and by a resetKey rather than a
  // `key` — a key would remount the page subtree on every navigation and throw
  // away Agent Chat's state on each /chats/:agentId change.
  assert.match(src, /useLocation\(\)/);
  assert.match(src, /resetKey: location\.pathname/);
  assert.doesNotMatch(src, /key: location\.pathname/);
});

/* ─── AC4: the per-event boundary in both chat streams ─────────────── */

test('ChatPanel wraps every transcript row in an EventErrorBoundary (AC4)', () => {
  const src = stripComments(CHAT_PANEL);
  assert.match(src, /import \{ EventErrorBoundary \} from '\.\.\/\.\.\/components\/ErrorBoundary\.js'/);
  assert.match(src, /<EventErrorBoundary[^>]*>\s*\{renderTranscriptRow\(msg, i\)\}/);
});

test('the transcript row renderer is extracted, so no branch can return an unguarded row (AC4)', () => {
  const src = stripComments(CHAT_PANEL);
  // The row branches must live in ONE named function that the boundary wraps —
  // if they moved back inline into renderItem, a later-added message type would
  // silently escape containment.
  assert.match(src, /const renderTranscriptRow = \(msg, i\) => \{/);
  const renderItem = src.slice(src.indexOf('renderItem={(msg, i)'), src.indexOf('renderItem={(msg, i)') + 300);
  assert.ok(
    renderItem.includes('EventErrorBoundary'),
    'renderItem must return a boundary-wrapped row',
  );
  assert.ok(
    !renderItem.includes("msg.type === 'context-reset'"),
    'the row branches must not be inline in renderItem again',
  );
});

test('SessionLogPanel wraps every log row in an EventErrorBoundary (AC4)', () => {
  const src = stripComments(SESSION_LOG);
  assert.match(src, /import \{ EventErrorBoundary \} from '\.\.\/\.\.\/components\/ErrorBoundary\.js'/);
  assert.match(src, /<EventErrorBoundary[^>]*>/);
  // The boundary must be OUTSIDE the hover/accent wrapper, so that wrapper
  // cannot itself throw past it.
  const boundaryAt = src.indexOf('<EventErrorBoundary');
  const logEventAt = src.indexOf('<LogEvent event={ev}');
  assert.ok(boundaryAt > -1 && logEventAt > boundaryAt, 'LogEvent renders inside the boundary');
});

test('both streams pass identifying context so a report is traceable (AC5)', () => {
  assert.match(stripComments(CHAT_PANEL), /<EventErrorBoundary agentId=\{agent\.id\} eventId=\{msg\.event_id\}>/);
  assert.match(stripComments(SESSION_LOG), /<EventErrorBoundary agentId=\{agentId\} sessionId=\{roomId\} eventId=\{ev\._key\}>/);
});

/* ─── AC7: the innermost markdown layer degrades, never crashes ─────── */

// The markdown wrappers must degrade to a RENDER (GFM-only, then plain text),
// not an error card — and the innermost fallback must be the infallible
// `plainTextFallback`, so a body that throws in BOTH pipeline tiers can never
// loop the boundary into React #185 (the whole reason the page kept crashing).
// The primitive's own behaviour is covered by `markdown-safe.test.js`; this is
// the #651 drift guard that the two surfaces actually WIRE it.

test('SafeMarkdown nests the safe boundaries down to a plain-text floor (AC7)', () => {
  const src = stripComments(MESSAGE);
  assert.match(src, /import \{ MarkdownSafeBoundary, plainTextFallback \} from '\.\.\/\.\.\/components\/markdown-safe\.js'/);
  assert.match(src, /export function SafeMarkdown/);
  assert.match(src, /<MarkdownSafeBoundary/);
  // GFM-only stays the middle tier, and plain text is the guaranteed floor.
  assert.match(src, /<MarkdownGfmOnly body=\{body\} \/>/);
  assert.match(src, /plainTextFallback\(body\)/);
  // The old sticky-fallback boundary (which could re-render its own throwing
  // fallback forever) must be gone.
  assert.doesNotMatch(src, /class SafeMarkdown extends React\.Component/);
});

test('SkillMarkdown wires the same safe boundary + plain-text floor (AC7)', () => {
  const src = stripComments(SKILL_MD);
  assert.match(src, /import \{ MarkdownSafeBoundary, plainTextFallback \} from '\.\/markdown-safe\.js'/);
  assert.match(src, /<MarkdownSafeBoundary/);
  assert.match(src, /plainTextFallback\(/);
  assert.doesNotMatch(src, /class SkillMarkdown extends React\.Component/);
});

/* ─── AC5: the client posts to the endpoint the server registers ───── */

test('the client endpoint constant matches the route registered in api.js', () => {
  const view = read('./error-boundary-view.js');
  const api = read('../../api/api.js');
  const match = view.match(/CLIENT_ERROR_ENDPOINT = '([^']+)'/);
  assert.ok(match, 'CLIENT_ERROR_ENDPOINT is defined');
  const endpoint = match[1];
  assert.ok(
    api.includes(`app.post('${endpoint}'`),
    `api.js must register ${endpoint} — otherwise every report 404s silently`,
  );
});

test('the boundary posts with a bare fetch, not the shared apiCall', () => {
  const src = stripComments(read('./ErrorBoundary.js'));
  // apiCall dispatches UNAUTHORIZED_EVENT on a 401, which would bounce the user
  // to the login screen because a chat row failed to render.
  assert.doesNotMatch(src, /apiCall/);
  assert.match(src, /fetch\(CLIENT_ERROR_ENDPOINT/);
  assert.match(src, /keepalive: true/);
});
