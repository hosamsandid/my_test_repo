import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Check, AlertCircle, CheckCircle, Github,
  Compass, Code, Search, Shield, FlaskConical, Book, Tag, User,
  Loader2, Circle, XCircle,
  Network, ClipboardCheck, Gauge, Rocket, MessageCircle, TrendingUp,
} from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';

const ROLE_ICONS = {
  compass: Compass, code: Code, search: Search, shield: Shield,
  flask: FlaskConical, book: Book, tag: Tag,
  network: Network, 'clipboard-check': ClipboardCheck, gauge: Gauge,
  rocket: Rocket, 'message-circle': MessageCircle, 'trending-up': TrendingUp,
};

const inputStyle = {
  width: '100%',
  padding: 'var(--eb-space-3) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-md)',
  fontFamily: 'var(--eb-font-mono)',
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle = {
  display: 'block',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
  marginBottom: 'var(--eb-space-2)',
};

const hintStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  marginTop: 'var(--eb-space-2)',
  lineHeight: 1.5,
};

function Card({ children, accent }) {
  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: `1px solid ${accent || 'var(--eb-border-default)'}`,
      borderRadius: 'var(--eb-radius-lg)',
      padding: 'var(--eb-space-6)',
    }}>
      {children}
    </div>
  );
}

function ErrorBox({ message }) {
  if (!message) return null;
  return (
    <div style={{
      display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-status-error)',
      borderRadius: 'var(--eb-radius-md)',
      fontSize: 'var(--eb-text-sm)',
      color: 'var(--eb-text-primary)',
    }}>
      <AlertCircle size={16} style={{ color: 'var(--eb-status-error)', flexShrink: 0, marginTop: 2 }} />
      <div>{message}</div>
    </div>
  );
}

const STEPS = ['Project', 'Credentials', 'Team', 'Review'];

