import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';

// Materialise an imported process-template bundle into a real team (#334).
// Reuses the Team-Setup pipeline (POST /api/teams) via its `processTemplate`
// path — team + members + rollback are all handled there. Instead of typing a
// repo URL + credentials, the operator picks an existing Working Environment,
// which already carries the repository and the SSH-key / GitHub-token split.
export default function MaterializeDialog({ bundle, onClose, onDone }) {
  const navigate = useNavigate();
  const [environments, setEnvironments] = useState([]);
  const [envsLoaded, setEnvsLoaded] = useState(false);
  const [environmentId, setEnvironmentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const slug = (bundle?.name || 'team').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
  // A draft opened from a live team (#348) remembers its origin so we can default
  // to extending it rather than creating a colliding new team.
  const sourceTeamId = bundle?.sourceTeamId || null;
  const [teamId, setTeamId] = useState(sourceTeamId || slug);
  const [teamName, setTeamName] = useState(bundle?.name || 'Team');
  const [extend, setExtend] = useState(!!sourceTeamId);
  // Default to deferred materialization: a process can have dozens of members,
  // and materializing each one clones the repo. Create them as stubs (shown in
  // the UI) and materialize on demand by enabling. Opt in to clone-now here.
  const [materializeNow, setMaterializeNow] = useState(false);

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
        if (preferred) setEnvironmentId(preferred.id);
      } catch (e) {
        if (alive) { setError(e.message); setEnvsLoaded(true); }
      }
    })();
    return () => { alive = false; };
  }, [sourceTeamId]);

  const selectedEnv = environments.find(e => e.id === environmentId) || null;
  const selectedRepo = selectedEnv
    ? ((Array.isArray(selectedEnv.repositories) ? selectedEnv.repositories[0] : selectedEnv.repository) || null)
    : null;
  const noEnvs = envsLoaded && environments.length === 0;

  function goCreateEnv() {
    onClose?.();
    navigate('/environments');
  }

  async function submit() {
    if (!/^[a-z0-9-]{1,40}$/.test(teamId)) { setError('teamId must be a lowercase slug [a-z0-9-], 1–40 chars.'); return; }
    if (!teamName.trim()) { setError('Team name required.'); return; }
    if (!environmentId) { setError('Pick a working environment.'); return; }
    setSaving(true); setError(null);
    try {
      await apiCall('POST', '/api/teams', {
        teamId, teamName,
        mode: extend ? 'extend' : 'create',
        environmentId,
        processTemplate: bundle,
        materializeMembers: materializeNow,
      });
      onDone?.();
      navigate(`/process/${encodeURIComponent(teamId)}`);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <SidePanel open onClose={onClose} title="Materialize as team" width="520px">
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 0 }}>
        Creates a team and one member per role in
        <strong> {bundle?.name}</strong> ({bundle?.roles?.length || 0} roles) on the selected
        working environment. Each role keeps its prompt and triggers;
        <code>{'{{vars}}'}</code> and the environment's repository are applied per member.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <Field label="Team id (slug)"><input value={teamId} onChange={e => setTeamId(e.target.value)} style={input} /></Field>
        <Field label="Team name"><input value={teamName} onChange={e => setTeamName(e.target.value)} style={input} /></Field>

        {noEnvs ? (
          <div style={emptyBox}>
            <span>
              No working environment exists yet. A team materialises onto an existing
              environment — it supplies the repository and the credentials (SSH key +
              GitHub token).
            </span>
            <button type="button" onClick={goCreateEnv} style={linkBtn}>
              Create a working environment →
            </button>
          </div>
        ) : (
          <Field label="Working environment">
            <select value={environmentId} onChange={e => setEnvironmentId(e.target.value)} style={input} disabled={!envsLoaded}>
              <option value="">— select —</option>
              {environments.map(env => (
                <option key={env.id} value={env.id}>{env.name || env.id}</option>
              ))}
            </select>
          </Field>
        )}

        {selectedRepo && (
          <div style={infoBox}>
            <div style={{ wordBreak: 'break-all' }}><strong>Repository:</strong> {selectedRepo.url}</div>
            <div><strong>Branch:</strong> {selectedRepo.branch || 'main'}</div>
          </div>
        )}
        {selectedEnv && !selectedRepo && (
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-warning, var(--eb-status-error))' }}>
            This environment has no repository configured — members will have nothing to clone.
          </span>
        )}
        {!noEnvs && (
          <button type="button" onClick={goCreateEnv} style={{ ...linkBtn, alignSelf: 'flex-start' }}>
            Need a different setup? Create a working environment →
          </button>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          <input type="checkbox" checked={extend} onChange={e => setExtend(e.target.checked)} />
          Add to an existing team (extend) — only the missing roles are created
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          <input type="checkbox" checked={materializeNow} onChange={e => setMaterializeNow(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Materialize agents now — clones the repo for every member immediately.
            Leave off to create them as stubs (shown in the team, no clone) and
            materialize each on demand by enabling it.
          </span>
        </label>

        {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={saving || !environmentId} style={primary}>
            {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            {saving ? (extend ? ' Extending…' : ' Creating…') : (extend ? 'Extend team' : (materializeNow ? 'Create team' : 'Create team (stubs)'))}
          </button>
        </div>
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </SidePanel>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}
const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
const emptyBox = {
  display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
  background: 'var(--eb-bg-app)', border: '1px dashed var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-3)',
  fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
};
const infoBox = {
  display: 'flex', flexDirection: 'column', gap: 2,
  background: 'var(--eb-bg-app)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
  fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
};
const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--eb-accent-primary)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
  textAlign: 'left', textDecoration: 'underline',
};
const ghost = {
  background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
const primary = {
  display: 'inline-flex', alignItems: 'center',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};
