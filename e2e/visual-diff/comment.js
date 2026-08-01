// Sticky PR comment renderer for the before/after screenshot evidence (#709,
// §3.4 item 3). Pure string building — no fs, no gh, no network — so it is
// unit-tested from fixture comparison results. The workflow feeds the rendered
// body to a find-and-update-by-marker `gh` step (see bin/compare-and-comment.js
// and ui-screenshots.yml).

const { STATUS } = require('./compare');

// Invisible in rendered Markdown; the anchor the workflow greps for to decide
// update-vs-create so repeated PR runs edit ONE comment instead of stacking.
const COMMENT_MARKER = '<!-- journey-visual-diff -->';

function pct(ratio) {
  if (ratio == null) return '—';
  const p = ratio * 100;
  if (p === 0) return '0%';
  if (p < 0.01) return '<0.01%';
  return `${p.toFixed(2)}%`;
}

// urlFor(result, kind) -> URL string | null, kind ∈ 'baseline'|'current'|'diff'.
// When it returns a URL we embed the image inline (real grid); when it returns
// null we degrade to a dash so the comment still renders (evidence, not a gate).
function cell(urlFor, result, kind) {
  const url = urlFor ? urlFor(result, kind) : null;
  if (!url) return '—';
  return `![${kind}](${url})`;
}

function changedTable(results, urlFor) {
  const rows = ['| Capture | Before | After | Diff | Δ |', '| --- | --- | --- | --- | --- |'];
  for (const r of results) {
    const label =
      r.status === STATUS.ADDED ? `\`${r.id}\` _(new)_`
      : r.status === STATUS.REMOVED ? `\`${r.id}\` _(removed)_`
      : `\`${r.id}\``;
    const before = r.status === STATUS.ADDED ? '—' : cell(urlFor, r, 'baseline');
    const after = r.status === STATUS.REMOVED ? '—' : cell(urlFor, r, 'current');
    const diff = r.dimensionMismatch ? '_size changed_' : cell(urlFor, r, 'diff');
    const delta = r.dimensionMismatch
      ? `${r.baselineSize?.width}×${r.baselineSize?.height} → ${r.currentSize?.width}×${r.currentSize?.height}`
      : r.status === STATUS.ADDED || r.status === STATUS.REMOVED ? '—'
      : `${pct(r.ratio)} (${r.diffPixels}px)`;
    rows.push(`| ${label} | ${before} | ${after} | ${diff} | ${delta} |`);
  }
  return rows.join('\n');
}

// Render the full sticky comment body for a comparison result.
//   comparison  — the object returned by compare.compareSets()
//   urlFor      — (result, kind) => url|null resolver for the images
//   artifactUrl — link to the uploaded diff artifact (download bundle)
//   runUrl      — link to the workflow run
//   commit      — PR head short sha (context line)
//   baselineRef — human label of the baseline source (e.g. "main")
function renderComment(comparison, {
  urlFor = null,
  artifactUrl = null,
  runUrl = null,
  commit = null,
  baselineRef = 'main',
} = {}) {
  const { summary, results } = comparison;
  const visible = results.filter((r) => r.status !== STATUS.UNCHANGED);
  const unchanged = results.filter((r) => r.status === STATUS.UNCHANGED);

  const lines = [COMMENT_MARKER, '', '## 📸 Journey UI screenshots'];

  const ctx = [];
  if (commit) ctx.push(`commit \`${String(commit).slice(0, 7)}\``);
  ctx.push(`baseline: ${baselineRef}`);
  if (runUrl) ctx.push(`[run](${runUrl})`);
  lines.push('', `_${ctx.join(' · ')}_`);

  if (summary.total === 0) {
    lines.push('', '> No baseline screenshots were available to compare against yet — the first green `main` run publishes the baseline, then diffs appear here.');
    lines.push('', '_Evidence only — this check never fails a PR on pixel differences (concept §3.4 / §10.4)._');
    return lines.join('\n');
  }

  if (visible.length === 0) {
    lines.push('', `✅ **No visual changes** across ${summary.total} captured screenshot${summary.total === 1 ? '' : 's'}.`);
  } else {
    const bits = [];
    if (summary.changed) bits.push(`${summary.changed} changed`);
    if (summary.added) bits.push(`${summary.added} new`);
    if (summary.removed) bits.push(`${summary.removed} removed`);
    lines.push('', `**${bits.join(', ')}** of ${summary.total} screenshot${summary.total === 1 ? '' : 's'}.`);
    lines.push('', changedTable(visible, urlFor));
  }

  if (unchanged.length) {
    lines.push('', '<details>', `<summary>${unchanged.length} unchanged capture${unchanged.length === 1 ? '' : 's'}</summary>`, '');
    for (const r of unchanged) lines.push(`- \`${r.id}\``);
    lines.push('', '</details>');
  }

  if (artifactUrl) lines.push('', `📦 [Download all before/after/diff images](${artifactUrl})`);
  lines.push('', '_Evidence only — this check never fails a PR on pixel differences (concept §3.4 / §10.4)._');
  return lines.join('\n');
}

module.exports = { renderComment, COMMENT_MARKER, pct };