function StepIndicator({ current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
      {STEPS.map((label, idx) => {
        const done = idx < current;
        const active = idx === current;
        return (
          <React.Fragment key={label}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
              opacity: active || done ? 1 : 0.5,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: done
                  ? 'var(--eb-accent-primary)'
                  : active ? 'var(--eb-bg-elevated)' : 'transparent',
                border: `1px solid ${active || done ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: done ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)',
                fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
              }}>
                {done ? <Check size={14} /> : idx + 1}
              </div>
              <span style={{
                fontSize: 'var(--eb-text-sm)',
                fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
                color: 'var(--eb-text-primary)',
              }}>{label}</span>
            </div>
            {idx < STEPS.length - 1 && (
              <div style={{
                flex: '0 0 32px',
                height: 1,
                background: 'var(--eb-border-default)',
              }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// ─── Step 1 — Project ────────────────────────────────────────────────
function StepProject({ form, setForm, error }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <div>
          <label htmlFor="ts-team-name" style={labelStyle}>Team Name</label>
          <input
            id="ts-team-name"
            type="text"
            placeholder="e.g. Acme Demo"
            value={form.teamName}
            onChange={e => {
              const teamName = e.target.value;
              setForm(f => ({
                ...f,
                teamName,
                // Auto-derive slug while user hasn't manually edited it.
                teamId: f.teamIdManuallyEdited ? f.teamId : slugify(teamName),
              }));
            }}
            style={inputStyle}
            autoFocus
          />
          <div style={hintStyle}>Used as the prefix for all created resources and as the team identifier.</div>
        </div>

        <div>
          <label htmlFor="ts-team-id" style={labelStyle}>Team ID (slug)</label>
          <input
            id="ts-team-id"
            type="text"
            placeholder="acme-demo"
            value={form.teamId}
            onChange={e => setForm(f => ({ ...f, teamId: slugify(e.target.value), teamIdManuallyEdited: true }))}
            style={inputStyle}
          />
          <div style={hintStyle}>Lowercase, dashes only. 1–40 chars. Resources will be named <code>{form.teamId || '&lt;slug&gt;'}-developer</code>, etc.</div>
        </div>

        <div>
          <label htmlFor="ts-repo-url" style={labelStyle}>GitHub Repository URL</label>
          <div style={{ position: 'relative' }}>
            <Github size={18} style={{
              position: 'absolute', left: 'var(--eb-space-3)', top: '50%', transform: 'translateY(-50%)',
              color: 'var(--eb-text-muted)', pointerEvents: 'none',
            }} />
            <input
              id="ts-repo-url"
              type="text"
              placeholder="git@github.com:org/repo.git or https://github.com/org/repo"
              value={form.repoUrl}
              onChange={e => setForm(f => ({ ...f, repoUrl: e.target.value }))}
              style={{ ...inputStyle, paddingLeft: 'var(--eb-space-10)' }}
            />
          </div>
        </div>

        <div>
          <label htmlFor="ts-branch" style={labelStyle}>Branch</label>
          <input
            id="ts-branch"
            type="text"
            placeholder="main"
            value={form.branch}
            onChange={e => setForm(f => ({ ...f, branch: e.target.value }))}
            style={inputStyle}
          />
        </div>

        <ErrorBox message={error} />
      </div>
    </Card>
  );
}

// ─── Step 2 — Credentials ────────────────────────────────────────────
function CredentialPicker({ label, items, value, onChange, emptyHelp, generateLabel, onGenerate, generating, generateHint }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {items.length > 0 ? (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{ ...inputStyle, fontFamily: 'inherit' }}
        >
          <option value="">— pick —</option>
          {items.map(it => (
            <option key={it.id} value={it.id}>{it.name}{it.preview ? ` — ${it.preview}` : ''}{it.fingerprint ? ` (${it.fingerprint.slice(0, 16)})` : ''}</option>
          ))}
        </select>
      ) : (
        <div style={{ ...hintStyle, marginTop: 0 }}>{emptyHelp}</div>
      )}
      {onGenerate && (
        <div style={{ marginTop: 'var(--eb-space-2)' }}>
          <button
            type="button"
            disabled={generating}
            onClick={onGenerate}
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'transparent',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)',
              cursor: generating ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {generating ? 'Generating…' : generateLabel}
          </button>
          {generateHint && <span style={{ ...hintStyle, marginLeft: 'var(--eb-space-3)', display: 'inline' }}>{generateHint}</span>}
        </div>
      )}
    </div>
  );
}

function StepCredentials({ form, setForm, sshKeys, sshKeysLoading, githubTokens, tokensLoading, error, refetchKeys, refetchTokens }) {
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);

  async function generateKey() {
    setGenError(null);
    setGenerating(true);
    try {
      const name = form.teamName ? `${form.teamName} deploy key` : `${form.teamId}-deploy`;
      const r = await apiCall('POST', '/api/ssh-keys/generate', { name });
      await refetchKeys();
      setForm(f => ({ ...f, sshKeyId: r.id }));
    } catch (err) {
      setGenError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
        <CredentialPicker
          label="SSH Deploy Key"
          items={sshKeysLoading ? [] : (sshKeys || [])}
          value={form.sshKeyId}
          onChange={v => setForm(f => ({ ...f, sshKeyId: v }))}
          emptyHelp={
            <span>
              No SSH key configured. Generate one here, or create at{' '}
              <Link to="/ssh-keys" target="_blank" style={{ color: 'var(--eb-accent-primary)' }}>SSH Keys →</Link>
            </span>
          }
          generateLabel="Generate new SSH key"
          onGenerate={generateKey}
          generating={generating}
          generateHint="Creates a fresh ed25519 key pair. Add the public key as a deploy key on GitHub afterwards."
        />
        <ErrorBox message={genError} />

        <CredentialPicker
          label="GitHub Personal Access Token"
          items={tokensLoading ? [] : (githubTokens || [])}
          value={form.githubTokenId}
          onChange={v => setForm(f => ({ ...f, githubTokenId: v }))}
          emptyHelp={
            <span>
              No GitHub token configured. Add one at{' '}
              <Link to="/github-tokens" target="_blank" style={{ color: 'var(--eb-accent-primary)' }}>
                GitHub Tokens →
              </Link>{' '}
              and come back. Required scopes: <code>repo</code>, <code>issues:write</code> (for the BA + reviewers).
            </span>
          }
        />

        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)',
          border: '1px dashed var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          lineHeight: 1.6,
        }}>
          <strong>Why both?</strong> The SSH key clones the repo (per-repo, read-only deploy key works).
          The PAT runs <code>gh-as-agent</code> for PR/issue/comment actions. Splitting them is
          defense-in-depth — see the credential pages for details.
        </div>

        <ErrorBox message={error} />
      </div>
    </Card>
  );
}

// ─── Step 3 — Team composition ────────────────────────────────────────
function RoleCard({ template, selected, onToggle }) {
  const Icon = ROLE_ICONS[template.icon] || User;
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        textAlign: 'left',
        background: selected ? 'var(--eb-bg-surface)' : 'var(--eb-bg-app)',
        border: `2px solid ${selected ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-lg)',
        padding: 'var(--eb-space-4)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'var(--eb-text-primary)',
        display: 'flex',
        gap: 'var(--eb-space-3)',
        alignItems: 'flex-start',
        transition: 'border-color 0.1s',
      }}
    >
      <div style={{
        flexShrink: 0,
        width: 36, height: 36,
        borderRadius: 'var(--eb-radius-md)',
        background: selected ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
        color: selected ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={18} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--eb-space-2)' }}>
          <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)' }}>
            {template.displayName}
          </div>
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            fontFamily: 'var(--eb-font-mono)',
            flexShrink: 0,
          }}>
            {template.sessionPolicy === 'per-invocation' ? 'reactive' : 'chat'}
          </div>
        </div>
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 'var(--eb-space-1)', lineHeight: 1.4 }}>
          {template.description}
        </div>
        {template.triggerSummary && template.triggerSummary.length > 0 && (
          <div style={{
            marginTop: 'var(--eb-space-2)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)',
          }}>
            {template.triggerSummary.map(t => (
              <span key={t.id} style={{
                padding: '1px 6px',
                background: 'var(--eb-bg-elevated)',
                borderRadius: 'var(--eb-radius-sm)',
                fontFamily: 'var(--eb-font-mono)',
              }}>
                {t.type === 'cron' ? `cron ${t.cron}` : (t.events || []).join(', ')}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

// Roles that actually consume the ready-label (BA writes it, Developer
// and Quality Engineer react to it, Roadmap Reporter cites it as
// "waiting for a slot"). Other roles never see the label, so the input
// is pointless when the team has none of these. Keep this in sync with
// the `{{readyLabel}}` placeholders inside the role JSON files under
// orchestrator/skill-pool/agent-templates/.
const READY_LABEL_ROLES = new Set([
  'business-analyst', 'developer', 'quality-engineer', 'roadmap-reporter',
]);

function StepTeam({ form, setForm, templates, selectedRoles, setSelectedRoles, error }) {
  if (!templates) return <Card>Loading templates…</Card>;
  const showReadyLabel = selectedRoles.some(r => READY_LABEL_ROLES.has(r));
  return (
    <Card>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--eb-space-3)' }}>
        {templates.map(t => (
          <RoleCard
            key={t.id}
            template={t}
            selected={selectedRoles.includes(t.id)}
            onToggle={() => {
              setSelectedRoles(prev => prev.includes(t.id)
                ? prev.filter(x => x !== t.id)
                : [...prev, t.id]);
            }}
          />
        ))}
      </div>
      <div style={{ ...hintStyle, marginTop: 'var(--eb-space-4)' }}>
        Pick at least one role. Reactive roles (Code Reviewer, etc.) start fresh per trigger; the Business Analyst keeps a chat session.
      </div>

      {showReadyLabel && (
        <div style={{ marginTop: 'var(--eb-space-5)', paddingTop: 'var(--eb-space-4)', borderTop: '1px solid var(--eb-border-default)' }}>
          <label htmlFor="ts-ready-label" style={labelStyle}>Ready label</label>
          <input
            id="ts-ready-label"
            type="text"
            placeholder="ready"
            value={form.readyLabel}
            onChange={e => setForm(f => ({ ...f, readyLabel: e.target.value }))}
            style={inputStyle}
          />
          <div style={hintStyle}>
            GitHub issue label that triggers the Developer. The Business Analyst applies this label once the acceptance criteria are settled — the Developer only reacts to this exact label. Freely chosen (e.g. <code>ready</code>, <code>dev-ready</code>, <code>greenlight</code>).
          </div>
        </div>
      )}

      <ErrorBox message={error} />
    </Card>
  );
}

// ─── Step 4 — Review ─────────────────────────────────────────────────
function StepReview({ form, templates, sshKeys, githubTokens, error }) {
  const sshKey = sshKeys?.find(k => k.id === form.sshKeyId);
  const ghToken = githubTokens?.find(t => t.id === form.githubTokenId);
  const selected = (templates || []).filter(t => form.selectedRoles.includes(t.id));
  const showReadyLabel = form.selectedRoles.some(r => READY_LABEL_ROLES.has(r));
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <ReviewRow label="Team" value={`${form.teamName} (${form.teamId})`} />
        <ReviewRow label="Repository" value={`${form.repoUrl} @ ${form.branch || 'main'}`} />
        {showReadyLabel && <ReviewRow label="Ready label" value={form.readyLabel || 'ready'} />}
        <ReviewRow label="SSH Key" value={sshKey ? sshKey.name : '—'} />
        <ReviewRow label="GitHub Token" value={ghToken ? ghToken.name : '—'} />
        <div>
          <div style={labelStyle}>Roles ({selected.length})</div>
          <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
            {selected.map(t => (
              <li key={t.id}>
                <strong style={{ color: 'var(--eb-text-primary)' }}>{t.displayName}</strong>
                {' '}— agent <code>{form.teamId}-{t.id}</code>
              </li>
            ))}
          </ul>
        </div>
        <ErrorBox message={error} />
      </div>
    </Card>
  );
}

function ReviewRow({ label, value }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{
        fontSize: 'var(--eb-text-md)',
        color: 'var(--eb-text-primary)',
        fontFamily: 'var(--eb-font-mono)',
      }}>{value}</div>
    </div>
  );
}

// ─── Live progress card ──────────────────────────────────────────────
// Renders one row per planned step. Status comes from the streaming
// /api/teams/stream endpoint (one NDJSON event per status transition).
function spin() {
  // CSS animation defined inline so we don't have to touch tokens.css.
  return {
    animation: 'team-setup-spin 0.9s linear infinite',
  };
}

function StepIcon({ status }) {
  if (status === 'done') {
    return <CheckCircle size={16} style={{ color: 'var(--eb-status-success)', flexShrink: 0 }} />;
  }
  if (status === 'running') {
    return <Loader2 size={16} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0, ...spin() }} />;
  }
  if (status === 'error') {
    return <XCircle size={16} style={{ color: 'var(--eb-status-error)', flexShrink: 0 }} />;
  }
  return <Circle size={16} style={{ color: 'var(--eb-text-muted)', flexShrink: 0, opacity: 0.6 }} />;
}

