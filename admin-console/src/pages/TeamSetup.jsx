import React, { useState, useMemo } from 'react';
import { useNavigate, Link } from 'react-router';
import {
  ArrowLeft, ArrowRight, Check, AlertCircle, CheckCircle, Github,
  Loader2, Circle, XCircle,
  Layers, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import SkillPicker from '../components/SkillPicker';
import KnowledgeLearningSections, {
  KNOWLEDGE_LEARNING_DEFAULTS, AUTONOMY_LEVELS, GATE_ORDER, GATE_LABELS,
} from '../components/KnowledgeLearningConfig';
import StepProcess, { BundleRolesSummary, BundleFlowPreview, LintBadges } from './team-setup/StepProcess';
import { buildReviewFields } from './team-setup/review-fields';

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

const diagramLinkButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-surface)',
  color: 'var(--eb-accent-primary)',
  border: '1px solid var(--eb-accent-primary)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
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

// Process first (#428): the process choice is the entry decision — everything
// else (environment, name, knowledge) qualifies it. As step 1, "Start blank in
// the canvas" exits without losing any entered configuration.
const STEPS = ['Process', 'Working Environment', 'Team', 'Knowledge (optional)', 'Review'];

function StepIndicator({ current, onStepClick }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
      {STEPS.map((label, idx) => {
        const done = idx < current;
        const active = idx === current;
        const clickable = !!onStepClick;
        return (
          <React.Fragment key={label}>
            <div
              onClick={clickable ? () => onStepClick(idx) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onStepClick(idx); } } : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                opacity: active || done ? 1 : 0.5,
                cursor: clickable ? 'pointer' : 'default',
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

// Suggest a team name + id derived from a Working Environment's name, made
// unique against every existing agent id (the teamId doubles as the team
// agent's id) and every existing team display name. "Acme" taken → "Acme 2" /
// "acme-2", and so on. The user can still edit both fields afterwards.
function suggestTeamNaming(envName, agents) {
  const list = Array.isArray(agents) ? agents : [];
  const takenIds = new Set(list.map(a => a.id));
  const takenNames = new Set(
    list.filter(a => a.role === 'team').map(a => String(a.displayName || '').trim().toLowerCase()),
  );
  const baseName = String(envName || '').trim() || 'Team';
  const baseSlug = slugify(baseName) || 'team';
  const free = (name, slug) => !!slug && !takenIds.has(slug) && !takenNames.has(name.toLowerCase());
  if (free(baseName, baseSlug)) return { teamName: baseName, teamId: baseSlug };
  for (let n = 2; n < 100; n++) {
    const name = `${baseName} ${n}`;
    const suffix = `-${n}`;
    const slug = baseSlug.slice(0, 40 - suffix.length) + suffix;
    if (free(name, slug)) return { teamName: name, teamId: slug };
  }
  return { teamName: baseName, teamId: baseSlug };
}

function SuggestSuffixButton({ onSuggest }) {
  const [busy, setBusy] = useState(false);
  async function suggest() {
    setBusy(true);
    try {
      const r = await fetch('/api/teams/suggest-suffix');
      if (r.ok) { const { suffix } = await r.json(); onSuggest(suffix); }
    } catch { /* ignore */ } finally { setBusy(false); }
  }
  return (
    <button
      type="button"
      title="Suggest a random 4-char suffix"
      onClick={suggest}
      disabled={busy}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)', padding: '0 var(--eb-space-3)',
        color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)',
        cursor: busy ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        fontFamily: 'inherit', height: '100%',
      }}
    >
      <RefreshCw size={13} style={busy ? { animation: 'team-setup-spin 0.9s linear infinite' } : {}} />
      Suggest
    </button>
  );
}

