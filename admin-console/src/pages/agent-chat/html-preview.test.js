// #2778 — sandboxed HTML preview in the Workspace viewer. Pure view logic plus
// #651 source guards for the JSX frame (JSX itself is not executed here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HTML_PREVIEW_MAX_BYTES,
  HTML_PREVIEW_SANDBOX,
  isHtmlFile,
  canOfferHtmlPreview,
  isHtmlTooLarge,
  htmlPreviewUrl,
  initialViewState,
  viewStateFor,
  viewStateReducer,
  bodyViewMode,
  htmlPreviewBannerText,
} from './html-preview.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

/* ─── Detection ───────────────────────────────────────────────────────── */

test('isHtmlFile: .html/.htm in any case (edge case: .HTML), nothing else', () => {
  for (const p of ['a.html', 'docs/a.htm', 'A.HTML', 'x/Y.HtM', '/context/docs/r.html']) {
    assert.equal(isHtmlFile(p), true, p);
  }
  for (const p of ['a.md', 'a.svg', 'a.pdf', 'a.html.bak', 'html', 'a.xhtml', '', null, undefined]) {
    assert.equal(isHtmlFile(p), false, String(p));
  }
});

test('canOfferHtmlPreview: non-empty, non-binary HTML only', () => {
  assert.equal(canOfferHtmlPreview('a.html', { size: 10, binary: false }), true);
  assert.equal(canOfferHtmlPreview('a.HTM', { size: 10, binary: false }), true);
  assert.equal(canOfferHtmlPreview('a.html', { size: 0, binary: false }), false, 'empty file');
  assert.equal(canOfferHtmlPreview('a.html', { size: 10, binary: true }), false, 'binary-flagged');
  assert.equal(canOfferHtmlPreview('a.md', { size: 10, binary: false }), false);
  assert.equal(canOfferHtmlPreview('a.html', null), false, 'still loading');
  // Oversize still gets the toggle — it answers with the too-large message (AC9).
  assert.equal(canOfferHtmlPreview('a.html', { size: HTML_PREVIEW_MAX_BYTES + 1, binary: false, truncated: true }), true);
});

