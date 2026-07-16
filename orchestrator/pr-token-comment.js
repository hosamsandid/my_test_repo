'use strict';

// Pure formatter for the PR-merge token-usage comment (#678, Phase 3 item 2 of
// docs/cost-per-pr-concept.md). AC8: all summary/formatting logic lives here as a
// pure, unit-tested module; the merge-detection + posting shell (github-poller.js
// hook + orchestrator.js callback) stays thin.
//
// Input is the work-item detail produced by the Phase-2 aggregation (the verbatim
// work-items.js mirror's workItemDetail) — this module does NOT re-implement
// attribution (AC "reuse, do not re-implement"). Output is a single Markdown body
// plus a stable idempotency marker the posting shell uses to update-or-skip (AC7).
//
// Rules honoured here:
//   §2 Rule 1 — the four token classes are always shown separately (never a lone
//               total): input, output, cache-write (cacheCreationInput), cache-read
//               (cacheReadInput). Class totals in the headline; per-model one
//               `<details>` away (AC1).
//   §2 Rule 2 — no proration; the numbers are whatever the aggregation counted.
//   Scope decision 1 — NO money / derived cost anywhere. Tokens only (AC3). A test
//               asserts the rendered body carries no currency symbol.
//   §3.1 degrade-visibly — a PR that maps to no work item (or one with no counted
//               runs) yields a clearly-labelled "unattributed" note, never a wrong
//               or empty total (AC6).
//   §3.3 coverage gap — within a work item every counted run is attributed by some
//               tier (a tier-∅ run belongs to no component, so it can't be here);
//               the honest, unquantifiable remainder is aborted runs that never
//               wrote a result row. The comment states this rather than inventing a
//               per-item unattributed number (AC2 coverage indicator).

// Stable across versions so the posting shell can find a prior comment and
// update-or-skip it (AC7). Do NOT bump this casually — changing it orphans every
// comment already posted, re-enabling the duplicate it is meant to prevent.
const COMMENT_MARKER = '<!-- aee-token-usage-comment -->';

const TOKEN_CLASSES = ['input', 'output', 'cacheCreationInput', 'cacheReadInput'];
const CLASS_LABELS = {
  input: 'Input',
  output: 'Output',
  cacheCreationInput: 'Cache write',
  cacheReadInput: 'Cache read',
};
// Human-readable tier legend (§3.2). A/B are exact signals; C is the branch
// heuristic — surfaced so a reader can weigh attribution confidence.
const TIER_LABELS = {
  '0': 'Flow instance',
  A: 'Opened the PR',
  B: 'Ran on an issue/PR event',
  C: 'Committed on the PR branch',
};

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Thousands-grouped integer, dependency-free + deterministic (no locale surprises).
function fmt(n) {
  const v = Math.round(num(n));
  const neg = v < 0;
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${s}` : s;
}

// A work item is "meaningful" only if it actually counted runs/tokens. A resolved
// component with zero runs (e.g. a PR node linked to an issue whose only runs fell
// outside the window) must NOT render a misleading "0 tokens" total (AC6).
function hasUsage(detail) {
  return !!detail && Array.isArray(detail.runs) && detail.runs.length > 0;
}

function artifactRefs(detail) {
  const parts = [];
  if (Array.isArray(detail.issues) && detail.issues.length) {
    parts.push(`issue${detail.issues.length > 1 ? 's' : ''} ${detail.issues.map((n) => `#${n}`).join(', ')}`);
  }
  if (Array.isArray(detail.prs) && detail.prs.length) {
    parts.push(`PR${detail.prs.length > 1 ? 's' : ''} ${detail.prs.map((n) => `#${n}`).join(', ')}`);
  }
  return parts.join(' · ');
}

function classTable(tokens) {
  const rows = TOKEN_CLASSES.map((k) => `| ${CLASS_LABELS[k]} | ${fmt(tokens && tokens[k])} |`);
  return ['| Class | Tokens |', '|---|---|', ...rows].join('\n');
}

function perModelTable(byModel) {
  const models = byModel && typeof byModel === 'object' ? Object.keys(byModel).sort() : [];
  if (!models.length) return null;
  const header = `| Model | ${TOKEN_CLASSES.map((k) => CLASS_LABELS[k]).join(' | ')} | Total |`;
  const sep = `|---|${TOKEN_CLASSES.map(() => '---').join('|')}|---|`;
  const rows = models.map((m) => {
    const t = byModel[m] || {};
    const cells = TOKEN_CLASSES.map((k) => fmt(t[k]));
    return `| \`${m}\` | ${cells.join(' | ')} | ${fmt(t.total)} |`;
  });
  return [header, sep, ...rows].join('\n');
}

