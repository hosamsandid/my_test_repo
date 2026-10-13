'use strict';

// Flat CSV/JSON export of token-usage records (#656 phase 3, item 1 —
// "deliberately later" in §5 / phase 3 of docs/cost-per-pr-concept.md).
//
// This is a pure, read-side add-on over the SAME records the Statistics and
// Work-items views already read (usage-summary.js / work-items.js); nothing in
// storage changes. It exists so FinOps / the customer can pull the raw usage
// out flat and apply their own contract prices downstream — the "cost
// derivation happens outside our stack" contract.
//
// Honest-numbers rules carried through (concept §2):
//   * All four token classes are separate columns, never collapsed.
//   * Tokens only — the opaque totalCostUsd that may ride on a record is NEVER
//     read or emitted here (no dollar figures anywhere in an export).
//   * The work-item export always emits the unattributed remainder as its own
//     row, and every work-item row carries the attribution-tier context, so a
//     downstream sum reconciles to the grand total instead of silently
//     dropping the unassigned tokens.

const { buildWorkItems, TOKEN_CLASSES } = require('./work-items');
const { summarize, modelSplit, GROUP_BY } = require('./usage-summary');

const FORMATS = new Set(['csv', 'json']);

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// since inclusive, until exclusive — identical semantics to the two view
// modules so an export and its on-screen view agree on which records are in.
function inRange(ts, since, until) {
  if (typeof ts !== 'string' || !ts) return false;
  if (since && ts < since) return false;
  if (until && ts >= until) return false;
  return true;
}

function classTotal(tokens) {
  return TOKEN_CLASSES.reduce((s, k) => s + num(tokens && tokens[k]), 0);
}

// Pull exactly the four canonical classes (+ derived total) out of any tokens
// object, dropping anything else (e.g. a stray cost field).
function tokenCols(tokens) {
  const out = {};
  for (const k of TOKEN_CLASSES) out[k] = num(tokens && tokens[k]);
  out.total = classTotal(tokens);
  return out;
}

// ── CSV serialization (RFC-4180-ish) ─────────────────────────────────────────
function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
  return [header, ...lines].join('\n') + (rows.length ? '\n' : '');
}

// ── Statistics export: one row per invocation × model ────────────────────────
// The finest honest grain of view 1. A record with per-model usage fans into
// one row per model, each carrying its share of the record's tokens (modelSplit,
// #2972 — the rows of one record add up to exactly its tokens); a record
// with no modelUsage contributes a single row with an empty model, carrying
// its turn-wide tokens — so no invocation is dropped and totals reconcile.
const SUMMARY_COLUMNS = [
  { key: 'ts', label: 'ts' },
  { key: 'agentId', label: 'agentId' },
  { key: 'teamId', label: 'teamId' },
  { key: 'roleId', label: 'roleId' },
  // #2137: who the spend is charged to, and which provider tier paid for it.
  // Both are needed downstream precisely because `teamId` stops being the
  // accounting anchor for a global provider — a FinOps sheet keyed on team
  // alone silently drops every global-provider run into a blank bucket.
  { key: 'attributedUserId', label: 'attributedUserId' },
  { key: 'attributionKind', label: 'attributionKind' },
  { key: 'provider', label: 'provider' },
  { key: 'providerTier', label: 'providerTier' },
  { key: 'correlationId', label: 'correlationId' },
  { key: 'sessionId', label: 'sessionId' },
  { key: 'repo', label: 'repo' },
  { key: 'prNumber', label: 'prNumber' },
  { key: 'issueNumber', label: 'issueNumber' },
  { key: 'branch', label: 'branch' },
  { key: 'model', label: 'model' },
  { key: 'input', label: 'input' },
  { key: 'output', label: 'output' },
  { key: 'cacheCreationInput', label: 'cacheCreationInput' },
  { key: 'cacheReadInput', label: 'cacheReadInput' },
  { key: 'total', label: 'total' },
  { key: 'durationMs', label: 'durationMs' },
];

