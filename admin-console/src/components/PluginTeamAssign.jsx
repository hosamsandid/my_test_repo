import React from 'react';
import { Users, ChevronDown, ChevronRight } from 'lucide-react';
import { apiCall } from '../hooks/useApi';
import PageHelpButton from './PageHelpButton';
import {
  pluginAssignmentState,
  assignmentGranularity,
  assignmentGate,
} from '../pages/plugin-team-assign-view.js';
import { PLUGINS_HELP_SECTIONS } from '../pages/plugins-help-sections.js';

// Team-assignment control for an installed plugin's card on the Plugins page
// (#1691). It reuses the existing activation path
// (`POST /api/agents/:teamId/plugins/{activate,deactivate}`, team construct) —
// no new grant mechanism — and, like the Agents-page grant, applies IMMEDIATELY
// (no Save, no restart). Every render/gate/granularity decision comes from the
// pure plugin-team-assign-view.js; this file only renders and calls the API.
// The server re-enforces grantability, so the UI bound is a courtesy.
export default function PluginTeamAssign({ row, teams, stackRuntime, onChanged }) {
  const [open, setOpen] = React.useState(false);
  const [busyId, setBusyId] = React.useState(null);
  const [err, setErr] = React.useState('');

  // Optimistic local copy of the grantable teams so a checkbox reflects the
  // click before the parent's /api/agents refetch lands; reset whenever the
  // server view changes (covers a concurrent change from the Agents page).
  const [localTeams, setLocalTeams] = React.useState(teams || []);
  React.useEffect(() => { setLocalTeams(teams || []); }, [teams]);

  const state = React.useMemo(() => pluginAssignmentState(row.id, localTeams), [row.id, localTeams]);
  const gate = React.useMemo(() => assignmentGate(row, stackRuntime), [row, stackRuntime]);
  const granularity = React.useMemo(() => assignmentGranularity(row), [row]);

  async function toggle(team, granted) {
    if (busyId) return;
    setErr(''); setBusyId(team.id);
    const verb = granted ? 'activate' : 'deactivate';
    // Optimistic grant edit — mirrors PluginGrantSection's serverGrant pattern.
    setLocalTeams((prev) => prev.map((t) => (t.id === team.id
      ? {
        ...t,
        plugins: granted
          ? [...t.plugins.filter((g) => g.id !== row.id), { id: row.id, scopeGranularity: granularity }]
          : t.plugins.filter((g) => g.id !== row.id),
      }
      : t)));
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(team.id)}/plugins/${verb}`, {
        pluginId: row.id,
        scopeGranularity: granularity,
      });
      if (onChanged) await onChanged();
    } catch (e) {
      setErr(e.message || `Could not ${verb} ${row.name} for ${team.name}`);
      setLocalTeams(teams || []); // roll back to server truth
    } finally { setBusyId(null); }
  }

  return (
    <div style={{ marginTop: 'var(--eb-space-3)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
      {/* The control's "?" (#1986) sits in this header row, ABOVE the no-team
          branch below — the reader who is told they have no team to assign to is
          exactly the one who needs the chapter explaining why, so the affordance
          must not live inside the branch it would then be missing from. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <Users size={14} style={{ color: 'var(--eb-text-muted)', flex: '0 0 auto' }} />
        <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-muted)' }}>
          Team assignment
        </span>
        <PageHelpButton
          label="How assigning a plugin to a team works"
          size={14}
          style={{ flex: '0 0 auto' }}
          section={PLUGINS_HELP_SECTIONS.teamAssignment}
        />
      </div>

      {/* AC8: no team the caller may grant to — an explanatory hint, not an error. */}
      {state.noTeams ? (
        <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          You have no team you can assign this plugin to. Assigning a plugin to a team is done by a
          Team Admin (or System Admin) of that team.
        </div>
      ) : (
        <>
          {/* AC3/AC6: which teams currently have it, or the inviting empty state. */}
          <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: state.grantedCount ? 'var(--eb-text-secondary)' : 'var(--eb-text-muted)' }}>
            {state.summary}
          </div>

          {/* Platform mismatch still gates/warns here (edge case). */}
          {!gate.ok && (
            <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning-text)' }}>
              {gate.reason}
            </div>
          )}

          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
              marginTop: 'var(--eb-space-2)', padding: 0, border: 'none', background: 'none',
              fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)', fontWeight: 500,
              color: 'var(--eb-accent-primary)', cursor: 'pointer',
            }}
            aria-expanded={open}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {open ? 'Hide teams' : 'Assign to teams'}
          </button>

          {err && (
            <div role="alert" style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error-text)' }}>
              {err}
            </div>
          )}

          {open && (
            <div style={{ marginTop: 'var(--eb-space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
              {state.rows.map((r) => {
                const team = localTeams.find((t) => t.id === r.id) || r;
                const rowBusy = busyId === r.id;
                return (
                  <label
                    key={r.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                      fontSize: 'var(--eb-text-sm)',
                      cursor: (!gate.ok || busyId) ? 'not-allowed' : 'pointer',
                      opacity: (!gate.ok || (busyId && !rowBusy)) ? 0.6 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={r.granted}
                      disabled={!gate.ok || !!busyId}
                      onChange={(e) => toggle(team, e.target.checked)}
                      style={{ flex: '0 0 auto' }}
                    />
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
