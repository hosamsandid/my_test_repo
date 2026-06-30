import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';

// Materialise an imported process-template bundle into a real team (#334).
// Reuses the Team-Setup pipeline (POST /api/teams) via its `processTemplate`
// path — env + team + members + rollback are all handled there.
export default function MaterializeDialog({ bundle, onClose, onDone }) {
  const navigate = useNavigate();
  const [sshKeys, setSshKeys] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const slug = (bundle?.name || 'team').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
  // A draft opened from a live team (#348) remembers its origin so we can default
  // to extending it rather than creating a colliding new team.
  const sourceTeamId = bundle?.sourceTeamId || null;
  const [teamId, setTeamId] = useState(sourceTeamId || slug);
  const [teamName, setTeamName] = useState(bundle?.name || 'Team');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [sshKeyId, setSshKeyId] = useState('');
  const [githubTokenId, setGithubTokenId] = useState('');
  const [extend, setExtend] = useState(!!sourceTeamId);
  // Default to deferred materialization: a process can have dozens of members,
  // and materializing each one clones the repo. Create them as stubs (shown in
  // the UI) and materialize on demand by enabling. Opt in to clone-now here.
  const [materializeNow, setMaterializeNow] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [keys, toks] = await Promise.all([
          apiCall('GET', '/api/ssh-keys').catch(() => []),
          apiCall('GET', '/api/github-tokens').catch(() => []),
        ]);
        if (!alive) return;
        const kl = Array.isArray(keys) ? keys : (keys?.keys || []);
        const tl = Array.isArray(toks) ? toks : (toks?.tokens || []);
        setSshKeys(kl); setTokens(tl);
        if (kl[0]) setSshKeyId(kl[0].id);
        if (tl[0]) setGithubTokenId(tl[0].id);
      } catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, []);

  async function submit() {
    if (!/^[a-z0-9-]{1,40}$/.test(teamId)) { setError('teamId must be a lowercase slug [a-z0-9-], 1–40 chars.'); return; }
    if (!teamName.trim()) { setError('Team name required.'); return; }
    if (!repoUrl.trim()) { setError('Repository URL required.'); return; }
    if (!sshKeyId) { setError('Pick an SSH key.'); return; }
    if (!githubTokenId) { setError('Pick a GitHub token.'); return; }
    setSaving(true); setError(null);
    try {
      await apiCall('POST', '/api/teams', {
        teamId, teamName,
        mode: extend ? 'extend' : 'create',
        repository: { url: repoUrl.trim(), branch: branch.trim() || 'main', sshKeyId },
        githubTokenId,
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
        Creates a working environment, a team, and one member per role in
        <strong> {bundle?.name}</strong> ({bundle?.roles?.length || 0} roles). Each role keeps its
        prompt and triggers; <code>{'{{vars}}'}</code> and the repo are applied per member.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <Field label="Team id (slug)"><input value={teamId} onChange={e => setTeamId(e.target.value)} style={input} /></Field>
        <Field label="Team name"><input value={teamName} onChange={e => setTeamName(e.target.value)} style={input} /></Field>
        <Field label="Repository URL"><input value={repoUrl} onChange={e => setRepoUrl(e.target.value)} placeholder="git@github.com:org/repo.git" style={input} /></Field>
        <Field label="Branch"><input value={branch} onChange={e => setBranch(e.target.value)} style={input} /></Field>
        <Field label="SSH key">
          <select value={sshKeyId} onChange={e => setSshKeyId(e.target.value)} style={input}>
            <option value="">— select —</option>
            {sshKeys.map(k => <option key={k.id} value={k.id}>{k.name || k.id}</option>)}
          </select>
        </Field>
        <Field label="GitHub token">
          <select value={githubTokenId} onChange={e => setGithubTokenId(e.target.value)} style={input}>
            <option value="">— select —</option>
            {tokens.map(t => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
          </select>
        </Field>

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
          <button onClick={submit} disabled={saving} style={primary}>
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
const ghost = {
  background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
const primary = {
  display: 'inline-flex', alignItems: 'center',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};
