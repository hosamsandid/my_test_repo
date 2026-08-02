import React, { useMemo } from 'react';
import { Link } from 'react-router';
import { buildRows, driftLineageHref } from './skill-picker-rows.js';

// SkillPicker v2 (#633): a grant-aware picker over the two-tier skill pool.
// `skills` are the objects from GET /api/skills[?teamId=] — each carries
// { name, source: 'pool'|'team', teamId?, description?, version?, drift? }. The
// grant is name-based, so we render ONE checkbox per name: when a team skill
// shadows a global one of the same name, team-first resolution wins and the row
// says so. Pre-selected names that resolve to no known skill (AC4 — a grant
// carried through from before the picker existed, or a stale entry) are still
// rendered, checked, and flagged, never silently dropped.
//
// Row-building, the shadow/unknown/drift flags and the drift → Lineage deep-link
// target live in the pure ./skill-picker-rows.js module (node:test-covered).

function Chip({ children, title, bg, fg, border, to }) {
  const style = {
    fontSize: 'var(--eb-text-xs)',
    lineHeight: 1.5,
    padding: '0 6px',
    borderRadius: 'var(--eb-radius-sm)',
    background: bg || 'var(--eb-bg-app)',
    color: fg || 'var(--eb-text-muted)',
    border: border || '1px solid var(--eb-border-default)',
    whiteSpace: 'nowrap',
    flex: '0 0 auto',
  };
  // A `to` chip is a real link (e.g. the drift chip → Lineage view). It sits
  // inside the row's <label>, so stop the click from also toggling the grant.
  if (to) {
    return (
      <Link
        to={to}
        title={title}
        onClick={e => e.stopPropagation()}
        style={{ ...style, textDecoration: 'underline', cursor: 'pointer' }}
      >{children}</Link>
    );
  }
  return <span title={title} style={style}>{children}</span>;
}

export default function SkillPicker({ skills, selected, onChange, emptyHint }) {
  const sel = Array.isArray(selected) ? selected : [];
  const rows = useMemo(() => buildRows(skills || [], sel), [skills, sel]);

  const toggle = (name) => {
    if (sel.includes(name)) onChange(sel.filter(s => s !== name));
    else onChange([...sel, name]);
  };

  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
        {emptyHint || 'No skills in the pool. Create skills on the Skills page or promote them from the Knowledge page.'}
      </div>
    );
  }

  return (
    <div>
      {/* Global-vs-Team primer (#1143) so the row chips read on their own. */}
      <p style={{
        margin: '0 0 var(--eb-space-1)',
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
        lineHeight: 1.5,
      }}>
        A <strong>Global</strong> skill is shared with everyone; a{' '}
        <strong>Team</strong> skill is scoped to one team and, when it shares a name,
        shadows the global one. A <em>drift</em> chip means a copy no longer matches
        its source — click it to open the Lineage view.
      </p>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--eb-space-1)',
        maxHeight: 260,
        overflowY: 'auto',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-2)',
        background: 'var(--eb-bg-elevated)',
      }}>
        {rows.map(row => (
        <label
          key={row.name}
          title={row.description || undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-1) var(--eb-space-2)',
            borderRadius: 'var(--eb-radius-sm)',
            cursor: 'pointer',
            fontSize: 'var(--eb-text-sm)',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--eb-bg-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <input
            type="checkbox"
            checked={sel.includes(row.name)}
            onChange={() => toggle(row.name)}
            style={{ flex: '0 0 auto' }}
          />
          <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', flex: '0 0 auto' }}>
            {row.name}
          </span>
          {row.unknown ? (
            <Chip
              title="This granted skill matches no skill in the current pool. It is kept and flagged, not dropped — uncheck it to remove it from the grant."
              bg="var(--eb-status-warning-bg, #fff7ed)"
              fg="var(--eb-status-warning, #b45309)"
              border="1px solid var(--eb-status-warning, #b45309)"
            >not found</Chip>
          ) : (
            <>
              <Chip
                bg={row.tier === 'team' ? 'var(--eb-accent-subtle, #eef2ff)' : 'var(--eb-bg-app)'}
                fg={row.tier === 'team' ? 'var(--eb-accent, #4f46e5)' : 'var(--eb-text-muted)'}
              >{row.tier === 'team' ? 'Team' : 'Global'}</Chip>
              {row.shadowsGlobal && (
                <Chip title="A team skill of this name shadows the global skill — team-first resolution means the team version is the one granted.">
                  shadows global
                </Chip>
              )}
              {row.version != null && <Chip title="Skill manifest version">{`v${row.version}`}</Chip>}
              {row.drift && (
                <Chip
                  to={driftLineageHref(row)}
                  title="This copy has drifted from its source skill — open the Lineage/Drift view."
                  bg="var(--eb-status-warning-bg, #fff7ed)"
                  fg="var(--eb-status-warning, #b45309)"
                >{`drift: ${row.drift}`}</Chip>
              )}
              {row.description && (
                <span style={{
                  color: 'var(--eb-text-muted)',
                  fontSize: 'var(--eb-text-xs)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: '1 1 auto',
                  minWidth: 0,
                }}>{row.description}</span>
              )}
            </>
          )}
        </label>
        ))}
      </div>
    </div>
  );
}
