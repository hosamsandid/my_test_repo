import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';
import { describeMaterializeError } from './materialize-error.js';
import LaunchStep from './LaunchStep';
import { slugify } from './launch-team.js';

// Materialise an imported process-template bundle into a real team (#334).
// Reuses the Team-Setup pipeline (POST /api/teams) via its `processTemplate`
// path — team + members + rollback are all handled there. Instead of typing a
// repo URL + credentials, the operator picks an existing Working Environment,
// which already carries the repository and the SSH-key / GitHub-token split.
//
// This is now a thin wrapper over the shared `LaunchStep` (#1668, epic #1661
// Phase E): the Team-Setup wizard's final step and this dialog render the SAME
// launch component, so the two front doors can't diverge. This dialog supplies
// the SidePanel chrome + the environment list + the bundle-specific intro; the
// launch controls, streaming submit and progress/collision/error feedback all
// live in LaunchStep.
export default function MaterializeDialog({ bundle, onClose, onDone }) {
  const navigate = useNavigate();
  const [environments, setEnvironments] = useState([]);
  const [envsLoaded, setEnvsLoaded] = useState(false);
  const [envError, setEnvError] = useState(null);

  // A draft opened from a live team (#348) remembers its origin so we can default
  // to extending it rather than creating a colliding new team.
  const sourceTeamId = bundle?.sourceTeamId || null;
  const [values, setValues] = useState({
    teamName: bundle?.name || 'Team',
    teamId: sourceTeamId || slugify(bundle?.name || 'team'),
    // A slug carried over from a source team is treated as already manual so we
    // don't clobber it as the name is typed.
    teamIdManuallyEdited: !!sourceTeamId,
    environmentId: '',
    labelSuffix: '',
    extend: !!sourceTeamId,
    // Default to deferred materialization: a process can have dozens of members,
    // and materializing each one clones the repo. Create them as stubs and
    // materialize on demand by enabling. Opt in to clone-now here.
    materializeNow: false,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const envs = await apiCall('GET', '/api/environments').catch(() => []);
        if (!alive) return;
        const list = Array.isArray(envs) ? envs : (envs?.environments || []);
        setEnvironments(list);
        setEnvsLoaded(true);
        // Prefer the env named after the source team, else the first one.
        const preferred = (sourceTeamId && list.find(e => e.id === sourceTeamId)) || list[0];
        if (preferred) setValues(v => ({ ...v, environmentId: preferred.id }));
      } catch (e) {
        if (alive) {
          const { message } = describeMaterializeError(e, { action: 'load the working environments' });
          setEnvError(message); setEnvsLoaded(true);
        }
      }
    })();
    return () => { alive = false; };
  }, [sourceTeamId]);

  function goCreateEnv() {
    onClose?.();
    navigate('/environments');
  }

  return (
    <SidePanel open onClose={onClose} title="Materialize as team" width="520px">
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 0 }}>
        Creates a team and one member per agent in
        <strong> {bundle?.name}</strong> ({bundle?.roles?.length || 0} agents) on the selected
        working environment. Each agent keeps its prompt and triggers;
        <code>{'{{vars}}'}</code> and the environment's repositories are applied per member.
      </p>
      {envError && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)', marginBottom: 'var(--eb-space-2)' }}>
          {envError}
        </div>
      )}
      <LaunchStep
        bundle={bundle}
        environments={envsLoaded ? environments : null}
        values={values}
        onChange={patch => setValues(v => ({ ...v, ...patch }))}
        onCreateEnvironment={goCreateEnv}
        onComplete={() => {
          onDone?.();
          navigate(`/process/${encodeURIComponent(values.teamId)}`);
        }}
        leftAction={<button type="button" onClick={onClose} style={ghost}>Cancel</button>}
      />
    </SidePanel>
  );
}

const ghost = {
  background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
