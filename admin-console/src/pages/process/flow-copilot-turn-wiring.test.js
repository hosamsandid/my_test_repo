import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2087 source-reading drift guard ────────────────────────────────────────
//
// A running Flow Copilot turn survives navigation, a panel close and a flow
// switch because ownership moved OUT of FlowCopilotPanel into the app-level
// FlowCopilotProvider. Almost nothing about that wiring throws when it rots:
//
//   • the provider mounted BELOW the router again → turns die on navigation,
//     silently, exactly as before the ticket,
//   • the panel growing its own `fetch`/`busy` state back → a second, panel-
//     scoped turn that no indicator knows about and no Stop can reach,
//   • the panel forgetting to register its scope → the indicator shows on the
//     very surface that already displays the live phase (AC13's defect),
//   • the route dropping `signal` from runCopilot/httpPostJson → a Stop again
//     ends only the DELIVERY, leaving up to 3 × 180 s of LLM work billed and
//     discarded, which nothing user-visible reveals,
//   • the indicator losing its Shell mount → no every-route surface at all.
//
// These are JSX / Express files the pure tests cannot import, so they are read
// as source — the #651 convention.

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(here, rel), 'utf8');
// Comments are stripped before asserting an absence, so a comment naming what
// moved is never a false positive.
const code = (rel) => src(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const PANEL = './FlowCopilotPanel.jsx';
const CANVAS = '../ProcessCanvas.jsx';
const INDEX = '../../index.jsx';
const SHELL = '../../components/Shell.jsx';
const PROVIDER = '../../context/FlowCopilotContext.jsx';
const INDICATOR = '../../components/FlowCopilotIndicator.jsx';
const ROUTE = '../../../api/api.js';
const LOOP = '../../../api/flow-copilot.js';

// ── the provider sits above the router ───────────────────────────────────────

test('FlowCopilotProvider is mounted in index.jsx, above the router', () => {
  const s = code(INDEX);
  assert.match(s, /import \{ FlowCopilotProvider \} from '\.\/context\/FlowCopilotContext\.jsx'/);
  assert.match(s, /<FlowCopilotProvider>/, 'the provider must actually be rendered');
  // Everything in index.jsx is inside <BrowserRouter> and therefore survives
  // client-side navigation; what must NOT happen is the provider drifting into
  // App.jsx or Shell.jsx, both of which are remounted/unmounted per route.
  for (const file of [SHELL, CANVAS]) {
    assert.ok(
      !code(file).includes('<FlowCopilotProvider'),
      `${file} must not host the provider — it would not survive navigation`,
    );
  }
});

test('the provider is nested inside AuthProvider like its two precedents', () => {
  const s = code(INDEX);
  const auth = s.indexOf('<AuthProvider>');
  const copilot = s.indexOf('<FlowCopilotProvider>');
  // Both must be PRESENT, or a renamed/removed tag would make the ordering
  // comparison pass on a -1 and the assertion would be vacuous.
  assert.ok(auth >= 0, '<AuthProvider> must still wrap the tree');
  assert.ok(copilot >= 0, '<FlowCopilotProvider> must still be rendered');
  assert.ok(
    auth < copilot,
    'a turn is an authenticated request — the provider belongs inside AuthProvider',
  );
});

// ── the panel no longer owns the turn ────────────────────────────────────────

test('the panel drives the provider instead of fetching the turn itself', () => {
  const s = code(PANEL);
  // The CALL, not merely the import — an import left behind a dropped call
  // would make this assertion vacuous.
  assert.match(s, /useFlowCopilot\(\)/, 'the panel reads the app-level turn owner');
  assert.match(s, /copilot\.viewFor\(scope\)/, 'and reads it scoped to its own flow');
  assert.match(s, /copilot\.startTurn\(/, 'sending starts a provider-owned turn');
  assert.match(s, /copilot\.stopTurn\(\)/, 'the panel offers the Stop (AC8)');
  // By TURN ID, not by scope: an apply can re-key the draft mid-write (the
  // first generation proposes a name), which files the proposal under a new
  // scope while the apply is still in flight.
  assert.match(s, /copilot\.resolvePending\(pending\.id\)/, 'Apply/Discard resolve the proposal by id');
  assert.ok(
    !s.includes('resolvePending(scope)'),
    'resolving by scope would miss a proposal re-keyed by a mid-apply rename',
  );
});

test('the panel keeps no turn-owning state of its own', () => {
  const s = code(PANEL);
  assert.ok(
    !/fetch\(\s*['"]\/api\/process\/copilot/.test(s),
    'the copilot fetch belongs to the provider — a panel-scoped one dies on unmount',
  );
  assert.ok(!s.includes('consumeCopilotStream'), 'the stream reader moved to the provider');
  assert.ok(!s.includes('setBusy('), 'busy is derived from the provider, not local state');
  assert.ok(!s.includes('setPhase('), 'phase is fed by the provider, not local state');
});

test('the panel registers the scope it is showing, so AC13 can hide the indicator', () => {
  const s = code(PANEL);
  assert.match(s, /registerPanel\(scope\)/);
  // The scope must come in as a prop — deriving it inside the panel would let
  // the panel and the canvas disagree about which flow a proposal belongs to.
  assert.match(s, /mode, scope, bundle/, 'scope is a prop of FlowCopilotPanel');
});

test('the canvas passes its scope to the panel', () => {
  assert.match(code(CANVAS), /<FlowCopilotPanel[\s\S]{0,400}scope=\{scope\}/);
});

test('a draft renamed mid-turn re-keys the binding before the navigate', () => {
  const s = code(CANVAS);
  const rekey = s.indexOf('rekeyScope(');
  const nav = s.indexOf('navigate(`draft:${saved.id}`');
  assert.ok(rekey > 0, 'ProcessCanvas must follow the rename (edge case)');
  assert.ok(nav > 0);
  assert.ok(rekey < nav, 're-key first — the navigate remounts this subtree');
});

// ── the panel still publishes no help subject ────────────────────────────────

test('the Copilot rail still deliberately publishes NO help subject', () => {
  // #1984's rule, re-asserted here because #2087 rewrote this file: the rail is
  // a flex child of the canvas, not an overlay. The new Stop control and the
  // indicator carry no "?" of their own, so the rule is unchanged.
  assert.ok(!code(PANEL).includes('useHelpSubject'));
  assert.ok(!code(INDICATOR).includes('useHelpSubject'));
});

// ── the every-route indicator ────────────────────────────────────────────────

test('the indicator is mounted once in Shell, beside the transcription overlay', () => {
  const s = code(SHELL);
  assert.match(s, /import FlowCopilotIndicator from '\.\/FlowCopilotIndicator'/);
  assert.match(s, /<FlowCopilotIndicator \/>/);
});

test('the indicator takes every visibility decision from the pure module', () => {
  const s = code(INDICATOR);
  // pendingByScope is threaded in so a proposal that finished while the user was
  // away keeps the indicator alive as a "ready to review" card (#2087 follow-up)
  // — without it the card would vanish on completion and the proposal read as lost.
  assert.match(s, /indicatorState\(\{ turn: ctx\.turn, panelScope: ctx\.panelScope, pendingByScope: ctx\.pendingByScope \}\)/);
  assert.match(s, /indicatorPhaseLabel\(/);
  assert.match(s, /state\.visible/, 'visibility is the pure decision, not a local condition');
  assert.match(s, /state\.mode === 'ready'/, 'the ready hand-off is a mode of the pure state, not a local flag');
  assert.match(s, /createPortal\(/, 'portaled to body so it floats above every page');
});

test('the indicator offers both a jump and a Stop (AC12)', () => {
  const s = code(INDICATOR);
  assert.match(s, /state\.jumpTo/);
  assert.match(s, /ctx\.stopTurn/);
  assert.match(s, /disabled=\{ctx\.stopping\}/, 'a double press must not fire two aborts');
});

// ── the beforeunload guard (AC14) ────────────────────────────────────────────

test('the provider guards a hard reload / tab close while a turn runs', () => {
  const s = code(PROVIDER);
  assert.match(s, /addEventListener\('beforeunload'/);
  assert.match(s, /removeEventListener\('beforeunload'/, 'the guard is removed when idle');
  assert.match(s, /if \(!running\) return undefined;/, 'armed only while a turn runs');
});

test('the provider keeps the assist-model header on the stream (AC16)', () => {
  // Asserted ON the fetch, not merely as an import: the copilot stream is one
  // of the few call sites that sets X-Assist-Model explicitly rather than
  // through apiCall(), so the header had to move with the fetch.
  assert.match(
    code(PROVIDER),
    /headers: \{ 'Content-Type': 'application\/json', \.\.\.assistHeaders\(\) \}/,
  );
});

test('the provider refuses a second concurrent turn (AC4)', () => {
  assert.match(code(PROVIDER), /if \(turnRef\.current\) return;/);
});

test('the finished-turn proposal captures flowName before clearTurn nulls the ref', () => {
  // Regression: the `setPendingByScope` updater runs LATER (React processes it
  // during the next render), but `clearTurn(id)` on the following line sets
  // `turnRef.current = null` synchronously. Reading `turnRef.current.flowName`
  // from inside the updater therefore dereferenced null on completion — the
  // "Cannot read properties of null (reading 'flowName')" crash. The value must
  // be captured into a local while the ref is still live, before scheduling.
  const s = code(PROVIDER);
  const start = s.indexOf('setPendingByScope((m) => putPending(m, {');
  const end = s.indexOf('clearTurn(id);', start);
  assert.ok(start !== -1 && end !== -1, 'putPending/clearTurn wiring not found — re-point this guard');
  const updater = s.slice(start, end);
  assert.doesNotMatch(
    updater,
    /turnRef\.current\.flowName/,
    'the pending updater must not dereference turnRef.current after clearTurn nulls it',
  );
});

// ── the server-side cancellation path (AC9, AC14) ────────────────────────────

test('the copilot route aborts the work, not just its delivery', () => {
  const s = code(ROUTE);
  assert.match(s, /const turnAbort = new AbortController\(\);/);
  assert.match(s, /turnAbort\.abort\(\);/, 'res.on(close) must abort the turn');
  assert.match(s, /signal: turnAbort\.signal/, 'runCopilot receives the signal');
  // The upstream LLM call is streamed (httpPostStreamText, stream:true) so a
  // large flow does not sit as one long non-streaming request; the turn signal
  // is threaded into its opts so the in-flight streamed request is destroyed on
  // Stop, not merely ignored.
  assert.match(
    s,
    /httpPostStreamText\(url, headers, \{ model: target\.model, \.\.\.payload \}, \{[\s\S]*?signal: turnAbort\.signal/,
    'the streamed LLM call in flight is destroyed, not merely ignored',
  );
  assert.match(s, /isCopilotAborted\(err\)/, 'a deliberate Stop stays out of the error path');
});

test('httpPostJson takes an optional signal and leaves existing callers alone', () => {
  const s = code(ROUTE);
  assert.match(s, /function httpPostJson\(targetUrl, headers = \{\}, bodyObj = \{\}, timeoutMs = 30000, signal = null\)/);
  assert.match(s, /if \(signal\) signal\.addEventListener\('abort', onAbort, \{ once: true \}\);/);
  assert.match(s, /if \(signal\) signal\.removeEventListener\('abort', onAbort\);/,
    'a long-lived signal must not accumulate a listener per call');
});

test('runCopilot checks the signal at the top of every iteration (AC9)', () => {
  const s = code(LOOP);
  const matches = s.match(/if \(signal && signal\.aborted\) throw abortedError\(\);/g) || [];
  assert.ok(
    matches.length >= 3,
    'the loop must check before each request, after a rejection, and after a reply — '
    + `found ${matches.length}`,
  );
});

// ── #2131: the failure card reads as guidance, not as a transport dump ───────

test('the error card renders the guidance hints and demotes the raw detail', () => {
  const s = code(PANEL);
  const row = s.slice(s.indexOf('function ErrorRow'), s.indexOf('function BundleSizeHint'));
  assert.ok(row.length > 0, 'ErrorRow not found — this guard needs re-pointing');
  // The headline is the classifier's own message, so the plain-language copy
  // lives in one place (flow-copilot-view.js) rather than being re-worded here.
  assert.match(row, /\{entry\.message\}/);
  assert.match(row, /entry\.hints/, 'the actionable hints must actually render');
  assert.match(row, /hints\.map/);
  // The raw transport string is available but subordinate: inside a <details>,
  // never as the card's own headline.
  assert.match(row, /entry\.detail/);
  assert.match(row, /<details/);
  // The old hardcoded timeout sentence is gone — it lived here as a second,
  // drifting copy of guidance that now belongs to the pure module.
  assert.doesNotMatch(row, /The LLM call timed out/);
});

test('the route emits the stable failure code the card classifies on', () => {
  const s = code(ROUTE);
  assert.match(s, /const failure = classifyTurnFailure\(err\);/);
  assert.match(s, /code: failure\.code/);
});

test('the client classifies on the server code, not only on the message', () => {
  const s = code('./flow-copilot-view.js');
  assert.match(s, /export function copilotErrorInfo\(status, message, code\)/);
  assert.match(s, /TIMEOUT_CODES\.has\(code\)/);
  // ...and the provider actually forwards it off the thrown error.
  assert.match(code(PROVIDER), /copilotErrorInfo\(e\.status, e\.message, e\.copilotCode\)/);
});

test('the split generation is a fallback, never a guess about size', () => {
  const s = code(LOOP);
  // It runs only after a timeout-class failure of the first call, which is what
  // keeps small and medium flows on a byte-identical path (AC4).
  assert.match(s, /attempt === 0 && !best && !generatedInParts/);
  assert.match(s, /canGenerateInParts\(baseBundle\) && isTimeoutFailure\(err\)/);
  // No prompt-length / role-count heuristic decides it.
  assert.doesNotMatch(s, /messages[\s\S]{0,40}\.length\s*>\s*\d{3}/);
});