test('size limit: ~780 KB renders, above 5 MB is too large (AC9)', () => {
  assert.equal(HTML_PREVIEW_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(isHtmlTooLarge({ size: 780 * 1024, truncated: true }), false);
  assert.equal(isHtmlTooLarge({ size: HTML_PREVIEW_MAX_BYTES }), false);
  assert.equal(isHtmlTooLarge({ size: HTML_PREVIEW_MAX_BYTES + 1 }), true);
});

test('the browser size limit mirrors the server one', () => {
  const api = read('../../../api/html-preview.js');
  assert.match(api, /const HTML_PREVIEW_MAX_BYTES = 5 \* 1024 \* 1024;/);
});

test('htmlPreviewUrl routes workspace and context keys to /html-preview, network flag only when ticked', () => {
  assert.equal(
    htmlPreviewUrl('dev-1', 'docs/a b.html', { openId: 3 }),
    '/api/agents/dev-1/workspace/html-preview?path=docs%2Fa%20b.html&v=3',
  );
  assert.equal(
    htmlPreviewUrl('dev-1', 'a.html', { external: true, openId: 1 }),
    '/api/agents/dev-1/workspace/html-preview?path=a.html&external=1&v=1',
  );
  assert.equal(
    htmlPreviewUrl('dev-1', '/context/docs/r.html', { openId: 2 }),
    '/api/agents/dev-1/context/html-preview?path=docs%2Fr.html&v=2',
  );
  assert.equal(htmlPreviewUrl(null, 'a.html'), null);
});

/* ─── Confirm-every-time state machine (AC1–AC3, AC10) ───────────────── */

const html = { type: 'toggle', html: true, tooLarge: false };

test('HTML opens raw; Rendered asks first; nothing renders before confirm (AC1–AC3)', () => {
  let s = initialViewState('a.html');
  assert.equal(s.mode, 'raw');
  s = viewStateReducer(s, html);
  assert.equal(s.mode, 'confirm');
  assert.equal(bodyViewMode(s), 'raw', 'the body keeps showing source while the dialog is open');
  const cancelled = viewStateReducer(s, { type: 'cancel' });
  assert.equal(cancelled.mode, 'raw');
  assert.equal(cancelled.openId, s.openId, 'cancel opens nothing');
});

test('confirm renders with the chosen network mode; external defaults off', () => {
  const asked = viewStateReducer(initialViewState('a.html'), html);
  const off = viewStateReducer(asked, { type: 'confirm' });
  assert.deepEqual([off.mode, off.external, off.openId], ['rendered', false, 1]);
  const on = viewStateReducer(asked, { type: 'confirm', external: true });
  assert.deepEqual([on.mode, on.external], ['rendered', true]);
});

test('the dialog shows on EVERY switch to Rendered — no choice persists (AC3)', () => {
  let s = initialViewState('a.html');
  s = viewStateReducer(s, html);
  s = viewStateReducer(s, { type: 'confirm', external: true });
  s = viewStateReducer(s, html); // back to raw
  assert.deepEqual([s.mode, s.external], ['raw', false]);
  s = viewStateReducer(s, html); // rendered again → asks again
  assert.equal(s.mode, 'confirm');
  assert.equal(s.external, false, 'the external opt-in is not remembered');
  s = viewStateReducer(s, { type: 'confirm' });
  assert.equal(s.openId, 2, 'a fresh document per opening');
});

test('switching files never carries a confirmation over, not even for one render (AC3)', () => {
  let s = viewStateReducer(viewStateReducer(initialViewState('a.html'), html), { type: 'confirm' });
  assert.equal(viewStateFor(s, 'a.html').mode, 'rendered');
  assert.equal(viewStateFor(s, 'b.html').mode, 'raw', 'before the reset effect lands');
  s = viewStateReducer(s, { type: 'reset', relPath: 'b.html' });
  assert.deepEqual([s.mode, s.relPath], ['raw', 'b.html']);
  // Re-opening the same file after a close is a fresh mount → initial state.
  assert.equal(initialViewState('a.html').mode, 'raw');
});

test('confirm/cancel outside the dialog are no-ops', () => {
  const raw = initialViewState('a.html');
  assert.equal(viewStateReducer(raw, { type: 'confirm', external: true }), raw);
  assert.equal(viewStateReducer(raw, { type: 'cancel' }), raw);
});

test('too large: the toggle shows the message instead of the dialog (AC9)', () => {
  let s = viewStateReducer(initialViewState('big.html'), { ...html, tooLarge: true });
  assert.equal(s.mode, 'too-large');
  s = viewStateReducer(s, html);
  assert.equal(s.mode, 'raw');
});

test('a frame that navigates away is closed back to raw', () => {
  let s = viewStateReducer(viewStateReducer(initialViewState('a.html'), html), { type: 'confirm' });
  s = viewStateReducer(s, { type: 'navigated' });
  assert.equal(s.mode, 'raw');
});

test('Markdown keeps its plain Rendered/Raw toggle with no dialog', () => {
  let s = initialViewState('README.md');
  assert.equal(s.mode, 'rendered');
  s = viewStateReducer(s, { type: 'toggle', html: false });
  assert.equal(s.mode, 'raw');
  s = viewStateReducer(s, { type: 'toggle', html: false });
  assert.equal(s.mode, 'rendered');
});

test('banner says untrusted and states the network mode (AC4)', () => {
  assert.match(htmlPreviewBannerText(false), /Untrusted content from an agent — do not enter passwords or credentials/);
  assert.match(htmlPreviewBannerText(false), /External resources are blocked/);
  assert.match(htmlPreviewBannerText(true), /External resources are allowed/);
});

/* ─── Frame guards (S1/S2, #651 source guards) ────────────────────────── */

const SRC = read('WorkspaceBrowser.jsx');
const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');

test('S1/S2: the preview sandbox is scripts-only and allow-same-origin is never granted', () => {
  assert.equal(HTML_PREVIEW_SANDBOX, 'allow-scripts');
  for (const file of ['WorkspaceBrowser.jsx', 'html-preview.js', 'chat-image-thumbnail.jsx']) {
    const code = read(file).replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/allow-same-origin/.test(code), `${file} must never grant allow-same-origin`);
    assert.ok(!/allow-(forms|popups|top-navigation|downloads|modals|pointer-lock)/.test(code), `${file} grants a forbidden sandbox flag`);
  }
});

