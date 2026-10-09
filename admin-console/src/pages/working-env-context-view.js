// ─── Additional context: what a save did to existing agents (#2688) ──────────
//
// An environment's Additional context is written into each bound agent's
// CLAUDE.md. `PUT /api/environments/:id` now rebuilds that file for every
// existing agent when the text changes and returns the per-agent outcome as
// `promptRebuild`; this turns it into the lines the Team Settings panel shows
// after the save — the same shape as mcpApplySummary, so both reports render
// through one block.

/**
 * @param promptRebuild  the report, or undefined when the save did not change
 *                       the Additional context
 * @returns {{tone: 'ok'|'warn', lines: string[]} | null}
 */
export function promptRebuildSummary(promptRebuild) {
  if (!promptRebuild || typeof promptRebuild !== 'object') return null;
  if (promptRebuild.ok === false) {
    return {
      tone: 'warn',
      lines: [
        'The Additional context was saved, but existing agents’ CLAUDE.md could not be updated: '
          + `${promptRebuild.error || 'unknown error'}. They keep the previous text until the next successful change.`,
      ],
    };
  }
  const list = v => (Array.isArray(v) ? v : []);
  const names = ids => ids.join(', ');
  const lines = [];
  const rebuilt = list(promptRebuild.rebuilt);
  const pending = list(promptRebuild.pending);
  const failed = list(promptRebuild.failed).filter(f => f && f.id);
  if (rebuilt.length) lines.push(`Additional context written into the CLAUDE.md of ${names(rebuilt)} — in effect from the next run.`);
  if (pending.length) lines.push(`Not created yet: ${names(pending)} — gets the new text when it is created.`);
  for (const f of failed) lines.push(`CLAUDE.md not updated for ${f.id}: ${f.error || 'failed'}.`);
  if (!lines.length) return null;
  return { tone: failed.length ? 'warn' : 'ok', lines };
}

/**
 * #2813 AC9: model pins dropped because the environment's new model provider
 * does not serve them (`modelWarnings` on the PUT response), or null.
 * @returns {{tone: 'warn', lines: string[]} | null}
 */
export function modelWarningsSummary(modelWarnings) {
  const lines = (Array.isArray(modelWarnings) ? modelWarnings : []).filter(w => typeof w === 'string' && w);
  return lines.length ? { tone: 'warn', lines } : null;
}

export default { promptRebuildSummary, modelWarningsSummary };
