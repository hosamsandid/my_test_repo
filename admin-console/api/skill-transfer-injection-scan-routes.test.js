'use strict';

// #2468 — the advisory two-stage prompt-injection scan must be WIRED into
// POST /api/skills/transfer: a pattern scan (always) + an optional semantic LLM
// stage, folded into a `warnings` array on the response, with the finding
// count+category (never the flagged text) recorded on the transfer event, and a
// dry-run `preview` branch the console uses before committing.
//
// api.js boots two listeners on require and cannot be exercised directly (#651),
// so — the skill-transfer-overwrite-routes.test.js technique — its source is read
// and the transfer route + scan helper sliced out, proving the wiring exists.
// The scan's own behaviour is proven in skill-injection-scan.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}
function fn(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `function ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of function ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

const TRANSFER = "app.post('/api/skills/transfer',";

test('api.js requires the pure injection-scan module', () => {
  assert.match(API_SRC, /const skillInjectionScan = require\('\.\/skill-injection-scan'\)/);
});

test('scanSkillForTransfer helper: pattern scan always, LLM stage best-effort', () => {
  const src = fn('async function scanSkillForTransfer');
  assert.match(src, /skillInjectionScan\.scanSkillContent\(content\)/,
    'must always run the deterministic pattern scan over the content');
  assert.match(src, /resolveAssistTarget\(req, \{ requireSelection: false \}\)/,
    'must resolve the assist provider without forcing a selection (advisory, never blocks)');
  assert.match(src, /skillInjectionScan\.buildInjectionScanPrompt/,
    'must build the semantic-stage prompt from the pure module');
  assert.match(src, /skillInjectionScan\.parseInjectionScanResponse\(extractMessageText/,
    'must parse the LLM response through the pure module');
  assert.match(src, /try\s*\{[\s\S]*catch\s*\{[\s\S]*\}/,
    'the LLM stage must be wrapped so a failure/timeout degrades to pattern-only');
  assert.match(src, /skillInjectionScan\.mergeFindings\(patternFindings, llmFindings\)/,
    'must merge the two stages into one warnings array');
});

test('transfer route: dry-run preview branch returns warnings + content, writes nothing', () => {
  const src = route(TRANSFER);
  assert.match(src, /req\.body\.preview === true/,
    'must support a preview (dry-run) request');
  // The preview branch must return BEFORE the copy/stamp write core runs.
  const previewIdx = src.indexOf('preview === true');
  const writeIdx = src.indexOf('commitSkillWrite(');
  assert.ok(previewIdx > 0 && writeIdx > previewIdx,
    'the preview branch must precede (and return before) the write core');
  assert.match(src, /scanSkillForTransfer\(req, sourceContent, plan\.name\)/,
    'preview must scan the resolved source content');
  assert.match(src, /preview: true,[\s\S]*warnings,[\s\S]*content:/,
    'preview response must carry warnings + the target content');
});

test('transfer route: commit scans, returns warnings, logs count+category only', () => {
  const src = route(TRANSFER);
  assert.match(src, /const warnings = await scanSkillForTransfer\(req, sourceContent, destName\)/,
    'the committed transfer must scan the content actually written');
  assert.match(src, /skillInjectionScan\.summarizeFindings\(warnings\)/,
    'must summarise for the audit log via the pure module');
  assert.match(src, /scanWarningCount: scanSummary\.count/,
    'the transfer event must record the finding COUNT');
  assert.match(src, /scanWarningCategories: scanSummary\.categories/,
    'the transfer event must record the finding CATEGORIES');
  // The log must NOT persist the flagged text / evidence.
  const logStart = src.indexOf("type: 'skill-transfer'");
  const logEnd = src.indexOf("') + '\\n'", logStart);
  const logBlock = src.slice(logStart, logEnd > logStart ? logEnd : undefined);
  assert.ok(!/evidence/.test(logBlock), 'the audit log must never persist flagged evidence text');
  // The 201 success response must carry the warnings array.
  const respStart = src.indexOf('res.status(201).json({');
  assert.ok(respStart > 0, 'could not find the 201 response');
  const respBlock = src.slice(respStart);
  assert.match(respBlock, /\bwarnings,/, 'the 201 response must include the warnings array');
});

test('transfer route: reads the ACTUAL resolved source content (no stale cache)', () => {
  const src = route(TRANSFER);
  assert.match(src, /sourceContent = fs\.readFileSync\(path\.join\(src\.dir, 'SKILL\.md'\)/,
    'must read SKILL.md from the resolved source dir so a same-session edit is scanned');
});