function contributorsTable(agents) {
  if (!Array.isArray(agents) || !agents.length) return null;
  const rows = agents.map((a) => {
    const tok = a.tokens ? fmt(a.tokens.total) : '—';
    return `| \`${a.agentId || '—'}\` | ${a.roleId || '—'} | ${fmt(a.runs)} | ${tok} |`;
  });
  return ['| Agent | Role | Runs | Tokens |', '|---|---|---|---|', ...rows].join('\n');
}

function tierLine(tiers) {
  const t = tiers || {};
  const order = ['0', 'A', 'B', 'C'];
  const present = order.filter((k) => num(t[k]) > 0);
  if (!present.length) return null;
  return present.map((k) => `**${k}** ${TIER_LABELS[k]}: ${fmt(t[k])}`).join(' · ');
}

// The "no meaningful work item" note (AC6). Short, unambiguous, and still carries
// the idempotency marker so a re-delivery updates-or-skips this note too (AC7).
function renderUnattributed({ repo, prNumber }) {
  const body = [
    '### Token usage',
    '',
    `No agent token usage could be attributed to **${repo}#${prNumber}**.`,
    'This pull request maps to no recorded work item — either no agent ran on it, '
      + 'or its runs fell outside the captured records. No token total is shown rather '
      + 'than a misleading zero.',
    '',
    COMMENT_MARKER,
  ].join('\n');
  return { body, marker: COMMENT_MARKER, attributed: false };
}

// Render the full work-item token summary comment. `detail` is a workItemDetail(...)
// result (or null). Returns { body, marker, attributed }.
function formatPrTokenComment({ repo, prNumber, detail }) {
  if (!hasUsage(detail)) return renderUnattributed({ repo, prNumber });

  const tokens = detail.tokens || {};
  const runCount = Array.isArray(detail.runs) ? detail.runs.length : num(detail.runs);
  const refs = artifactRefs(detail);

  const lines = [];
  lines.push('### Token usage for this work item');
  lines.push('');
  lines.push(`**Work item:** \`${detail.repo || repo}\`${refs ? ` · ${refs}` : ''}`);
  lines.push('');
  lines.push(`**Total: ${fmt(tokens.total)} tokens** across ${fmt(runCount)} run${runCount === 1 ? '' : 's'}`);
  lines.push('');
  lines.push(classTable(tokens));
  lines.push('');

  // Attribution & coverage (AC2). The tier breakdown is the confidence indicator;
  // the caveat is the honest, unquantifiable coverage gap (§3.3).
  const tl = tierLine(detail.tiers);
  lines.push('**Attribution & coverage**');
  lines.push('');
  if (tl) lines.push(`- Tiers: ${tl}`);
  lines.push(`- All ${fmt(runCount)} counted run${runCount === 1 ? '' : 's'} are attributed to this work item.`);
  if (detail.shared) {
    lines.push('- Some runs also touched other work items; their tokens are counted once, in their primary item.');
  }
  if (detail.flowMismatch) {
    lines.push('- ⚠️ More than one flow instance collided on this chain — attribution may be over-broad.');
  }
  lines.push('- Aborted runs that never wrote a result row are not captured (a known coverage gap).');
  lines.push('');

  const contrib = contributorsTable(detail.perAgent || detail.agents);
  if (contrib) {
    lines.push('**Contributors**');
    lines.push('');
    lines.push(contrib);
    lines.push('');
  }

  const models = perModelTable(tokens.byModel);
  if (models) {
    lines.push('<details>');
    lines.push('<summary>Per-model detail</summary>');
    lines.push('');
    lines.push(models);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push('_Token counts only — no cost figures._');
  lines.push('');
  lines.push(COMMENT_MARKER);

  return { body: lines.join('\n'), marker: COMMENT_MARKER, attributed: true };
}

// The posting shell uses this to implement update-or-skip (AC7): scan existing PR
// comments for a prior comment carrying the marker.
function findExistingComment(comments) {
  if (!Array.isArray(comments)) return null;
  return comments.find((c) => c && typeof c.body === 'string' && c.body.includes(COMMENT_MARKER)) || null;
}

module.exports = {
  formatPrTokenComment,
  findExistingComment,
  COMMENT_MARKER,
  TOKEN_CLASSES,
  // exported for unit tests
  fmt,
  hasUsage,
};