// ─── Step 3 — Team basics (name + id only) ────────────────────────────
// Comes after the Working-Environment pick so both fields can be pre-filled
// from the environment's name (with a uniqueness-resolving suggestion). The
// user may change them, but doesn't have to.
function StepProject({ form, setForm, environments, takenAgentIds, error }) {
  const env = (environments || []).find(e => e.id === form.environmentId);
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
                teamNameManuallyEdited: true,
                // Auto-derive slug while user hasn't manually edited it.
                teamId: f.teamIdManuallyEdited ? f.teamId : slugify(teamName),
              }));
            }}
            style={inputStyle}
            autoFocus
          />
          <div style={hintStyle}>
            {env && !form.teamNameManuallyEdited
              ? <>Suggested from the working environment <strong>{env.name}</strong> — change it if you like.</>
              : <>Used as the prefix for all created resources and as the team identifier.</>}
          </div>
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
          <div style={hintStyle}>Lowercase, dashes only. 1–40 chars. Resources will be named <code>{form.teamId || '<slug>'}-developer</code>, etc.</div>
          {takenAgentIds?.has(form.teamId) && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 'var(--eb-space-2)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
              <AlertCircle size={12} /> This ID is already used by an existing agent or team — pick a different one.
            </div>
          )}
        </div>

        <div>
          <label htmlFor="ts-label-suffix" style={labelStyle}>
            Label suffix <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)' }}>(optional)</span>
          </label>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', height: 38 }}>
            <input
              id="ts-label-suffix"
              type="text"
              placeholder="e.g. k3f9"
              value={form.labelSuffix}
              maxLength={8}
              onChange={e => setForm(f => ({ ...f, labelSuffix: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') }))}
              style={{ ...inputStyle, flex: 1 }}
            />
            <SuggestSuffixButton onSuggest={suffix => setForm(f => ({ ...f, labelSuffix: suffix }))} />
          </div>
          <div style={hintStyle}>
            <strong>Leave this blank</strong> unless another agent team already uses the <strong>same GitHub repo</strong>. In that case, a short suffix is added to every label this team uses so the two teams&apos; issue/PR labels don&apos;t wake each other&apos;s agents.
          </div>
        </div>

        <ErrorBox message={error} />
      </div>
    </Card>
  );
}

// ─── Step 2 — Working Environment (pick an existing one) ─────────────
// The wizard no longer assembles an environment from raw credentials + repo
// URL — a Working Environment already bundles repository, credentials,
// skills and knowledge sources. The team is materialised onto the selected
// environment (POST /api/teams `environmentId`), which resolves everything
// else server-side. Environments without a repository can't host a team,
// so their cards are shown but not selectable.
function envRepositories(env) {
  if (Array.isArray(env?.repositories)) return env.repositories.filter(r => r?.url);
  if (env?.repository?.url) return [env.repository];
  return [];
}

function EnvironmentCard({ env, selected, onSelect }) {
  const repos = envRepositories(env);
  const selectable = repos.length > 0;
  return (
    <div
      onClick={selectable ? onSelect : undefined}
      role="radio"
      aria-checked={selected}
      aria-disabled={!selectable}
      tabIndex={selectable ? 0 : -1}
      onKeyDown={selectable ? (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect(); } } : undefined}
      style={{
        textAlign: 'left',
        background: selected ? 'var(--eb-bg-surface)' : 'var(--eb-bg-app)',
        border: `2px solid ${selected ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-lg)',
        padding: 'var(--eb-space-4)',
        cursor: selectable ? 'pointer' : 'not-allowed',
        opacity: selectable ? 1 : 0.55,
        fontFamily: 'inherit',
        color: 'var(--eb-text-primary)',
        display: 'flex',
        gap: 'var(--eb-space-3)',
        alignItems: 'flex-start',
        transition: 'border-color 0.1s',
        userSelect: 'none',
      }}
    >
      <div style={{
        flexShrink: 0, width: 36, height: 36,
        borderRadius: 'var(--eb-radius-md)',
        background: selected ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
        color: selected ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Layers size={18} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--eb-space-2)' }}>
          <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)' }}>
            {env.name}
          </div>
          <code style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>
            {env.id}
          </code>
        </div>
        {env.description && (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 'var(--eb-space-1)', lineHeight: 1.4 }}>
            {env.description}
          </div>
        )}
        <div style={{ marginTop: 'var(--eb-space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          {repos.length > 0 ? repos.map(r => (
            <div key={r.url} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
              <Github size={12} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
              <span style={{ fontFamily: 'var(--eb-font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {repoSlug(r.url) || r.url}{r.branch ? ` @ ${r.branch}` : ''}
              </span>
            </div>
          )) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-status-warning)' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} />
              No repository configured — a team needs one. Add it under Working Environments.
            </div>
          )}
          {repos.length > 0 && !env.githubTokenId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-status-warning)' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} />
              No GitHub token — agents reacting to issues / PRs won&apos;t trigger.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepEnvironmentSelect({ form, environments, envsLoading, refetchEnvs, onSelect, error }) {
  const envs = environments || [];
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <div style={{
          padding: 'var(--eb-space-3) var(--eb-space-4)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-secondary)',
          lineHeight: 1.6,
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <p style={{ margin: 0 }}>
            Sets up a coordinated team of agents — Business Analyst, Developer, Code Reviewer, and more — all
            wired to one GitHub repository and ready to react to issues and pull requests automatically.
          </p>
          <p style={{ margin: 0, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Pick the <strong style={{ color: 'var(--eb-text-secondary)' }}>Working Environment</strong> the team
            works in — it already bundles the repository, credentials and knowledge sources.
          </p>
        </div>

        {envsLoading ? (
          <div style={{ ...hintStyle, marginTop: 0 }}>Loading working environments…</div>
        ) : envs.length === 0 ? (
          <div style={{
            padding: 'var(--eb-space-5)',
            border: '1px dashed var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
            alignItems: 'flex-start',
            fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6,
          }}>
            <div>
              No working environment exists yet. Create one first — with the repository the team should work
              on — then come back here.
            </div>
            <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'center' }}>
              <Link to="/environments" target="_blank" style={{ ...diagramLinkButtonStyle, textDecoration: 'none' }}>
                <Layers size={14} /> Open Working Environments
              </Link>
              <button type="button" onClick={refetchEnvs} style={secondaryButtonStyle()}>
                Refresh list
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--eb-space-3)' }} role="radiogroup" aria-label="Working Environment">
              {envs.map(env => (
                <EnvironmentCard
                  key={env.id}
                  env={env}
                  selected={form.environmentId === env.id}
                  onSelect={() => onSelect(env)}
                />
              ))}
            </div>
            <div style={{ ...hintStyle, marginTop: 0 }}>
              Missing one, or need to adjust repositories? Manage them at{' '}
              <Link to="/environments" target="_blank" style={{ color: 'var(--eb-accent-primary)' }}>Working Environments →</Link>
              {' '}<button
                type="button"
                onClick={refetchEnvs}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: 'var(--eb-accent-primary)', fontSize: 'inherit', fontFamily: 'inherit',
                  textDecoration: 'underline',
                }}
              >Refresh list</button>
            </div>
          </>
        )}

        <ErrorBox message={error} />
      </div>
    </Card>
  );
}

// ─── Step 4 — Knowledge sources (inherited from the environment) ─────
// With the wizard reusing an existing Working Environment, the MCP set is
// defined there — POST /api/teams resolves it from `environmentId`, so an
// editable selection here would be silently ignored. Show the inherited
// set read-only and point to the environment editor for changes. The step
// is optional — nothing here blocks continuing to Review.
function StepKnowledgeSummary({ form, setForm, poolSkills, environments, mcpServers, mcpCredentials, error }) {
  const env = (environments || []).find(e => e.id === form.environmentId);
  const knowledge = (form.mcpSelections || []).filter(s => s.serverId);
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <div>
          <div style={labelStyle}>Initial team skills ({(form.skills || []).length})</div>
          <div style={{ ...hintStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
            Skills from the global pool the whole team starts with — placed on the team agent, so every member
            inherits them unless it overrides. Only global skills are offered here because the team's own
            skill pool does not exist yet; a team-tier pool appears once the team is created, and you can then
            grant from it on the team's card on the Agents page.
          </div>
          <SkillPicker
            skills={poolSkills || []}
            selected={form.skills || []}
            onChange={v => setForm(f => ({ ...f, skills: v }))}
          />
        </div>
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
          Knowledge sources are MCP servers the team can query at runtime — wiki, vector store, graph DB, etc.
          They are inherited from the working environment{env ? <> <strong style={{ color: 'var(--eb-text-primary)' }}>{env.name}</strong></> : null}.
          To change them, edit the environment at{' '}
          <Link to="/environments" target="_blank" style={{ color: 'var(--eb-accent-primary)' }}>Working Environments →</Link>
          {' '}— per-member overrides come later via the agent edit form.
          {' '}<strong style={{ color: 'var(--eb-text-primary)' }}>This step is optional</strong> — if the inherited set looks right (or the team needs none), just continue.
        </div>
        <div>
          <div style={labelStyle}>Knowledge sources ({knowledge.length})</div>
          {knowledge.length === 0 ? (
            <div style={{ ...hintStyle, marginTop: 0 }}>None — the environment defines no MCP servers.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
              {knowledge.map(k => {
                const srv = (mcpServers || []).find(s => s.id === k.serverId);
                const cred = (mcpCredentials || []).find(c => c.id === k.credentialId);
                return (
                  <li key={k.serverId}>
                    <strong style={{ color: 'var(--eb-text-primary)' }}>{srv?.name || k.serverId}</strong>
                    {' '}— credential {cred ? cred.name : '—'}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Knowledge learning configuration (#567) — same sections/copy/controls
            as the Knowledge page panel (#566), pre-filled with today's defaults. */}
        <div>
          <div style={labelStyle}>How this team learns and shares knowledge</div>
          <div style={{ ...hintStyle, marginTop: 0 }}>
            These are the defaults every new team starts on. Adjust them here if you like — the result is the
            same as configuring them on the Knowledge page right after the team is created. You can change all
            of them later. <strong style={{ color: 'var(--eb-text-primary)' }}>Optional</strong> — leave them as-is to keep the defaults.
          </div>
          <KnowledgeLearningSections
            showDefaults
            autonomy={form.knowledgeConfig.autonomy}
            review={form.knowledgeConfig.review}
            gates={form.knowledgeConfig.gates}
            onAutonomy={(level) => setForm(f => ({ ...f, knowledgeConfig: { ...f.knowledgeConfig, autonomy: level } }))}
            onReview={(enabled) => setForm(f => ({ ...f, knowledgeConfig: { ...f.knowledgeConfig, review: enabled } }))}
            onGate={(transition, mode) => setForm(f => ({ ...f, knowledgeConfig: { ...f.knowledgeConfig, gates: { ...f.knowledgeConfig.gates, [transition]: mode } } }))}
          />
        </div>

        <ErrorBox message={error} />
      </div>
    </Card>
  );
}

// ─── Step 5 — Review ─────────────────────────────────────────────────
function repoSlug(url) {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+\/[^/ ]+?)(?:\.git)?\s*$/);
  return m ? m[1] : null;
}

function StepReview({ form, environments, sshKeys, githubTokens, mcpServers, mcpCredentials, error }) {
  const env = (environments || []).find(e => e.id === form.environmentId);
  const sshKey = sshKeys?.find(k => k.id === form.sshKeyId);
  const ghToken = githubTokens?.find(t => t.id === form.githubTokenId);
  const knowledge = (form.mcpSelections || []).filter(s => s.serverId);
  // Scalar summary fields (label/value + empty-state placeholders) derived by a
  // pure, unit-tested helper; the knowledge-learning constants come from the
  // shared React component module and are passed through as plain data.
  const fields = buildReviewFields({
    form, env, sshKey, ghToken,
    knowledgeMeta: {
      defaults: KNOWLEDGE_LEARNING_DEFAULTS,
      autonomyLevels: AUTONOMY_LEVELS,
      gateOrder: GATE_ORDER,
      gateLabels: GATE_LABELS,
    },
  });

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        {/* Compact, responsive grid (#760): the short scalar fields share the
            available horizontal space instead of each taking a full-width,
            two-line row, so the whole summary — fields + process block below —
            fits on one screen without scrolling for a typical team. Auto-fit
            columns collapse to a single column on narrow viewports. */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          columnGap: 'var(--eb-space-5)',
          rowGap: 'var(--eb-space-3)',
        }}>
          {fields.map(f => <ReviewRow key={f.key} label={f.label} value={f.value} />)}
          <div style={{ minWidth: 0 }}>
            <div style={compactLabelStyle}>Knowledge sources ({knowledge.length})</div>
            {knowledge.length === 0 ? (
              <div style={{ ...hintStyle, marginTop: 0 }}>None</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
                {knowledge.map(k => {
                  const srv = (mcpServers || []).find(s => s.id === k.serverId);
                  const cred = (mcpCredentials || []).find(c => c.id === k.credentialId);
                  return (
                    <li key={k.serverId} style={{ overflowWrap: 'anywhere' }}>
                      <strong style={{ color: 'var(--eb-text-primary)' }}>{srv?.name || k.serverId}</strong>
                      {' '}— credential {cred ? cred.name : '—'}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        {form.processBundle && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            <div style={compactLabelStyle}>
              Process: {form.processBundle.name} ({(form.processBundle.roles || []).length} agents)
            </div>
            <BundleFlowPreview bundle={form.processBundle} />
            <LintBadges lints={form.processLints} loading={false} />
            <BundleRolesSummary bundle={form.processBundle} teamId={form.teamId} />
          </div>
        )}
        {/* #1129: the Review step showed the wiring but never stated the
            consequence of "Create team" — that it provisions live containers
            which immediately start watching the repo and act on issues/PRs on
            their own. Make that explicit before the irreversible-feeling click. */}
        <GoLiveNotice
          agentCount={(form.processBundle?.roles || []).length}
          repoLabel={repoSlug(form.repoUrl) || form.repoUrl}
        />
        <ErrorBox message={error} />
      </div>
    </Card>
  );
}

// "What happens next" callout on the Review step (#1129): creating the team
// spins up autonomous agents that go live at once. Uses the repo convention for
// warning text-on-bg (color:--eb-status-warning on --eb-status-warning-bg; no
// -text token exists — see Agents.jsx truncation banner).
function GoLiveNotice({ agentCount, repoLabel }) {
  const agents = agentCount > 0 ? `${agentCount} agent${agentCount === 1 ? '' : 's'}` : 'the team’s agents';
  return (
    <div style={{
      display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start',
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      background: 'var(--eb-status-warning-bg)',
      border: '1px solid var(--eb-status-warning)',
      borderRadius: 'var(--eb-radius-md)',
      fontSize: 'var(--eb-text-sm)',
      color: 'var(--eb-text-secondary)',
      lineHeight: 1.6,
    }}>
      <AlertTriangle size={18} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
      <div>
        <div style={{ fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-warning)', marginBottom: 'var(--eb-space-1)' }}>
          What happens next
        </div>
        <p style={{ margin: 0 }}>
          Creating the team provisions {agents} that go live immediately and begin watching{' '}
          {repoLabel ? <code>{repoLabel}</code> : 'the bound repository'} for issues and pull requests,
          acting autonomously from that moment. You can disable individual agents afterwards on the{' '}
          <Link to="/agents" style={{ color: 'var(--eb-accent-primary)' }}>Agents</Link> page.
        </p>
      </div>
    </div>
  );
}

// Tighter variant of labelStyle for the compacted Review step (#760) — the
// shared labelStyle keeps its larger bottom margin for the other wizard steps.
const compactLabelStyle = {
  ...labelStyle,
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-secondary)',
  marginBottom: 'var(--eb-space-1)',
};

function ReviewRow({ label, value }) {
  return (
    // minWidth:0 lets the grid cell shrink so long values wrap instead of
    // forcing the track wider; the title surfaces the full value on hover (#760 AC5).
    <div style={{ minWidth: 0 }}>
      <div style={compactLabelStyle}>{label}</div>
      <div
        title={typeof value === 'string' ? value : undefined}
        style={{
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-primary)',
          fontFamily: 'var(--eb-font-mono)',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >{value}</div>
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
  const [progressSteps, setProgressSteps] = useState(null);
  const [progressError, setProgressError] = useState(null);
  const [matWarnings, setMatWarnings] = useState([]);

  const [form, setForm] = useState({
    teamName: '',
    teamId: '',
    teamIdManuallyEdited: false,
    teamNameManuallyEdited: false,
    environmentId: '',
    repoUrl: '',
    branch: 'main',
    readyLabel: 'ready',
    dispatchLabel: 'dispatch',
    maxParallel: 1,
    labelSuffix: '',
    sshKeyId: '',
    githubTokenId: '',
    mcpSelections: [],
    skills: [],      // initial team skill set (placed on the team agent)
    // Knowledge *learning* config (#567) — autonomy/review/promotion gates,
    // pre-filled with today's defaults and adjustable before team creation.
    // Storage is deliberately out of scope for the wizard (post-creation only).
    knowledgeConfig: {
      autonomy: KNOWLEDGE_LEARNING_DEFAULTS.autonomy,
      review: KNOWLEDGE_LEARNING_DEFAULTS.review,
      gates: { ...KNOWLEDGE_LEARNING_DEFAULTS.gates },
    },
    // Process step (#422): the selected process-template bundle drives
    // team creation.
    processMode: null,        // null | 'template' | 'describe'
    processTemplateId: null,  // 'registry:<id>' | 'draft:<id>'
    processBundle: null,      // processTemplateVersion-1 bundle
    processLints: null,       // authoritative lints for the current bundle
  });

  const { data: templatesResp, loading: tplLoading } = useApi('/api/agent-templates');
  const { data: environments, loading: envsLoading, refetch: refetchEnvs } = useApi('/api/environments');
  const { data: agentsList } = useApi('/api/agents');
  const { data: sshKeys } = useApi('/api/ssh-keys');
  const { data: githubTokens } = useApi('/api/github-tokens');
  const { data: mcpServers } = useApi('/api/mcp-servers');
  const { data: mcpCredentials } = useApi('/api/mcp-credentials');
  const { data: skillsData } = useApi('/api/skills');
  // Create-only wizard: the team pool does not exist yet, so only global skills
  // are grantable here (Proposal 3, #633). A team-tier pool appears once the
  // team exists and can then be granted from the team card on the Agents page.
  const poolSkills = useMemo(
    () => (Array.isArray(skillsData) ? skillsData : []).filter(s => s.source === 'pool'),
    [skillsData],
  );

  const templates = templatesResp?.templates || null;
  const takenAgentIds = useMemo(
    () => new Set((Array.isArray(agentsList) ? agentsList : []).map(a => a.id)),
    [agentsList],
  );

  // Selecting an environment pulls its repo/credentials/MCP set into the form
  // (used for review display; the backend re-resolves everything from
  // environmentId) and suggests a unique team name + id from the environment's
  // name — unless the user already typed their own.
  function selectEnvironment(env) {
    const repos = envRepositories(env);
    const primary = repos[0] || {};
    setForm(f => {
      const next = {
        ...f,
        environmentId: env.id,
        repoUrl: primary.url || '',
        branch: primary.branch || 'main',
        sshKeyId: primary.sshKeyId || '',
        githubTokenId: env.githubTokenId || '',
        mcpSelections: (env.mcpServers || []).map(s => ({ serverId: s.serverId, credentialId: s.credentialId || null })),
      };
      if (!f.teamNameManuallyEdited && !f.teamIdManuallyEdited) {
        const suggestion = suggestTeamNaming(env.name || env.id, agentsList);
        next.teamName = suggestion.teamName;
        next.teamId = suggestion.teamId;
      }
      return next;
    });
    setStepError(null);
    // Card click both selects and advances — the pick is the whole step.
    setStep(2);
  }

  // Create mode composes the team via the Process step (#422).

  function validateStep() {
    if (step === 0) {
      if (!form.processBundle || (form.processBundle.roles || []).length === 0) {
        return 'Pick a process template or describe a flow first';
      }
      if ((form.processLints || []).some(l => l.severity === 'error')) {
        return 'The process has wiring errors — fix them before continuing';
      }
      return null;
    }
    if (step === 1) {
      if (!form.environmentId) return 'Pick a working environment';
      if (!form.repoUrl.trim()) return 'The selected working environment has no repository — add one first';
      return null;
    }
    if (step === 2) {
      if (!form.teamName.trim()) return 'Team name required';
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(form.teamId)) return 'Team ID must be 1–40 chars, [a-z0-9-]';
      if (takenAgentIds.has(form.teamId)) return `Team ID '${form.teamId}' is already used by an existing agent or team — pick a different one (to add agents to an existing team, open it in the Flow Editor)`;
      if (form.labelSuffix && !/^[a-z0-9]{1,8}$/.test(form.labelSuffix)) return 'Label suffix must be 1–8 lowercase base36 chars [a-z0-9]';
      return null;
    }
    // Step 3 — Knowledge sources are inherited from the environment and
    // optional — nothing to validate.
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
  // created agent. Falls through to /agents if nothing was created.
  function landingAgent(created) {
    const ba = (created || []).find(id => id.endsWith('-business-analyst'));
    return ba || (created || [])[0] || null;
  }

  // mode is 'create' by default; the collision card re-submits the same bundle
  // with 'extend' to add only the members that don't already exist.
  async function submit(mode = 'create') {
    setStepError(null);
    setCollisionInfo(null);
    setProgressError(null);
    setProgressSteps(null);
    setMatWarnings([]);
    setSubmitting(true);

    const body = {
      teamId: form.teamId,
      teamName: form.teamName.trim(),
      // The wizard reuses an existing Working Environment: the backend resolves
      // repository + credentials + MCP set from environmentId. The legacy
      // repository/githubTokenId/mcpServers fields are only sent as a fallback
      // when no environment id is known.
      ...(form.environmentId
        ? { environmentId: form.environmentId }
        : {
            repository: { url: form.repoUrl.trim(), branch: form.branch.trim() || 'main', sshKeyId: form.sshKeyId },
            githubTokenId: form.githubTokenId,
            mcpServers: (form.mcpSelections || []).filter(s => s.serverId),
          }),
      readyLabel: (form.readyLabel || 'ready').trim() || 'ready',
      dispatchLabel: (form.dispatchLabel || 'dispatch').trim() || 'dispatch',
      maxParallel: Number.isInteger(form.maxParallel) ? form.maxParallel : 1,
      ...(form.labelSuffix ? { labelSuffix: form.labelSuffix } : {}),
      mode,
      // Initial team skill set — placed on the team agent.
      skills: form.skills || [],
    };
    // Knowledge learning config (#567) — autonomy/review/gates. Persisted onto
    // the new team after creation; the backend drops it when it matches the
    // defaults (no behaviour change vs today's wizard, AC-4).
    if (form.knowledgeConfig) body.knowledgeConfig = form.knowledgeConfig;
    // Ship the Process step's bundle (#422). With Process as step 1 the team
    // name isn't known when the bundle is selected — bind the bundle name to
    // the team name at submit time instead (#428).
    if (form.processBundle) {
      body.processTemplate = { ...form.processBundle, name: form.teamName.trim() || form.processBundle.name };
    }

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
        // The process-template flow has no role-card UI to fall back to — keep
        // the current step and offer "Add missing roles" (mode: extend
        // re-submits the same bundle, adding only the members that don't exist).
        setCollisionInfo({ existing: ev.existing, suggestion: ev.suggestion });
        setProgressSteps(null);
      } else if (ev.type === 'complete') {
        setResult(ev.result);
        const land = landingAgent(ev.result?.created);
        setTimeout(() => {
          if (land) navigate(`/chats/${land}`);
          else navigate('/agents');
        }, 1500);
      } else if (ev.type === 'warning') {
        setMatWarnings(prev => [...prev, ev.message]);
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
        }}>
          Team Setup
        </h1>
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

      {step === 0 && (
        <StepProcess
          form={form}
          setForm={setForm}
          templates={templates}
          error={stepError}
        />
      )}
      {step === 1 && (
        <StepEnvironmentSelect
          form={form}
          environments={environments}
          envsLoading={envsLoading}
          refetchEnvs={refetchEnvs}
          onSelect={selectEnvironment}
          error={stepError}
        />
      )}
      {step === 2 && (
        <StepProject {...stepProps} environments={environments} takenAgentIds={takenAgentIds} error={stepError} />
      )}
      {step === 3 && (
        <StepKnowledgeSummary
          form={form}
          setForm={setForm}
          poolSkills={poolSkills}
          environments={environments}
          mcpServers={mcpServers}
          mcpCredentials={mcpCredentials}
          error={stepError}
        />
      )}
      {step === 4 && (
        <StepReview
          form={form}
          environments={environments}
          sshKeys={sshKeys}
          githubTokens={githubTokens}
          mcpServers={mcpServers}
          mcpCredentials={mcpCredentials}
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
              {submitting ? 'Adding…' : 'Add missing agents'}
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
      {matWarnings.length > 0 && (
        <Card accent="var(--eb-status-warning)">
          <div style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-2)' }}>
            Label suffix — coverage warnings
          </div>
          <ul style={{ margin: 0, padding: '0 0 0 var(--eb-space-4)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
            {matWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
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
