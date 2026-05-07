import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

/**
 * StatGrid — Dashboard stat cards in a responsive grid.
 *
 * Props:
 *   stats — Array of { label, value, trend?, trendLabel?, status? }
 *     trend: 'up' | 'down' | 'flat'
 *     status: 'success' | 'warning' | 'error' | 'info' | 'neutral'
 */
export default function StatGrid({ stats = [] }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${Math.min(stats.length, 4)}, 1fr)`,
      gap: 'var(--eb-space-4)',
    }}>
      {stats.map((stat, i) => (
        <StatCard key={i} {...stat} />
      ))}
    </div>
  );
}

function StatCard({ label, value, trend, trendLabel, status, dotColor }) {
  const trendColor = trend === 'up'
    ? 'var(--eb-status-success)'
    : trend === 'down'
      ? 'var(--eb-status-error)'
      : 'var(--eb-text-muted)';

  const TrendIcon = trend === 'up' ? TrendingUp
    : trend === 'down' ? TrendingDown
    : Minus;

  const statusDotColor = dotColor
    ?? (status ? `var(--eb-status-${status === 'neutral' ? 'info' : status})` : null);

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      padding: 'var(--eb-space-4)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-2)',
    }}>
      <div style={{
        fontSize: 'var(--eb-text-sm)',
        fontWeight: 'var(--eb-font-medium)',
        color: 'var(--eb-text-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
      }}>
        {statusDotColor && (
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: statusDotColor, flexShrink: 0,
          }} />
        )}
        {label}
      </div>
      <div style={{
        fontSize: 'var(--eb-text-3xl)',
        fontWeight: 'var(--eb-font-bold)',
        color: 'var(--eb-text-primary)',
        lineHeight: 1.2,
      }}>
        {value}
      </div>
      {(trend || trendLabel) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-1)',
          fontSize: 'var(--eb-text-xs)',
          color: trendColor,
        }}>
          <TrendIcon size={14} />
          <span>{trendLabel}</span>
        </div>
      )}
    </div>
  );
}
