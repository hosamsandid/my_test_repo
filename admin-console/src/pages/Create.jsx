import React from 'react';
import { Link } from 'react-router';
import {
  Plus, MessageSquare, LayoutTemplate, PenTool, Rocket,
} from 'lucide-react';
import { createEntries } from './create-launcher-view';
import PageHelpButton from '../components/PageHelpButton';

/**
 * The unified "Create" launcher (#1665, Phase B/C of epic #1661).
 *
 * One front door for starting something new: a small set of equally-ranked,
 * plainly-labelled choices (Describe it · Start from a ready-made setup · Build
 * it yourself · Just one assistant to chat with). The user picks how they want
 * to start, not which internal artifact type they are making — so a first-time
 * user never has to know the words agent / team / flow / template (AC7).
 *
 * Reached from both a persistent "+ Create" control in the sidebar and this
 * dedicated route (both render this same launcher — D4). Each entry hands off
 * to the EXISTING backend/flow for that path; the routes are data in the pure,
 * unit-tested create-launcher-view.js, so the empty-state guidance of each
 * target (no Model Provider, no saved setups, …) is inherited unchanged rather
 * than re-implemented here.
 */

// Map the icon name carried by each pure entry to its lucide component. Keeping
// the name (not the component) in the view module leaves that module free of
// React / lucide imports and unit-testable.
const ICONS = {
  MessageSquare,
  LayoutTemplate,
  PenTool,
  Rocket,
};

export default function Create() {
  const entries = createEntries();
  return (
    <div style={{
      padding: 'var(--eb-space-8) var(--eb-space-6)',
      maxWidth: 860,
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-6)',
    }}>
      {/* Header. The one-line question stays; what each entry path produces (and
          what "a team of one" means) is the create help topic — E14, #1888. */}
      <div>
        <p style={{
          margin: 0,
          color: 'var(--eb-text-secondary)',
          fontSize: 'var(--eb-text-md)',
          lineHeight: 1.6,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
        }}>
          <span>How would you like to start? Pick whichever fits — you can always change direction later.</span>
          <PageHelpButton label="What does each of these create?" size={14} style={{ padding: 0, flexShrink: 0 }} />
        </p>
      </div>

      {/* Equally-ranked entry tiles. Every tile shares one style (no forced
          default — D1): same border, background, padding and hover treatment. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
        gap: 'var(--eb-space-4)',
      }}>
        {entries.map((entry) => {
          const Icon = ICONS[entry.icon] || Plus;
          return (
            <Link
              key={entry.key}
              to={entry.to}
              data-testid={`create-entry-${entry.key}`}
              style={{
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-lg)',
                background: 'var(--eb-bg-surface)',
                padding: 'var(--eb-space-5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--eb-space-3)',
                textDecoration: 'none',
                transition: 'border-color var(--eb-transition-fast), background var(--eb-transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--eb-accent-primary)';
                e.currentTarget.style.background = 'var(--eb-bg-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--eb-border-default)';
                e.currentTarget.style.background = 'var(--eb-bg-surface)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 40,
                  height: 40,
                  borderRadius: 'var(--eb-radius-md)',
                  background: 'var(--eb-bg-elevated)',
                  color: 'var(--eb-accent-primary)',
                  flexShrink: 0,
                }}>
                  <Icon size={20} />
                </span>
                <span style={{ fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
                  {entry.title}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
                {entry.description}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
