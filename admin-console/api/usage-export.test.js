'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  serialize, summaryRows, workItemRows, toCsv,
  SUMMARY_COLUMNS, WORK_ITEM_COLUMNS,
} = require('./usage-export');
const { buildWorkItems } = require('./work-items');

// Reuse the two-sided golden records so the export is asserted against the
// exact canonical schema the Python emitter produces (never a hand-rolled
// shape that could drift).
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'usage-summary.fixture.json'), 'utf8'),
);
const canonical = fixture.records.map((r) => r.expected);

function parseCsv(text) {
  // Minimal RFC-4180 parser sufficient for these tests (handles quoted cells
  // with commas/quotes/newlines). Returns array of arrays.
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ── toCsv escaping ────────────────────────────────────────────────────────
test('toCsv quotes cells containing commas, quotes and newlines', () => {
  const cols = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
  const out = toCsv(cols, [{ a: 'x,y', b: 'he said "hi"' }, { a: 'line1\nline2', b: 5 }]);
  const rows = parseCsv(out);
  assert.deepEqual(rows[0], ['A', 'B']);
  assert.deepEqual(rows[1], ['x,y', 'he said "hi"']);
  assert.deepEqual(rows[2], ['line1\nline2', '5']);
});

test('toCsv of no rows is a bare header with no trailing newline', () => {
  const out = toCsv([{ key: 'a', label: 'A' }], []);
  assert.equal(out, 'A');
});

// ── summary export: one row per invocation × model ──────────────────────────
test('summaryRows fans a record into one row per model with its own class split', () => {
  const rec = canonical[0]; // two models
  const rows = summaryRows([rec]);
  const models = Object.keys(rec.modelUsage).sort();
  assert.equal(rows.length, models.length);
  assert.deepEqual(rows.map((r) => r.model), models);
  for (const r of rows) {
    const mu = rec.modelUsage[r.model];
    for (const k of ['input', 'output', 'cacheCreationInput', 'cacheReadInput']) {
      assert.equal(r[k], mu[k], `${r.model}.${k}`);
    }
    assert.equal(r.total, mu.input + mu.output + mu.cacheCreationInput + mu.cacheReadInput);
    assert.equal(r.agentId, rec.agentId);
    assert.equal(r.correlationId, rec.correlationId);
    assert.equal(r.issueNumber, rec.github.issueNumber);
  }
});

test('summaryRows emits a single empty-model row for a record without modelUsage', () => {
  const rec = { ...canonical[0], modelUsage: {}, tokens: { input: 1, output: 2, cacheCreationInput: 3, cacheReadInput: 4 } };
  const rows = summaryRows([rec]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, '');
  assert.equal(rows[0].total, 10);
});

test('summaryRows honours the half-open [since, until) window', () => {
  const all = summaryRows(canonical);
  assert.ok(all.length > 0);
  const none = summaryRows(canonical, { since: '2099-01-01T00:00:00Z' });
  assert.equal(none.length, 0);
});

test('summary export carries the four classes as separate columns and never a cost field', () => {
  const keys = new Set(SUMMARY_COLUMNS.map((c) => c.key));
  for (const k of ['input', 'output', 'cacheCreationInput', 'cacheReadInput', 'total']) assert.ok(keys.has(k));
  const csv = serialize('summary', 'csv', { records: canonical }).body.toLowerCase();
  assert.ok(!/cost|usd|dollar|price/.test(csv), 'summary CSV must not mention money');
});

// ── #2137: attribution + provider tier columns ──────────────────────────────
test('summary export carries the attribution and provider-tier columns', () => {
  const keys = SUMMARY_COLUMNS.map((c) => c.key);
  for (const k of ['attributedUserId', 'attributionKind', 'providerTier']) {
    assert.ok(keys.includes(k), `missing column ${k}`);
  }
  // Every column is a distinct key, or a CSV cell would be written twice.
  assert.equal(new Set(keys).size, keys.length);
});

test('summaryRows carries the attribution of an enriched record, blank when absent', () => {
  const enriched = {
    ts: '2026-09-01T10:00:00.000Z',
    agentId: 'solo',
    teamId: null,
    provider: 'ep-global',
    providerTier: 'global',
    attribution: { userId: 'u-ada', kind: 'requesting-user' },
    tokens: { input: 5, output: 1, cacheCreationInput: 0, cacheReadInput: 0 },
    modelUsage: {},
  };
  const [row] = summaryRows([enriched]);
  assert.equal(row.attributedUserId, 'u-ada');
  assert.equal(row.attributionKind, 'requesting-user');
  assert.equal(row.providerTier, 'global');
  // A global-provider run has no team, which is exactly why these columns
  // exist — a sheet keyed on teamId alone would drop it.
  assert.equal(row.teamId, '');

  // A pre-#2137 record (and an unattributed one) reads as blank, never as a
  // placeholder a downstream group-by could mistake for an account.
  const [legacy] = summaryRows([{ ...enriched, attribution: undefined, providerTier: undefined }]);
  assert.equal(legacy.attributedUserId, '');
  assert.equal(legacy.attributionKind, '');
  assert.equal(legacy.providerTier, '');
  const [unattr] = summaryRows([{ ...enriched, attribution: { userId: null, kind: 'unattributed' } }]);
  assert.equal(unattr.attributedUserId, '');
  assert.equal(unattr.attributionKind, 'unattributed');
});

test('a malformed attribution block cannot break the export', () => {
  for (const attribution of [null, 'u-ada', 42, []]) {
    const [row] = summaryRows([{
      ts: '2026-09-01T10:00:00.000Z', attribution,
      tokens: { input: 1, output: 0, cacheCreationInput: 0, cacheReadInput: 0 },
    }]);
    assert.equal(row.attributedUserId, '');
    assert.equal(row.attributionKind, '');
  }
});

// ── work-item export ────────────────────────────────────────────────────────
test('workItemRows: one row per work-item × model plus an unattributed remainder', () => {
  const rows = workItemRows(canonical, []);
  const wi = buildWorkItems(canonical, []);
  const un = rows.filter((r) => r.workItem === '(unattributed)');
  // The fixture's records are all tier-B (github event) attributable, so the
  // remainder row appears only if some run is unattributed.
  const expectedUnattr = wi.unattributed.runs > 0 || wi.unattributed.total > 0 ? 1 : 0;
  assert.equal(un.length, expectedUnattr);
  for (const r of rows) {
    assert.equal(r.total, r.input + r.output + r.cacheCreationInput + r.cacheReadInput);
  }
});

test('work-item export sums (all rows) reconcile to the grand total', () => {
  const rows = workItemRows(canonical, []);
  const wi = buildWorkItems(canonical, []);
  const sum = rows.reduce((s, r) => s + r.total, 0);
  assert.equal(sum, wi.totals.total, 'exported token total must equal the view grand total');
});

test('work-item rows carry the attribution-tier context columns', () => {
  const keys = new Set(WORK_ITEM_COLUMNS.map((c) => c.key));
  for (const k of ['tierCreated', 'tierEvent', 'tierBranch', 'tierFlow', 'shared', 'flowMismatch', 'attributed']) {
    assert.ok(keys.has(k), `missing tier column ${k}`);
  }
  const rows = workItemRows(canonical, []);
  const attributed = rows.filter((r) => r.attributed === 'true');
  assert.ok(attributed.length > 0);
  // Every attributed row names a real work item and repo.
  for (const r of attributed) assert.ok(r.workItem && r.repo);
});

test('work-item export never surfaces a dollar figure', () => {
  const json = serialize('work-items', 'json', { records: canonical, prEvents: [] }).body.toLowerCase();
  assert.ok(!/cost|usd|dollar|price/.test(json), 'work-item JSON must not mention money');
});

// ── serialize envelope ──────────────────────────────────────────────────────
test('serialize returns csv by default and json on request, with the right content type', () => {
  const csv = serialize('summary', 'csv', { records: canonical });
  assert.match(csv.contentType, /text\/csv/);
  assert.equal(csv.ext, 'csv');
  const json = serialize('summary', 'json', { records: canonical });
  assert.match(json.contentType, /application\/json/);
  assert.equal(json.ext, 'json');
  const parsed = JSON.parse(json.body);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, summaryRows(canonical).length);
});

test('serialize falls back to csv for an unknown format', () => {
  const out = serialize('summary', 'xml', { records: canonical });
  assert.equal(out.ext, 'csv');
});

test('empty / non-array input yields just a header (csv) or empty array (json)', () => {
  for (const input of [[], null, undefined]) {
    const csv = serialize('summary', 'csv', { records: input });
    assert.equal(parseCsv(csv.body).length, 1); // header only
    const json = serialize('summary', 'json', { records: input });
    assert.deepEqual(JSON.parse(json.body), []);
  }
});
