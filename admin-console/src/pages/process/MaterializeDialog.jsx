import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';
import { describeMaterializeError } from './materialize-error.js';
import LaunchStep from './LaunchStep';
import { slugify } from './launch-team.js';
import { CREATE_TEAM_DIALOG_TITLE, OPEN_TEAM_LABEL } from './create-team-copy.js';

// Turn a process-template bundle — an imported file or the open draft — into a
// real team (#334). Titled **Create team** since #2053: it used to be
// *Materialize as team*, which meant the word the user clicked on the toolbar
// was not the word that greeted them here, and neither was the word on the
// button inside that actually does it. All three read *Create team* now.
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
export default function MaterializeDialog({ bundle, onClose, onDone, onCreated, createdNotice = '' }) {
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
    <SidePanel open onClose={onClose} title={CREATE_TEAM_DIALOG_TITLE} width="520px">
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
        // #2053 AC12: this used to navigate away the instant the stream
        // completed, so nothing ever said what had happened — the draft row
        // stayed in **Drafts** looking untouched next to a new **Teams** row,
        // and a user could not tell whether it had worked or whether pressing
        // the button again was safe. The panel now stays on the result card,
        // which names the team, plus the notice the parent supplies, and the
        // navigation is an explicit click.
        onComplete={(result) => onCreated?.(result)}
        completionNotice={createdNotice}
        completionAction={(
          <button
            type="button"
            onClick={() => {
              onDone?.();
              navigate(`/process/${encodeURIComponent(values.teamId)}`);
            }}
            style={primaryAction}
          >{OPEN_TEAM_LABEL}</button>
        )}
        leftAction={<button type="button" onClick={onClose} style={ghost}>Cancel</button>}
      />
    </SidePanel>
  );
}

const primaryAction = {
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};

const ghost = {
  background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