test('the only <iframe> is the preview frame: sandboxed, endpoint-served, never srcDoc', () => {
  const frames = CODE.match(/<iframe[\s\S]*?\/>/g) || [];
  assert.equal(frames.length, 1, 'exactly one iframe in the viewer');
  const frame = frames[0].replace(/\s+/g, ' ');
  assert.ok(frame.includes('sandbox={HTML_PREVIEW_SANDBOX}'));
  assert.ok(frame.includes('src={src}'));
  assert.ok(frame.includes('key={openId}'), 'each opening is a fresh document');
  assert.ok(!/srcdoc|srcDoc|dangerouslySetInnerHTML/.test(frame));
  const fn = CODE.slice(CODE.indexOf('function HtmlPreviewFrame('), CODE.indexOf('function HtmlPreviewConfirm('));
  assert.ok(fn.includes('const src = htmlPreviewUrl(agentId, relPath, { external, openId });'));
  assert.ok(fn.includes('{htmlPreviewBannerText(external)}'), 'the banner is always rendered above the frame');
});

test('a second iframe load (the page navigated itself away) closes the preview', () => {
  const fn = CODE.slice(CODE.indexOf('function HtmlPreviewFrame('), CODE.indexOf('function HtmlPreviewConfirm('))
    .replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ');
  assert.ok(fn.includes('const loadsRef = useRef(0);'));
  assert.ok(fn.includes('onLoad={() => { loadsRef.current += 1; if (loadsRef.current > 1 && onNavigated) onNavigated(); }}'),
    'onLoad must count loads and call onNavigated from the second one');
});

test('the confirm hint does not claim the page cannot send anything (navigation still can)', () => {
  const fn = CODE.slice(CODE.indexOf('function HtmlPreviewConfirm('), CODE.indexOf('function useFileViewState('));
  assert.ok(!/cannot send/.test(fn));
  assert.ok(fn.includes('cannot load external fonts, scripts or images, or make network requests from script'));
});

test('the frame is only reached through a confirmed rendered state', () => {
  const body = CODE.replace(/\s+/g, ' ');
  assert.ok(body.includes("isHtml && viewMode === 'rendered' && htmlPreview && ("));
  assert.ok(body.includes("!isHtml && viewMode === 'rendered' && ("), 'HTML never falls into the Markdown renderer');
  assert.equal((body.match(/<HtmlPreviewFrame /g) || []).length, 1);
  // Both viewers feed the body the dialog-aware mode, never the raw state.
  assert.equal((body.match(/viewMode={bodyViewMode\(viewState\)}/g) || []).length, 4);
});

test('the confirm dialog matches AC2 and keeps no state between openings', () => {
  const fn = CODE.slice(CODE.indexOf('function HtmlPreviewConfirm('), CODE.indexOf('function useFileViewState('));
  assert.ok(fn.includes('const [external, setExternal] = useState(false);'), 'checkbox starts unticked');
  assert.ok(fn.includes('confirmLabel="Show preview"'));
  assert.ok(fn.includes('cancelLabel="Cancel"'));
  assert.ok(fn.includes('Also load external resources'));
  assert.ok(/generated by an agent and may contain harmful content/.test(fn));
  assert.ok(/may not display correctly, particularly with external dependencies or heavy JavaScript/.test(fn));
  assert.ok(/isolated from Agent Studio/.test(fn));
  assert.ok(!/localStorage|sessionStorage|preferences/.test(fn), 'no remembered choice');
});

test('expanding hands the frame to the fullscreen viewer instead of running two copies', () => {
  const viewer = CODE.slice(CODE.indexOf('function FileViewer('));
  assert.ok(viewer.replace(/\s+/g, ' ').includes('frameSuppressed={expanded}'));
});

test('the chat @<path> fullscreen preview owns HTML view state itself (AC12)', () => {
  const chat = read('chat-image-thumbnail.jsx');
  assert.ok(!/viewMode=/.test(chat), 'no hard-wired raw mode any more');
  const modal = CODE.slice(CODE.indexOf('export function FileViewerModal('), CODE.indexOf('function FileViewer('));
  assert.ok(modal.includes('const [ownState, ownDispatch] = useFileViewState(relPath);'));
  assert.ok(modal.includes('{!ownerDispatch && confirmOpen && <HtmlPreviewConfirm dispatch={dispatch} />}'));
});