function ProgressCard({ steps, error }) {
  const total = steps.length;
  const done = steps.filter(s => s.status === 'done').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <Card>
      <style>{`@keyframes team-setup-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--eb-space-3)' }}>
        <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
          Materializing team…
        </div>
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontFamily: 'var(--eb-font-mono)' }}>
          {done} / {total}
        </div>
      </div>
      <div style={{
        height: 6, borderRadius: 999, background: 'var(--eb-bg-elevated)',
        overflow: 'hidden', marginBottom: 'var(--eb-space-4)',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: error ? 'var(--eb-status-error)' : 'var(--eb-accent-primary)',
          transition: 'width 0.25s ease-out',
        }} />
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        {steps.map(s => (
          <li key={s.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
            fontSize: 'var(--eb-text-sm)',
            color: s.status === 'pending' ? 'var(--eb-text-muted)' : 'var(--eb-text-primary)',
          }}>
            <span style={{ marginTop: 2 }}>
              <StepIcon status={s.status} />
            </span>
            <span style={{ flex: 1, lineHeight: 1.4 }}>
              {s.label}
              {s.error && (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 2 }}>
                  {s.error}
                </div>
              )}
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <div style={{ marginTop: 'var(--eb-space-4)' }}>
          <ErrorBox message={error} />
        </div>
      )}
    </Card>
  );
}

// ─── Main wizard ─────────────────────────────────────────────────────
export default function TeamSetup() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [collisionInfo, setCollisionInfo] = useState(null);
  const [result, setResult] = useState(null);
  // Live progress from the streaming endpoint. `progressSteps` is the
  // ordered list announced by the server as a `plan` event; each later
  // `step` event flips one entry's status.
  const [progressSteps, setProgressSteps] = useState(null);
  const [progressError, setProgressError] = useState(null);

  const [form, setForm] = useState({
    teamName: '',
    teamId: '',
    teamIdManuallyEdited: false,
    repoUrl: '',
    branch: 'main',
    readyLabel: 'ready',
    sshKeyId: '',
    githubTokenId: '',
    selectedRoles: [],
  });

  const { data: templatesResp, loading: tplLoading } = useApi('/api/agent-templates');
  const { data: sshKeys, loading: keysLoading, refetch: refetchKeys } = useApi('/api/ssh-keys');
  const { data: githubTokens, loading: tokensLoading, refetch: refetchTokens } = useApi('/api/github-tokens');

  const templates = templatesResp?.templates || null;

  // Pre-select all templates the first time the catalog loads.
  useEffect(() => {
    if (templates && form.selectedRoles.length === 0) {
      setForm(f => ({ ...f, selectedRoles: templates.map(t => t.id) }));
    }
  }, [templates]); // eslint-disable-line react-hooks/exhaustive-deps

  function validateStep() {
    if (step === 0) {
      if (!form.teamName.trim()) return 'Team name required';
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(form.teamId)) return 'Team ID must be 1–40 chars, [a-z0-9-]';
      if (!form.repoUrl.trim()) return 'Repository URL required';
      return null;
    }
    if (step === 1) {
      if (!form.sshKeyId) return 'SSH key required';
      if (!form.githubTokenId) return 'GitHub token required';
      return null;
    }
    if (step === 2) {
      if (form.selectedRoles.length === 0) return 'Pick at least one role';
      return null;
    }
    return null;
  }

  function next() {
    const err = validateStep();
    if (err) { setStepError(err); return; }
    setStepError(null);
    setStep(s => Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStepError(null);
    setCollisionInfo(null);
    setStep(s => Math.max(s - 1, 0));
  }

  // Land on the Business Analyst chat when it was created, else the first
  // created agent. Falls through to /agents if nothing was created (extend
  // mode with no missing roles).
  function landingAgent(created) {
    const ba = (created || []).find(id => id.endsWith('-business-analyst'));
    return ba || (created || [])[0] || null;
  }

  async function submit(mode = 'create') {
    setStepError(null);
    setCollisionInfo(null);
    setProgressError(null);
    setProgressSteps(null);
    setSubmitting(true);

    const body = {
      teamId: form.teamId,
      teamName: form.teamName.trim(),
      repository: { url: form.repoUrl.trim(), branch: form.branch.trim() || 'main', sshKeyId: form.sshKeyId },
      githubTokenId: form.githubTokenId,
      readyLabel: (form.readyLabel || 'ready').trim() || 'ready',
      roles: form.selectedRoles,
      mode,
    };

    let res;
    try {
      res = await fetch('/api/teams/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      setStepError(err.message || String(err));
      setSubmitting(false);
      return;
    }

    if (!res.ok && !res.body) {
      const data = await res.json().catch(() => ({}));
      setStepError(data.error || `HTTP ${res.status}`);
      setSubmitting(false);
      return;
    }

    // NDJSON stream: split on newlines, ignore blank/partial lines.
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    const handleEvent = (ev) => {
      if (ev.type === 'plan') {
        setProgressSteps(ev.steps.map(s => ({ ...s, status: 'pending' })));
      } else if (ev.type === 'step') {
        setProgressSteps(prev => prev
          ? prev.map(s => s.id === ev.id ? { ...s, status: ev.status, error: ev.error || s.error } : s)
          : prev);
      } else if (ev.type === 'collision') {
        setCollisionInfo({ existing: ev.existing, suggestion: ev.suggestion });
      } else if (ev.type === 'complete') {
        setResult(ev.result);
        const land = landingAgent(ev.result?.created);
        setTimeout(() => {
          if (land) navigate(`/chats/${land}`);
          else navigate('/agents');
        }, 1500);
      } else if (ev.type === 'error') {
        // Backend already marked any in-flight step as `error`; surface the
        // top-level message in the progress card and as the form-level error
        // so users see it whether or not the plan was rendered.
        setProgressError(ev.error || `HTTP ${ev.status || 500}`);
        setStepError(ev.error || `HTTP ${ev.status || 500}`);
      }
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { handleEvent(JSON.parse(line)); }
          catch (e) { console.warn('[TeamSetup] bad NDJSON line:', line, e); }
        }
      }
      // Flush any trailing partial line (defensive — server always closes
      // with a newline, but a dropped connection mid-line shouldn't crash).
      const tail = buf.trim();
      if (tail) {
        try { handleEvent(JSON.parse(tail)); } catch { /* ignore */ }
      }
    } catch (err) {
      setProgressError(err.message || String(err));
      setStepError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const stepProps = { form, setForm };
  const isLast = step === STEPS.length - 1;

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
      <div>
        <h1 style={{
          fontSize: 'var(--eb-text-2xl)',
          fontWeight: 'var(--eb-font-semibold)',
          margin: 0,
          color: 'var(--eb-text-primary)',
        }}>Team Setup</h1>
        <p style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-secondary)',
          marginTop: 'var(--eb-space-2)',
          marginBottom: 0,
        }}>
          Spin up a complete agent team — Business Analyst, Developer, Reviewers, and more — bound to one repository, in one shot.
        </p>
      </div>

      <StepIndicator current={step} />

      {step === 0 && <StepProject {...stepProps} error={stepError} />}
      {step === 1 && (
        <StepCredentials
          {...stepProps}
          sshKeys={sshKeys}
          sshKeysLoading={keysLoading}
          githubTokens={githubTokens}
          tokensLoading={tokensLoading}
          error={stepError}
          refetchKeys={refetchKeys}
          refetchTokens={refetchTokens}
        />
      )}
      {step === 2 && (
        <StepTeam
          form={form}
          setForm={setForm}
          templates={templates}
          selectedRoles={form.selectedRoles}
          setSelectedRoles={fn => setForm(f => ({ ...f, selectedRoles: typeof fn === 'function' ? fn(f.selectedRoles) : fn }))}
          error={stepError}
        />
      )}
      {step === 3 && (
        <StepReview
          form={form}
          templates={templates}
          sshKeys={sshKeys}
          githubTokens={githubTokens}
          error={stepError}
        />
      )}

      {progressSteps && !result && (
        <ProgressCard steps={progressSteps} error={progressError} />
      )}

      {collisionInfo && (
        <Card accent="var(--eb-status-warning)">
          <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-2)' }}>
            Some resources for team <code>{form.teamId}</code> already exist.
          </div>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-3)' }}>
            {collisionInfo.existing?.env && <>Env: <code>{collisionInfo.existing.env}</code><br /></>}
            {collisionInfo.existing?.team && <>Team: <code>{collisionInfo.existing.team}</code><br /></>}
            {collisionInfo.existing?.members?.length > 0 && <>Members: {collisionInfo.existing.members.join(', ')}</>}
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <button type="button" onClick={() => submit('extend')}
              disabled={submitting}
              style={primaryButtonStyle(submitting)}>
              {submitting ? 'Adding…' : 'Add missing roles'}
            </button>
            <button type="button" onClick={() => setCollisionInfo(null)}
              style={secondaryButtonStyle()}>Cancel</button>
          </div>
        </Card>
      )}

      {result && (
        <Card accent="var(--eb-status-success)">
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
            <CheckCircle size={20} style={{ color: 'var(--eb-status-success)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
                {result.message
                  ? `Team ${result.teamName}: ${result.message}`
                  : `Team ${result.teamName} ready — ${result.created?.length || 0} agent(s) created.`}
              </div>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 4 }}>
                {landingAgent(result.created) ? 'Redirecting to chat…' : 'Redirecting to Agents page…'}
              </div>
            </div>
          </div>
        </Card>
      )}

      {!result && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--eb-space-3)' }}>
          <button
            type="button"
            onClick={back}
            disabled={step === 0 || submitting}
            style={{
              ...secondaryButtonStyle(),
              opacity: step === 0 || submitting ? 0.4 : 1,
              cursor: step === 0 || submitting ? 'not-allowed' : 'pointer',
            }}
          >
            <ArrowLeft size={16} /> Back
          </button>

          {!isLast && (
            <button type="button" onClick={next} disabled={tplLoading || submitting} style={primaryButtonStyle(submitting || tplLoading)}>
              Next <ArrowRight size={16} />
            </button>
          )}
          {isLast && (
            <button type="button" onClick={() => submit('create')} disabled={submitting} style={primaryButtonStyle(submitting)}>
              {submitting ? 'Creating team…' : 'Create team'}
              {!submitting && <ArrowRight size={16} />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function primaryButtonStyle(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
    padding: 'var(--eb-space-3) var(--eb-space-4)',
    background: 'var(--eb-accent-primary)',
    color: 'var(--eb-text-inverted)',
    border: 'none',
    borderRadius: 'var(--eb-radius-md)',
    fontSize: 'var(--eb-text-md)',
    fontWeight: 'var(--eb-font-medium)',
    fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
function secondaryButtonStyle() {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
    padding: 'var(--eb-space-3) var(--eb-space-4)',
    background: 'transparent',
    color: 'var(--eb-text-primary)',
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)',
    fontSize: 'var(--eb-text-md)',
    fontWeight: 'var(--eb-font-medium)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  };
}
