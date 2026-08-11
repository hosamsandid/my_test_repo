import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Loader2, RefreshCw } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';
import { describeMaterializeError } from './materialize-error.js';

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
  // Optional secondary line (e.g. the raw "HTTP 502") kept for support/debugging
  // when the primary message is a generated, human-readable explanation (#1552).
  const [errorDetail, setErrorDetail] = useState(null);

  // Validation failures are plain, already-actionable strings — set them
  // directly and clear any leftover secondary detail.
  function setValidationError(msg) { setError(msg); setErrorDetail(null); }

  // A draft opened from a live team (#348) remembers its origin so we can default
  // to extending it rather than creating a colliding new team.
  const sourceTeamId = bundle?.sourceTeamId || null;
  const [teamName, setTeamName] = useState(bundle?.name || 'Team');
  const [teamId, setTeamId] = useState(sourceTeamId || slugify(bundle?.name || 'team'));
  // The slug auto-derives from the team name (consistent with the Team-Setup
  // wizard) until the operator edits it by hand. A slug carried over from a
  // source team is treated as already manual so we don't clobber it.
  const [teamIdManuallyEdited, setTeamIdManuallyEdited] = useState(!!sourceTeamId);
  const [extend, setExtend] = useState(!!sourceTeamId);
  // Default to deferred materialization: a process can have dozens of members,
  // and materializing each one clones the repo. Create them as stubs (shown in
  // the UI) and materialize on demand by enabling. Opt in to clone-now here.
  const [materializeNow, setMaterializeNow] = useState(false);
  const [labelSuffix, setLabelSuffix] = useState('');
  const [suffixWarnings, setSuffixWarnings] = useState([]);
  const [suggestingLabel, setSuggestingLabel] = useState(false);

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
        if (alive) {
          const { message, detail } = describeMaterializeError(e, { action: 'load the working environments' });
          setError(message); setErrorDetail(detail); setEnvsLoaded(true);
        }
      }
    })();
    return () => { alive = false; };
  }, [sourceTeamId]);

  const selectedEnv = environments.find(e => e.id === environmentId) || null;
  // A working environment carries a `repositories: [...]` array (legacy single
  // `repository` values are migrated to a one-element array on read by the API).
  // Show every repo so the operator can confirm all of them will be cloned —
  // not just the first (#1551).
  const selectedRepos = selectedEnv
    ? (Array.isArray(selectedEnv.repositories)
        ? selectedEnv.repositories
        : (selectedEnv.repository ? [selectedEnv.repository] : [])
      ).filter(r => r && r.url)
    : [];
  const noEnvs = envsLoaded && environments.length === 0;

  function goCreateEnv() {
    onClose?.();
    navigate('/environments');
  }

  async function submit() {
    if (!/^[a-z0-9-]{1,40}$/.test(teamId)) { setValidationError('teamId must be a lowercase slug [a-z0-9-], 1–40 chars.'); return; }
    if (!teamName.trim()) { setValidationError('Team name required.'); return; }
    if (!environmentId) { setValidationError('Pick a working environment.'); return; }
    if (labelSuffix && !/^[a-z0-9]{1,8}$/.test(labelSuffix)) { setValidationError('Label suffix must be 1–8 lowercase base36 chars [a-z0-9].'); return; }
    setSaving(true); setError(null); setErrorDetail(null); setSuffixWarnings([]);
    try {
      const result = await apiCall('POST', '/api/teams', {
        teamId, teamName,
        mode: extend ? 'extend' : 'create',
        environmentId,
        processTemplate: bundle,
        materializeMembers: materializeNow,
        ...(labelSuffix ? { labelSuffix } : {}),
      });
      if (result?.warnings?.length) setSuffixWarnings(result.warnings);
      onDone?.();
      navigate(`/process/${encodeURIComponent(teamId)}`);
    } catch (e) {
      // A failed materialization must read as a human-readable, actionable
      // message — not a bare "HTTP 502" — and leave the dialog re-submittable
      // (AC1–AC5, #1552).
      const { message, detail } = describeMaterializeError(e, {
        action: extend ? 'extend the team' : 'create the team',
      });
      setError(message); setErrorDetail(detail);
      setSaving(false);
    }
  }

  return (
    <SidePanel open onClose={onClose} title="Materialize as team" width="520px">
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 0 }}>
        Creates a team and one member per agent in
        <strong> {bundle?.name}</strong> ({bundle?.roles?.length || 0} agents) on the selected
        working environment. Each agent keeps its prompt and triggers;
        <code>{'{{vars}}'}</code> and the environment's repositories are applied per member.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <Field label="Team name">
          <input
            value={teamName}
            onChange={e => {
              const next = e.target.value;
              setTeamName(next);
              if (!teamIdManuallyEdited) setTeamId(slugify(next));
            }}
            style={input}
          />
        </Field>
        <Field label="Team id (slug)" hint="Auto-generated from the name; edit to override.">
          <input
            value={teamId}
            onChange={e => { setTeamId(slugify(e.target.value)); setTeamIdManuallyEdited(true); }}
            style={input}
          />
        </Field>
        <Field
          label={<>Label suffix <span style={{ fontWeight: 'normal', opacity: 0.7 }}>(optional)</span></>}
          hint="Appended to every label — isolates parallel stacks on one repo. Leave blank for the template's default names."
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={labelSuffix}
              maxLength={8}
              placeholder="e.g. k3f9"
              onChange={e => setLabelSuffix(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
              style={{ ...input, flex: 1 }}
            />
            <button
              type="button"
              disabled={suggestingLabel}
              onClick={async () => {
                setSuggestingLabel(true);
                try {
                  const r = await fetch('/api/teams/suggest-suffix');
                  if (r.ok) { const { suffix } = await r.json(); setLabelSuffix(suffix); }
                } catch { /* ignore */ } finally { setSuggestingLabel(false); }
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                ...input, width: 'auto', padding: '0 10px',
                cursor: suggestingLabel ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
              }}
              title="Suggest a random 4-char suffix"
            >
              <RefreshCw size={12} style={suggestingLabel ? { animation: 'spin 0.9s linear infinite' } : {}} />
              Suggest
            </button>
          </div>
        </Field>

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

        {selectedRepos.length > 0 && (
          <div style={{ ...infoBox, maxHeight: 220, overflowY: 'auto' }}>
            {selectedRepos.map((repo, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 2,
                  ...(i > 0 ? { marginTop: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-2)', borderTop: '1px solid var(--eb-border-default)' } : {}),
                }}
              >
                <div style={{ wordBreak: 'break-all' }}><strong>Repository:</strong> {repo.url}</div>
                <div><strong>Branch:</strong> {repo.branch || 'main'}</div>
              </div>
            ))}
          </div>
        )}
        {selectedEnv && selectedRepos.length === 0 && (
          <div style={{ ...infoBox, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
            This environment has no repository — the team will run without one. Its
            agents can still chat and use their skills, but GitHub hand-offs (PR /
            issue channels) won't be available.
          </div>
        )}
        {!noEnvs && (
          <button type="button" onClick={goCreateEnv} style={{ ...linkBtn, alignSelf: 'flex-start' }}>
            Need a different setup? Create a working environment →
          </button>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          <input type="checkbox" checked={extend} onChange={e => setExtend(e.target.checked)} />
          Add to an existing team (extend) — only the missing agents are created
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          <input type="checkbox" checked={materializeNow} onChange={e => setMaterializeNow(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Materialize agents now — clones the repo for every member immediately.
            Leave off to create them as stubs (shown in the team, no clone) and
            materialize each on demand by enabling it.
          </span>
        </label>

        {error && (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
            {error}
            {errorDetail && (
              <span style={{ marginLeft: 6, color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>({errorDetail})</span>
            )}
          </div>
        )}
        {suffixWarnings.length > 0 && (
          <div style={{ background: 'var(--eb-bg-app)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
            <strong style={{ color: 'var(--eb-text-primary)' }}>Label suffix warnings</strong>
            <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px' }}>
              {suffixWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

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

// Mirror the Team-Setup wizard's slug rules so both entry points agree.
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{hint}</span>}
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