function summaryRows(records, { since = null, until = null } = {}) {
  const rows = [];
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || !inRange(rec.ts, since, until)) continue;
    const g = rec.github || {};
    const git = rec.git || {};
    const attr = (rec.attribution && typeof rec.attribution === 'object') ? rec.attribution : {};
    const base = {
      ts: rec.ts || '',
      agentId: rec.agentId || '',
      teamId: rec.teamId || '',
      roleId: rec.roleId || '',
      // Blank rather than a placeholder: an unattributed run and a pre-#2137
      // record must both read as "no answer here", not as an account named
      // `unknown` that a downstream sum would treat as a person.
      attributedUserId: attr.userId || '',
      attributionKind: attr.kind || '',
      provider: rec.provider || '',
      providerTier: rec.providerTier || '',
      correlationId: rec.correlationId || '',
      sessionId: rec.sessionId || '',
      repo: g.repo || '',
      prNumber: Number.isInteger(g.prNumber) ? g.prNumber : '',
      issueNumber: Number.isInteger(g.issueNumber) ? g.issueNumber : '',
      branch: git.branch || '',
      durationMs: num(rec.durationMs),
    };
    const split = modelSplit(rec);
    if (split.length) {
      const byModel = [...split].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const { key: model, tokens } of byModel) rows.push({ ...base, model, ...tokenCols(tokens) });
    } else {
      rows.push({ ...base, model: '', ...tokenCols(rec.tokens) });
    }
  }
  return rows;
}

// ── Aggregated summary export: the on-screen grouped/pivoted view (#2440) ─────
// When the caller names a `groupBy` (and optionally a `secondaryGroupBy`), the
// summary export follows exactly what the Statistics table shows — one row per
// group, or one row per (group × subgroup) cell for the cross-tab — instead of
// the raw per-invocation×model dump above. Built on the shared `summarize`
// aggregator so the numbers are byte-identical to the view (§2: totals reconcile).
// The raw dump stays the behaviour when no `groupBy` is given (a direct export
// URL), so nothing that relied on the finest grain regresses.
//
// The two key columns are labelled with the dimension names themselves
// (`agent`, `model`, …) so a downstream pivot keys on them directly; the token
// columns match the raw export so both shapes read the same downstream.
function summaryPivotColumns(groupBy, secondaryGroupBy) {
  const cols = [{ key: 'group', label: groupBy }];
  if (secondaryGroupBy) cols.push({ key: 'subgroup', label: secondaryGroupBy });
  for (const k of TOKEN_CLASSES) cols.push({ key: k, label: k });
  cols.push({ key: 'total', label: 'total' });
  cols.push({ key: 'invocations', label: 'invocations' });
  return cols;
}

function summaryPivotRows(records, { since = null, until = null, groupBy, secondaryGroupBy, nonInstanceAgentIds = null } = {}) {
  const summary = summarize(records, { since, until, groupBy, secondaryGroupBy, nonInstanceAgentIds });
  const secondary = summary.secondaryGroupBy || null;
  const rows = [];
  for (const g of summary.groups) {
    if (secondary) {
      // A cross-tab leaf per (group × subgroup) cell — exactly the rows the
      // expanded nested table shows. A `model` axis splits each run's tokens
      // over its models (as in the view), so the cells add up to the group (#2972).
      for (const s of g.subgroups || []) {
        rows.push({ group: g.key, subgroup: s.key, ...tokenCols(s.tokens), invocations: s.invocations });
      }
    } else {
      rows.push({ group: g.key, ...tokenCols(g.tokens), invocations: g.invocations });
    }
  }
  return { columns: summaryPivotColumns(summary.groupBy, secondary), rows };
}

// ── Work-item export: one row per work-item × model + the remainder ──────────
// Built on top of buildWorkItems so the attribution (§3) is identical to the
// on-screen view. Each row carries the tier breakdown (created/event/branch/
// flow counts) and shared/flow-mismatch flags — the attribution-tier context.
// The unattributed remainder is emitted as its own row so the export sums to
// the grand total (§2 Rule 2: the remainder is always shown, never dropped).
const WORK_ITEM_COLUMNS = [
  { key: 'workItem', label: 'workItem' },
  { key: 'repo', label: 'repo' },
  { key: 'issues', label: 'issues' },
  { key: 'prs', label: 'prs' },
  { key: 'roles', label: 'roles' },
  { key: 'runs', label: 'runs' },
  { key: 'model', label: 'model' },
  { key: 'input', label: 'input' },
  { key: 'output', label: 'output' },
  { key: 'cacheCreationInput', label: 'cacheCreationInput' },
  { key: 'cacheReadInput', label: 'cacheReadInput' },
  { key: 'total', label: 'total' },
  { key: 'tierCreated', label: 'tierCreated' },
  { key: 'tierEvent', label: 'tierEvent' },
  { key: 'tierBranch', label: 'tierBranch' },
  { key: 'tierFlow', label: 'tierFlow' },
  { key: 'shared', label: 'shared' },
  { key: 'flowMismatch', label: 'flowMismatch' },
  { key: 'attributed', label: 'attributed' },
];

