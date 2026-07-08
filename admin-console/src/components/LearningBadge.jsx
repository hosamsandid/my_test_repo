import React, { useEffect, useState, useCallback } from 'react';
import { Brain } from 'lucide-react';

/**
 * Ambient "what this scope has learned" pill (Shared Agent Learning, Phase 2).
 *
 * A small, self-contained widget fed by the lean GET /api/knowledge/summary
 * endpoint (no full graph build). Mounts on Agent cards (scope=agent:<id>),
 * Team cards (scope=team:<id>) and the chat header. One vocabulary everywhere:
 * "N learned" plus a "+N today" accent when there's fresh activity.
 *
 * Purely presentational + its own fetch; renders nothing until it has counts,
 * so it never adds visual noise to a scope with no knowledge yet (unless
 * `showZero`). Optionally clickable to deep-link into the Knowledge Flow page.
 */
export default function LearningBadge({ scope, onClick, showZero = false, title, refreshKey }) {
  const [summary, setSummary] = useState(null);

  const load = useCallback(() => {
    if (!scope) return;
    fetch(`/api/knowledge/summary?scope=${encodeURIComponent(scope)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data) setSummary(data); })
      .catch(() => {});
  }, [scope]);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (!summary) return null;
  const { items = 0, today = 0, converged = 0 } = summary;
  if (items === 0 && !showZero) return null;

  const clickable = typeof onClick === 'function';
  const label = items === 0 ? 'nothing learned yet' : `${items} learned`;
  const tip = title || `${items} knowledge ${items === 1 ? 'entry' : 'entries'}`
    + (today ? `, ${today} today` : '')
    + (converged ? `, ${converged} converged` : '');

  return (
    <span
      onClick={clickable ? onClick : undefined}
      title={tip}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        padding: '2px var(--eb-space-2)', borderRadius: 'var(--eb-radius-full)',
        border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
        color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)',
        fontFamily: 'var(--eb-font-sans)', lineHeight: 1.4, whiteSpace: 'nowrap',
        cursor: clickable ? 'pointer' : 'default', userSelect: 'none',
      }}
    >
      <Brain size={12} style={{ color: 'var(--eb-accent-primary)' }} />
      <span>{label}</span>
      {today > 0 && (
        <span style={{
          color: 'var(--eb-status-success)', fontWeight: 'var(--eb-font-semibold)',
        }}>+{today} today</span>
      )}
    </span>
  );
}