function workItemRows(usageRecords, prEvents, { since = null, until = null } = {}) {
  const result = buildWorkItems(usageRecords, prEvents, { since, until });
  const rows = [];

  for (const w of result.workItems) {
    const tiers = w.tiers || {};
    const meta = {
      workItem: w.id,
      repo: w.repo || '',
      issues: (w.issues || []).map((n) => `#${n}`).join(' '),
      prs: (w.prs || []).map((n) => `#${n}`).join(' '),
      roles: [...new Set((w.agents || []).map((a) => a.roleId).filter(Boolean))].join(' '),
      runs: num(w.runs),
      tierCreated: num(tiers.A),
      tierEvent: num(tiers.B),
      tierBranch: num(tiers.C),
      tierFlow: num(tiers['0']),
      shared: w.shared ? 'true' : 'false',
      flowMismatch: w.flowMismatch ? 'true' : 'false',
      attributed: 'true',
    };
    const byModel = (w.tokens && w.tokens.byModel) || {};
    const models = Object.keys(byModel);
    if (models.length) {
      for (const model of models.sort()) rows.push({ ...meta, model, ...tokenCols(byModel[model]) });
    } else {
      // Runs with no per-model breakdown still counted in the work-item total.
      rows.push({ ...meta, model: '', ...tokenCols(w.tokens) });
    }
  }

  // The always-visible unattributed remainder (§2 Rule 2). No model split is
  // available at this level; emit its turn-wide tokens so the export totals
  // reconcile with the grand total the view shows.
  const un = result.unattributed || {};
  if (num(un.runs) > 0 || classTotal(un) > 0) {
    rows.push({
      workItem: '(unattributed)',
      repo: '', issues: '', prs: '', roles: '',
      runs: num(un.runs),
      model: '',
      ...tokenCols(un),
      tierCreated: 0, tierEvent: 0, tierBranch: 0, tierFlow: 0,
      shared: 'false', flowMismatch: 'false',
      attributed: 'false',
    });
  }
  return rows;
}

// ── Public serialize entry point ─────────────────────────────────────────────
// kind: 'summary' | 'work-items'; format: 'csv' | 'json'. Returns the response
// body plus the content type and a filename stem (no extension) for the route.
function serialize(kind, format, {
  records, prEvents, since = null, until = null, groupBy = null, secondaryGroupBy = null, nonInstanceAgentIds = null,
} = {}) {
  const fmt = FORMATS.has(format) ? format : 'csv';
  let columns;
  let rows;
  if (kind === 'work-items') {
    columns = WORK_ITEM_COLUMNS;
    rows = workItemRows(records, prEvents, { since, until });
  } else if (typeof groupBy === 'string' && GROUP_BY.has(groupBy)) {
    // #2440: follow the on-screen grouping (aggregated pivot, one/two levels).
    // #2585: grouped by agent, pool instances fold exactly as on screen.
    ({ columns, rows } = summaryPivotRows(records, { since, until, groupBy, secondaryGroupBy, nonInstanceAgentIds }));
  } else {
    columns = SUMMARY_COLUMNS;
    rows = summaryRows(records, { since, until });
  }
  if (fmt === 'json') {
    return { body: JSON.stringify(rows, null, 2), contentType: 'application/json; charset=utf-8', ext: 'json' };
  }
  return { body: toCsv(columns, rows), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
}

module.exports = {
  serialize,
  summaryRows,
  summaryPivotRows,
  summaryPivotColumns,
  workItemRows,
  toCsv,
  SUMMARY_COLUMNS,
  WORK_ITEM_COLUMNS,
  FORMATS,
};
