import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Check, AlertCircle, CheckCircle, Github,
  Compass, Code, Search, Shield, FlaskConical, Book, Tag, User,
  Loader2, Circle, XCircle, Lock,
  Network, ClipboardCheck, Gauge, Rocket, MessageCircle, TrendingUp,
  Layers, Terminal, FileCode2,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import ScriptViewerPanel from '../components/ScriptViewerPanel';
import SkillPicker from '../components/SkillPicker';
import KnowledgeLearningSections, {
  KNOWLEDGE_LEARNING_DEFAULTS, AUTONOMY_LEVELS, GATE_ORDER, GATE_LABELS,
} from '../components/KnowledgeLearningConfig';
import StepProcess, { BundleRolesSummary, BundleFlowPreview, LintBadges } from './team-setup/StepProcess';

function scriptNameFromPath(scriptPath) {
  if (typeof scriptPath !== 'string') return null;
  const trimmed = scriptPath.trim();
  if (!trimmed) return null;
  return trimmed.split('/').filter(Boolean).pop() || null;
}

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

function ExtendReadOnlyBanner({ children }) {
  return (
    <div style={{
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-accent-primary)',
      borderRadius: 'var(--eb-radius-md)',
      display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
      fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
    }}>
      <Lock size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-accent-primary)' }} />
      <div>{children}</div>
    </div>
  );
}

function StepProjectReadOnly({ form }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <ExtendReadOnlyBanner>These settings belong to the existing team and cannot be changed here.</ExtendReadOnlyBanner>
        <ReviewRow label="Team Name" value={form.teamName} />
        <ReviewRow label="Team ID" value={form.teamId} />
      </div>
    </Card>
  );
}

function StepEnvironmentReadOnly({ form, environments, sshKeys, githubTokens }) {
  const env = (environments || []).find(e => e.id === form.environmentId);
  const sshKey = (sshKeys || []).find(k => k.id === form.sshKeyId);
  const ghToken = (githubTokens || []).find(t => t.id === form.githubTokenId);
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <ExtendReadOnlyBanner>These settings belong to the existing team and cannot be changed here.</ExtendReadOnlyBanner>
        <ReviewRow label="Working Environment" value={env ? `${env.name} (${env.id})` : (form.environmentId || '—')} />
        <ReviewRow label="SSH Deploy Key" value={sshKey ? sshKey.name : '—'} />
        <ReviewRow label="GitHub Token" value={ghToken ? ghToken.name : '—'} />
        <ReviewRow label="Repository" value={form.repoUrl ? `${form.repoUrl} @ ${form.branch || 'main'}` : '—'} />
      </div>
    </Card>
  );
}

function StepKnowledgeReadOnly({ form, mcpServers, mcpCredentials }) {
  const knowledge = (form.mcpSelections || []).filter(s => s.serverId);
  const kc = form.knowledgeConfig || KNOWLEDGE_LEARNING_DEFAULTS;
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <ExtendReadOnlyBanner>These settings belong to the existing team and cannot be changed here.</ExtendReadOnlyBanner>
        <div>
          <div style={labelStyle}>Knowledge sources ({knowledge.length})</div>
          {knowledge.length === 0 ? (
            <div style={{ ...hintStyle, marginTop: 0 }}>None</div>
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

        {/* Existing team's learning config, shown read-only (#567 extend mode).
            To change it, use the Knowledge page for this team. */}
        <div>
          <div style={labelStyle}>How this team learns and shares knowledge</div>
          <div style={{ ...hintStyle, marginTop: 0 }}>
            The existing team's current settings. Change them on the Knowledge page for this team.
          </div>
          <KnowledgeLearningSections
            readOnly
            autonomy={kc.autonomy}
            review={kc.review}
            gates={kc.gates}
            onAutonomy={() => {}}
            onReview={() => {}}
            onGate={() => {}}
          />
        </div>
      </div>
    </Card>
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
              No GitHub token — roles reacting to issues / PRs won&apos;t trigger.
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
            Skills from the pool the whole team starts with — placed on the team agent, so every member
            inherits them unless it overrides. You can adjust them later on the team's card on the Agents page.
          </div>
          <SkillPicker
            allSkills={poolSkills || []}
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

// ─── Roles step (extend mode, occupies the "Process" slot = step 1) ──
// Business Analyst is a persistent chat agent; multiple instances would
// conflict (shared DM session). All other roles support reactive triggers
// and can be scaled to multiple instances.
const SINGLE_INSTANCE_ROLES = new Set(['business-analyst']);

function RoleCard({ template, selected, count, onToggle, onCountChange }) {
  const [scriptPanelName, setScriptPanelName] = useState(null);
  const [countError, setCountError] = useState(null);
  const Icon = ROLE_ICONS[template.icon] || User;
  const multiAllowed = !SINGLE_INSTANCE_ROLES.has(template.id);

  function handleMinus(e) {
    e.stopPropagation();
    setCountError(null);
    if (count > 1) onCountChange(count - 1);
    else onToggle(); // deselect when decrementing below 1
  }
  function handlePlus(e) {
    e.stopPropagation();
    setCountError(null);
    if (count < 10) onCountChange(count + 1);
  }
  function handleCountChange(e) {
    e.stopPropagation();
    const raw = e.target.value;
    const v = parseInt(raw, 10);
    if (raw === '' || isNaN(v) || !Number.isInteger(v)) {
      setCountError('Enter a whole number between 1 and 10');
      return;
    }
    if (v < 1 || v > 10) {
      setCountError('Instance count must be between 1 and 10');
      return;
    }
    setCountError(null);
    onCountChange(v);
  }

  return (
    <div
      onClick={onToggle}
      role="checkbox"
      aria-checked={selected}
      tabIndex={0}
      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggle(); } }}
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
        flexDirection: 'column',
        gap: 'var(--eb-space-2)',
        transition: 'border-color 0.1s',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
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
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--eb-space-2)',
            }}>
              {template.triggerSummary.map(t => {
                const schedule = t.type === 'cron'
                  ? `cron ${t.cron}`
                  : (t.events && t.events.length ? t.events.join(', ') : t.type);
                const scriptName = scriptNameFromPath(t.preCheckScript);
                return (
                  <div key={t.id} style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    fontSize: 'var(--eb-text-xs)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
                      <span style={{
                        padding: '1px 6px',
                        background: 'var(--eb-bg-elevated)',
                        borderRadius: 'var(--eb-radius-sm)',
                        fontFamily: 'var(--eb-font-mono)',
                        color: 'var(--eb-text-secondary)',
                      }}>
                        {schedule}
                      </span>
                      <code style={{
                        fontFamily: 'var(--eb-font-mono)',
                        color: 'var(--eb-text-muted)',
                      }}>
                        {t.id}
                      </code>
                      {t.preCheckScript && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '1px 6px',
                          background: 'var(--eb-bg-elevated)',
                          border: '1px solid var(--eb-border-default)',
                          borderRadius: 'var(--eb-radius-sm)',
                          color: 'var(--eb-text-secondary)',
                          fontFamily: 'var(--eb-font-mono)',
                        }}>
                          <Terminal size={10} />
                          {t.preCheckScript}
                        </span>
                      )}
                      {scriptName && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setScriptPanelName(scriptName); }}
                          title="View script source (read-only)"
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            background: 'none',
                            border: '1px solid var(--eb-border-default)',
                            borderRadius: 'var(--eb-radius-sm)',
                            color: 'var(--eb-text-secondary)',
                            cursor: 'pointer',
                            padding: '1px 6px',
                            fontSize: 'var(--eb-text-xs)',
                          }}
                        >
                          <FileCode2 size={10} /> View
                        </button>
                      )}
                    </div>
                    {t.description && (
                      <div style={{
                        color: 'var(--eb-text-muted)',
                        lineHeight: 1.4,
                        paddingLeft: 2,
                      }}>
                        {t.description}
                      </div>
                    )}
                    {t.preCheckEnvKeys && t.preCheckEnvKeys.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 2 }}>
                        {t.preCheckEnvKeys.map(k => (
                          <span key={k} style={{
                            fontSize: 'var(--eb-text-xs)',
                            fontFamily: 'var(--eb-font-mono)',
                            padding: '0 4px',
                            background: 'var(--eb-bg-surface)',
                            border: '1px solid var(--eb-border-default)',
                            borderRadius: 'var(--eb-radius-sm)',
                            color: 'var(--eb-text-muted)',
                          }}>
                            {k}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <ScriptViewerPanel
            open={!!scriptPanelName}
            onClose={() => setScriptPanelName(null)}
            scriptName={scriptPanelName}
          />
        </div>
      </div>

      {selected && multiAllowed && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
            paddingTop: 'var(--eb-space-2)',
            borderTop: '1px solid var(--eb-border-default)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginRight: 'var(--eb-space-1)' }}>
              Instances:
            </span>
            <button
              type="button"
              onClick={handleMinus}
              style={{
                width: 26, height: 26, borderRadius: 'var(--eb-radius-sm)',
                background: 'var(--eb-bg-elevated)',
                border: '1px solid var(--eb-border-default)',
                color: 'var(--eb-text-primary)',
                cursor: 'pointer', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--eb-text-md)', lineHeight: 1,
              }}
            >−</button>
            <input
              type="number"
              value={count}
              min={1}
              max={10}
              onClick={e => e.stopPropagation()}
              onChange={handleCountChange}
              style={{
                width: 44, textAlign: 'center',
                padding: 'var(--eb-space-1)',
                background: 'var(--eb-bg-elevated)',
                border: `1px solid ${countError ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
                borderRadius: 'var(--eb-radius-sm)',
                color: 'var(--eb-text-primary)',
                fontSize: 'var(--eb-text-sm)',
                fontFamily: 'var(--eb-font-mono)',
              }}
            />
            <button
              type="button"
              onClick={handlePlus}
              disabled={count >= 10}
              style={{
                width: 26, height: 26, borderRadius: 'var(--eb-radius-sm)',
                background: 'var(--eb-bg-elevated)',
                border: '1px solid var(--eb-border-default)',
                color: count >= 10 ? 'var(--eb-text-muted)' : 'var(--eb-text-primary)',
                cursor: count >= 10 ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--eb-text-md)', lineHeight: 1,
              }}
            >+</button>
          </div>
          {countError && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginLeft: 2 }}>
              {countError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExtendExistingRoleCard({ template, existingCount, count, onCountChange }) {
  const Icon = ROLE_ICONS[template.icon] || User;
  const delta = count - existingCount;
  const atFloor = count <= existingCount;
  const multiAllowed = !SINGLE_INSTANCE_ROLES.has(template.id);

  function handleMinus(e) {
    e.stopPropagation();
    if (count > existingCount) onCountChange(count - 1);
  }
  function handlePlus(e) {
    e.stopPropagation();
    if (count < 10) onCountChange(count + 1);
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-4)',
      background: delta > 0 ? 'var(--eb-bg-surface)' : 'var(--eb-bg-elevated)',
      border: `2px solid ${delta > 0 ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
      borderRadius: 'var(--eb-radius-lg)',
    }}>
      <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-start' }}>
        <div style={{
          flexShrink: 0, width: 36, height: 36,
          borderRadius: 'var(--eb-radius-md)',
          background: delta > 0 ? 'var(--eb-accent-primary)' : 'var(--eb-bg-app)',
          color: delta > 0 ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative',
        }}>
          <Icon size={18} />
          {atFloor && (
            <Lock size={10} style={{ position: 'absolute', bottom: 2, right: 2, color: 'var(--eb-text-muted)' }} />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--eb-space-2)' }}>
            <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: delta > 0 ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)' }}>
              {template.displayName}
            </div>
            <span style={{
              fontSize: 'var(--eb-text-xs)',
              color: delta > 0 ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)',
              background: 'var(--eb-bg-app)', padding: '1px 6px',
              borderRadius: 'var(--eb-radius-sm)', border: '1px solid var(--eb-border-default)',
              flexShrink: 0,
            }}>
              {delta > 0 ? `+${delta} instance${delta !== 1 ? 's' : ''}` : 'Already configured'}
            </span>
          </div>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.4 }}>
            {template.description}
          </div>
        </div>
      </div>
      {multiAllowed && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          paddingTop: 'var(--eb-space-2)',
          borderTop: '1px solid var(--eb-border-default)',
          opacity: atFloor ? 0.6 : 1,
        }}>
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginRight: 'var(--eb-space-1)' }}>
            Instances:
          </span>
          <button
            type="button"
            onClick={handleMinus}
            disabled={atFloor}
            style={{
              width: 26, height: 26, borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              color: atFloor ? 'var(--eb-text-muted)' : 'var(--eb-text-primary)',
              cursor: atFloor ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'var(--eb-text-md)', lineHeight: 1,
            }}
          >−</button>
          <div style={{
            width: 44, textAlign: 'center',
            padding: 'var(--eb-space-1)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-sm)',
            color: 'var(--eb-text-primary)',
            fontSize: 'var(--eb-text-sm)',
            fontFamily: 'var(--eb-font-mono)',
          }}>
            {count}
          </div>
          <button
            type="button"
            onClick={handlePlus}
            disabled={count >= 10}
            style={{
              width: 26, height: 26, borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              color: count >= 10 ? 'var(--eb-text-muted)' : 'var(--eb-text-primary)',
              cursor: count >= 10 ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'var(--eb-text-md)', lineHeight: 1,
            }}
          >+</button>
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {delta > 0
              ? `(${existingCount} existing + ${delta} new)`
              : `(${existingCount} existing — click + to add more)`}
          </span>
        </div>
      )}
    </div>
  );
}

// Roles whose configuration depends on the ready-label being settable —
// BA writes it, QE reacts to it, Dispatcher reads its candidate queue
// from it, Roadmap Reporter cites it, and Developer reacts to it
// indirectly via the `{{dispatchLabel}}` fallback (when no Dispatcher is
// selected, the backend collapses `{{dispatchLabel}}` → `readyLabel`, so
// a Developer-only team still needs the ready-label input).
// Keep this in sync with the `{{readyLabel}}` placeholders inside the
// role JSON files under orchestrator/skill-pool/agent-templates/.
const READY_LABEL_ROLES = new Set([
  'business-analyst', 'developer', 'dispatcher', 'quality-engineer', 'roadmap-reporter',
]);
// Roles whose presence requires the dispatch-label + WIP-cap inputs to
// be configurable. Only the Dispatcher produces the dispatch label
// (the Developer also consumes it via the trigger label filter, but
// without a Dispatcher in the team the backend collapses
// `{{dispatchLabel}}` to `readyLabel`, so the Developer alone doesn't
// warrant exposing the field).
const DISPATCH_LABEL_ROLES = new Set(['dispatcher']);

function StepTeam({ form, setForm, templates, roleConfig, setRoleConfig, error, extendMode, existingRoles, existingRoleCounts }) {
  if (!templates) return <Card>Loading templates…</Card>;
  const existingSet = new Set(extendMode ? (existingRoles || []) : []);
  const counts = existingRoleCounts || {};
  const showReadyLabel = roleConfig.some(r => READY_LABEL_ROLES.has(r.id));
  const showDispatchControls = roleConfig.some(r => DISPATCH_LABEL_ROLES.has(r.id));

  function isSelected(id) { return roleConfig.some(r => r.id === id); }
  function getCount(id) { return (roleConfig.find(r => r.id === id) || {}).count || 1; }
  function toggle(id) {
    setRoleConfig(prev => prev.some(r => r.id === id)
      ? prev.filter(r => r.id !== id)
      : [...prev, { id, count: 1 }]);
  }
  function setCount(id, count) {
    setRoleConfig(prev => prev.map(r => r.id === id ? { ...r, count } : r));
  }

  return (
    <Card>
      {extendMode && (
        <div style={{ marginBottom: 'var(--eb-space-4)' }}>
          <ExtendReadOnlyBanner>
            Existing roles show their current instance count — use the stepper to add more. Toggle new roles to add them to the team.
          </ExtendReadOnlyBanner>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--eb-space-3)' }}>
        {templates.map(t => {
          if (extendMode && existingSet.has(t.id)) {
            return (
              <ExtendExistingRoleCard
                key={t.id}
                template={t}
                existingCount={counts[t.id] || 1}
                count={getCount(t.id)}
                onCountChange={c => setCount(t.id, c)}
              />
            );
          }
          return (
            <RoleCard
              key={t.id}
              template={t}
              selected={isSelected(t.id)}
              count={getCount(t.id)}
              onToggle={() => toggle(t.id)}
              onCountChange={c => setCount(t.id, c)}
            />
          );
        })}
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
            Human greenlight signal. The Business Analyst applies this label once the acceptance criteria are settled.
            {showDispatchControls
              ? <> The Dispatcher reads its candidate queue from this label and decides what goes next.</>
              : <> The Developer reacts directly to this label (no Dispatcher selected).</>}
            {' '}Freely chosen (e.g. <code>ready</code>, <code>dev-ready</code>, <code>greenlight</code>).
          </div>
        </div>
      )}

      {showDispatchControls && (
        <div style={{ marginTop: 'var(--eb-space-5)', paddingTop: 'var(--eb-space-4)', borderTop: '1px solid var(--eb-border-default)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 'var(--eb-space-4)' }}>
            <div>
              <label htmlFor="ts-dispatch-label" style={labelStyle}>Dispatch label</label>
              <input
                id="ts-dispatch-label"
                type="text"
                placeholder="dispatch"
                value={form.dispatchLabel}
                onChange={e => setForm(f => ({ ...f, dispatchLabel: e.target.value }))}
                style={inputStyle}
              />
            </div>
            <div>
              <label htmlFor="ts-max-parallel" style={labelStyle}>Max in flight</label>
              <input
                id="ts-max-parallel"
                type="number"
                min={1}
                max={50}
                value={form.maxParallel}
                onChange={e => {
                  const n = parseInt(e.target.value, 10);
                  setForm(f => ({ ...f, maxParallel: Number.isFinite(n) ? n : 1 }));
                }}
                style={inputStyle}
              />
            </div>
          </div>
          <div style={hintStyle}>
            The Dispatcher applies this label to release a queued issue to the Developer team. The Developer reacts only to this label — not to <code>{form.readyLabel || 'ready'}</code> directly. <strong>Max in flight</strong> is the WIP cap: how many dispatched, not-yet-merged issues the team handles in parallel.
          </div>
        </div>
      )}

      <ErrorBox message={error} />
    </Card>
  );
}

// ─── Step 5 — Review ─────────────────────────────────────────────────
function repoSlug(url) {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+\/[^/ ]+?)(?:\.git)?\s*$/);
  return m ? m[1] : null;
}

function StepReview({ form, templates, environments, sshKeys, githubTokens, mcpServers, mcpCredentials, error, extendMode, existingRoles, existingRoleCounts }) {
  const existingSet = new Set(extendMode ? (existingRoles || []) : []);
  const counts = existingRoleCounts || {};
  const env = (environments || []).find(e => e.id === form.environmentId);
  const sshKey = sshKeys?.find(k => k.id === form.sshKeyId);
  const ghToken = githubTokens?.find(t => t.id === form.githubTokenId);
  const roleConfig = form.roleConfig || [];
  const allSelected = (templates || []).filter(t => roleConfig.some(r => r.id === t.id));
  const newRoles = allSelected.filter(t => !existingSet.has(t.id));
  const increasedRoles = allSelected.filter(t => existingSet.has(t.id) && countFor(t.id) > (counts[t.id] || 0));
  const keptRoles = allSelected.filter(t => existingSet.has(t.id) && countFor(t.id) <= (counts[t.id] || 0));
  const showReadyLabel = roleConfig.some(r => READY_LABEL_ROLES.has(r.id));
  const showDispatchControls = roleConfig.some(r => DISPATCH_LABEL_ROLES.has(r.id));
  const knowledge = (form.mcpSelections || []).filter(s => s.serverId);

  const hasMultiInstance = roleConfig.some(r => (r.count || 1) > 1);
  const [coordinatorStatus, setCoordinatorStatus] = useState(null);
  const [coordinatorError, setCoordinatorError] = useState(null);

  useEffect(() => {
    if (!hasMultiInstance || !form.githubTokenId || !form.repoUrl) return;
    const slug = repoSlug(form.repoUrl);
    if (!slug) return;
    setCoordinatorStatus('checking');
    setCoordinatorError(null);
    fetch(`/api/repos/coordinator-workflow?repo=${encodeURIComponent(slug)}&githubTokenId=${encodeURIComponent(form.githubTokenId)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setCoordinatorStatus('error'); setCoordinatorError(data.error); }
        else setCoordinatorStatus(data.exists ? 'active' : 'needed');
      })
      .catch(err => { setCoordinatorStatus('error'); setCoordinatorError(String(err)); });
  }, [hasMultiInstance, form.githubTokenId, form.repoUrl]);

  function installCoordinator() {
    const slug = repoSlug(form.repoUrl);
    if (!slug) return;
    setCoordinatorStatus('installing');
    setCoordinatorError(null);
    fetch('/api/repos/coordinator-workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: slug, githubTokenId: form.githubTokenId }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) { setCoordinatorStatus('active'); }
        else {
          setCoordinatorStatus('install-error');
          setCoordinatorError(data.error || 'Installation failed');
          if (data.manualCommand) setCoordinatorError((data.error || '') + '\n\nRun manually:\n' + data.manualCommand);
        }
      })
      .catch(err => { setCoordinatorStatus('install-error'); setCoordinatorError(String(err)); });
  }

  function countFor(id) { return (roleConfig.find(r => r.id === id) || {}).count || 1; }
  function agentIds(id) {
    const c = countFor(id);
    if (c === 1) return [`${form.teamId}-${id}`];
    return Array.from({ length: c }, (_, i) => `${form.teamId}-${id}-${i + 1}`);
  }

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <ReviewRow label="Team" value={`${form.teamName} (${form.teamId})`} />
        {!extendMode && (
          <>
            <ReviewRow label="Working Environment" value={env ? `${env.name} (${env.id})` : (form.environmentId || '—')} />
            <ReviewRow label="Repository" value={`${form.repoUrl} @ ${form.branch || 'main'}`} />
            {showReadyLabel && <ReviewRow label="Ready label" value={form.readyLabel || 'ready'} />}
            {showDispatchControls && (
              <>
                <ReviewRow label="Dispatch label" value={form.dispatchLabel || 'dispatch'} />
                <ReviewRow label="Max in flight" value={String(form.maxParallel || 1)} />
              </>
            )}
            <ReviewRow label="SSH Key" value={sshKey ? sshKey.name : '—'} />
            <ReviewRow label="GitHub Token" value={ghToken ? ghToken.name : '—'} />
            <ReviewRow label="Initial team skills" value={(form.skills || []).length ? form.skills.join(', ') : '—'} />
            {(() => {
              const kc = form.knowledgeConfig || KNOWLEDGE_LEARNING_DEFAULTS;
              const lvl = AUTONOMY_LEVELS.find(l => l.level === kc.autonomy) || AUTONOMY_LEVELS[1];
              const gateSummary = GATE_ORDER
                .map(tr => `${GATE_LABELS[tr]}: ${tr === 'team>global' ? 'always reviewed' : ((kc.gates || {})[tr] || 'review') === 'auto' ? 'automatic' : 'needs review'}`)
                .join(' · ');
              return (
                <ReviewRow
                  label="Knowledge learning"
                  value={`Autonomy ${kc.autonomy} · ${lvl.label} · Review ${kc.review ? 'on' : 'off'} · ${gateSummary}`}
                />
              );
            })()}
            <div>
              <div style={labelStyle}>Knowledge sources ({knowledge.length})</div>
              {knowledge.length === 0 ? (
                <div style={{ ...hintStyle, marginTop: 0 }}>None</div>
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
          </>
        )}
        {extendMode ? (
          <>
            <div>
              <div style={labelStyle}>Will be added ({newRoles.length + increasedRoles.length})</div>
              {newRoles.length === 0 && increasedRoles.length === 0 ? (
                <div style={{ ...hintStyle, marginTop: 0 }}>No new roles or increases selected.</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
                  {newRoles.map(t => {
                    const c = countFor(t.id);
                    const ids = agentIds(t.id);
                    return (
                      <li key={t.id}>
                        <strong style={{ color: 'var(--eb-status-success)' }}>{t.displayName}</strong>
                        {c > 1 && <span style={{ color: 'var(--eb-accent-primary)', marginLeft: 4 }}>× {c}</span>}
                        {' '}— {ids.map((id, i) => <React.Fragment key={id}>{i > 0 && ', '}<code>{id}</code></React.Fragment>)}
                      </li>
                    );
                  })}
                  {increasedRoles.map(t => {
                    const newTotal = countFor(t.id);
                    const existingCount = counts[t.id] || 0;
                    const delta = newTotal - existingCount;
                    const newIds = Array.from({ length: delta }, (_, i) =>
                      `${form.teamId}-${t.id}-${existingCount + i + 1}`
                    );
                    return (
                      <li key={t.id}>
                        <strong style={{ color: 'var(--eb-status-success)' }}>{t.displayName}</strong>
                        <span style={{ color: 'var(--eb-accent-primary)', marginLeft: 4 }}>+{delta}</span>
                        {' '}— {newIds.map((id, i) => <React.Fragment key={id}>{i > 0 && ', '}<code>{id}</code></React.Fragment>)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {keptRoles.length > 0 && (
              <div>
                <div style={labelStyle}>Already exists ({keptRoles.length})</div>
                <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                  {keptRoles.map(t => (
                    <li key={t.id}>
                      <Lock size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                      <span style={{ color: 'var(--eb-text-muted)' }}>{t.displayName}</span>
                      {' '}— <code>{form.teamId}-{t.id}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : form.processBundle ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
            <div style={labelStyle}>
              {/* Composed bundles are woven before the team name exists (#428) —
                  show the name the materialised bundle will carry. */}
              Process: {form.processMode === 'compose' ? (form.teamName?.trim() || form.processBundle.name) : form.processBundle.name} ({(form.processBundle.roles || []).length} roles)
            </div>
            <BundleFlowPreview bundle={form.processBundle} />
            <LintBadges lints={form.processLints} loading={false} />
            <BundleRolesSummary bundle={form.processBundle} teamId={form.teamId} />
          </div>
        ) : (
          <div>
            <div style={labelStyle}>Roles ({allSelected.length})</div>
            <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
              {allSelected.map(t => {
                const c = countFor(t.id);
                const ids = agentIds(t.id);
                return (
                  <li key={t.id}>
                    <strong style={{ color: 'var(--eb-text-primary)' }}>{t.displayName}</strong>
                    {c > 1 && <span style={{ color: 'var(--eb-accent-primary)', marginLeft: 4 }}>× {c}</span>}
                    {' '}— {ids.map((id, i) => <React.Fragment key={id}>{i > 0 && ', '}<code>{id}</code></React.Fragment>)}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {hasMultiInstance && (
          <div style={{
            padding: 'var(--eb-space-3) var(--eb-space-4)',
            borderRadius: 'var(--eb-radius-md)',
            border: coordinatorStatus === 'active' ? '1px solid var(--eb-status-success)' : '1px solid var(--eb-border-default)',
            background: 'var(--eb-bg-elevated)',
          }}>
            {coordinatorStatus === 'checking' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                <Loader2 size={14} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} />
                Checking coordinator workflow…
              </div>
            )}
            {coordinatorStatus === 'active' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>
                <CheckCircle size={14} />
                <strong>Coordinator active</strong> — <code>.github/workflows/coordinator.yml</code> is present.
              </div>
            )}
            {(coordinatorStatus === 'needed' || coordinatorStatus === 'installing' || coordinatorStatus === 'install-error') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)' }}>
                  <AlertCircle size={14} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
                  <span>
                    <strong>Coordinator not set up.</strong> You have multiple instances of one or more roles. The coordinator workflow manages automatic work distribution between them.
                  </span>
                </div>
                {coordinatorStatus === 'install-error' && coordinatorError && (
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', whiteSpace: 'pre-wrap', fontFamily: 'var(--eb-font-mono)' }}>
                    {coordinatorError}
                  </div>
                )}
                <button
                  type="button"
                  onClick={installCoordinator}
                  disabled={coordinatorStatus === 'installing'}
                  style={{
                    alignSelf: 'flex-start',
                    padding: 'var(--eb-space-2) var(--eb-space-3)',
                    background: 'var(--eb-accent-primary)',
                    color: 'var(--eb-text-inverted)',
                    border: 'none',
                    borderRadius: 'var(--eb-radius-md)',
                    fontSize: 'var(--eb-text-sm)',
                    fontFamily: 'inherit',
                    cursor: coordinatorStatus === 'installing' ? 'not-allowed' : 'pointer',
                    opacity: coordinatorStatus === 'installing' ? 0.5 : 1,
                    display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                  }}
                >
                  {coordinatorStatus === 'installing' && <Loader2 size={13} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} />}
                  {coordinatorStatus === 'installing' ? 'Installing…' : 'Install coordinator workflow'}
                </button>
              </div>
            )}
            {coordinatorStatus === 'error' && (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
                Could not check coordinator status: {coordinatorError}
              </div>
            )}
          </div>
        )}
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
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [collisionInfo, setCollisionInfo] = useState(null);
  const [result, setResult] = useState(null);
  const [progressSteps, setProgressSteps] = useState(null);
  const [progressError, setProgressError] = useState(null);

  // Extend mode state
  const [extendMode, setExtendMode] = useState(false);
  const [existingRoles, setExistingRoles] = useState([]);
  const [existingRoleCounts, setExistingRoleCounts] = useState({});
  const [extendLoading, setExtendLoading] = useState(false);
  const [extendError, setExtendError] = useState(null);
  // Toast shown when navigated here with a state message (e.g. team not found)
  const [infoMessage, setInfoMessage] = useState(() => location.state?.toastMessage || null);

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
    sshKeyId: '',
    githubTokenId: '',
    roleConfig: [],  // Array<{ id: string, count: number }> — extend mode only
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
    // Process step (#422): the selected/woven process-template bundle drives
    // team creation in create mode; roleConfig stays for extend mode.
    processMode: null,        // null | 'template' | 'compose'
    processTemplateId: null,  // 'registry:<id>' | 'draft:<id>'
    processBundle: null,      // processTemplateVersion-1 bundle
    weaveNotes: [],           // gap-rule explanations from the Flow-Weaver
    processLints: null,       // authoritative lints for the current bundle
    composerStages: [],       // composer state
  });

  const { data: templatesResp, loading: tplLoading } = useApi('/api/agent-templates');
  const { data: environments, loading: envsLoading, refetch: refetchEnvs } = useApi('/api/environments');
  const { data: agentsList } = useApi('/api/agents');
  const { data: sshKeys } = useApi('/api/ssh-keys');
  const { data: githubTokens } = useApi('/api/github-tokens');
  const { data: mcpServers } = useApi('/api/mcp-servers');
  const { data: mcpCredentials } = useApi('/api/mcp-credentials');
  const { data: skillsData } = useApi('/api/skills');
  const poolSkills = useMemo(
    () => (Array.isArray(skillsData) ? skillsData : []).filter(s => s.source === 'pool').map(s => s.name),
    [skillsData],
  );

  const templates = templatesResp?.templates || null;
  const takenAgentIds = useMemo(
    () => new Set((Array.isArray(agentsList) ? agentsList : []).map(a => a.id)),
    [agentsList],
  );

  // Selecting an environment pulls its repo/credentials/MCP set into the form
  // (used for review display + the coordinator check; the backend re-resolves
  // everything from environmentId) and suggests a unique team name + id from
  // the environment's name — unless the user already typed their own.
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

  // Create mode composes via the Process step (#422) — roleConfig is only
  // populated in extend mode (from the existing team) or on a collision.

  // Load existing team config when URL has ?team=<id>&mode=extend.
  useEffect(() => {
    const teamId = searchParams.get('team');
    const mode = searchParams.get('mode');
    if (!teamId || mode !== 'extend') return;

    setExtendMode(true);
    setExtendLoading(true);
    setExtendError(null);

    (async () => {
      try {
        // Fetch team config and all agents in parallel
        const [teamRes, agentsRes] = await Promise.all([
          fetch(`/api/agents/${encodeURIComponent(teamId)}`),
          fetch('/api/agents'),
        ]);


        if (!teamRes.ok) {
          navigate('/team-setup', { state: { toastMessage: `Team "${teamId}" not found — starting fresh.` } });
          return;
        }
        if (!agentsRes.ok) {
          throw new Error('Failed to load team members — please try again.');
        }

        const [teamCfg, agentList] = await Promise.all([teamRes.json(), agentsRes.json()]);

        // Fetch environment config (depends on teamCfg)
        let env = null;
        if (teamCfg.environmentId) {
          const envRes = await fetch(`/api/environments/${encodeURIComponent(teamCfg.environmentId)}`);
          if (envRes.ok) env = await envRes.json();
        }

        // Fetch the team's current knowledge learning config (read-only in extend
        // mode). Best-effort — fall back to defaults if it can't be loaded.
        let knowledgeConfig = {
          autonomy: KNOWLEDGE_LEARNING_DEFAULTS.autonomy,
          review: KNOWLEDGE_LEARNING_DEFAULTS.review,
          gates: { ...KNOWLEDGE_LEARNING_DEFAULTS.gates },
        };
        try {
          const gatesRes = await fetch(`/api/knowledge/gates?team=${encodeURIComponent(teamId)}`);
          if (gatesRes.ok) {
            const gd = await gatesRes.json();
            knowledgeConfig = {
              autonomy: typeof gd.autonomy === 'number' ? gd.autonomy : knowledgeConfig.autonomy,
              review: !!gd.review,
              gates: { ...knowledgeConfig.gates, ...(gd.gates || {}) },
            };
          }
        } catch { /* keep defaults */ }

        const members = (Array.isArray(agentList) ? agentList : (agentList.agents || []))
          .filter(a => a.parentTeamId === teamId && a.role === 'team-member');

        // Derive existing role IDs + instance counts from member list.
        const prefix = `${teamId}-`;
        const roleCountMap = {};
        members.forEach(m => {
          let roleId = null;
          if (m.roleId) roleId = m.roleId;
          else if (m.templateId) roleId = m.templateId;
          else if (m.id.startsWith(prefix)) roleId = m.id.slice(prefix.length).replace(/-\d+$/, '');
          else console.warn(`[TeamSetup] Member "${m.id}" does not follow "${prefix}<roleId>" convention — skipping`);
          if (roleId) roleCountMap[roleId] = (roleCountMap[roleId] || 0) + 1;
        });
        const uniqueRoles = Object.keys(roleCountMap);
        setExistingRoles(uniqueRoles);
        setExistingRoleCounts(roleCountMap);

        // Pre-populate form from existing team + env
        const repo = env?.repositories?.[0] || env?.repository || null;
        setForm(f => ({
          ...f,
          teamName: teamCfg.displayName || teamId,
          teamId,
          teamIdManuallyEdited: true,
          teamNameManuallyEdited: true,
          environmentId: teamCfg.environmentId || '',
          repoUrl: repo?.url || '',
          branch: repo?.branch || 'main',
          sshKeyId: repo?.sshKeyId || '',
          githubTokenId: env?.githubTokenId || '',
          readyLabel: 'ready',
          mcpSelections: (env?.mcpServers || []).map(s => ({ serverId: s.serverId, credentialId: s.credentialId || null })),
          roleConfig: uniqueRoles.map(id => ({ id, count: roleCountMap[id] })),
          knowledgeConfig,
        }));
        // Extend mode edits roles in the wizard's first slot ("Process").
        setStep(0);
      } catch (err) {
        setExtendError(err.message || String(err));
      } finally {
        setExtendLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function validateStep() {
    if (extendMode) {
      // Only the roles step (0) takes input — steps 1–3 are read-only.
      if (step === 0) {
        const existingSet = new Set(existingRoles);
        const hasNew = form.roleConfig.some(r => !existingSet.has(r.id));
        const hasIncrease = form.roleConfig.some(r => existingSet.has(r.id) && r.count > (existingRoleCounts[r.id] || 0));
        if (!hasNew && !hasIncrease) return 'Select at least one new role or increase an existing role count';
      }
      return null;
    }
    if (step === 0) {
      if (!form.processBundle || (form.processBundle.roles || []).length === 0) {
        return 'Pick a process template or compose a process first';
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
      if (takenAgentIds.has(form.teamId)) return `Team ID '${form.teamId}' is already used by an existing agent or team — pick a different one (to add roles to an existing team, use "Extend" on its card on the Agents page)`;
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
    // Extend mode: steps 1–3 are read-only — jump from Roles straight to Review.
    setStep(s => extendMode ? STEPS.length - 1 : Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStepError(null);
    setCollisionInfo(null);
    // Extend mode: mirror next() — Review returns to the roles step.
    setStep(s => extendMode && s === STEPS.length - 1 ? 0 : Math.max(s - 1, 0));
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

    // In extend mode, send only the delta (new roles at full count; existing roles at delta count).
    const effectiveMode = extendMode ? 'extend' : mode;
    const existingSet = new Set(existingRoles);
    const effectiveRoleConfig = extendMode
      ? [
          // New roles: send full count as before
          ...form.roleConfig.filter(r => !existingSet.has(r.id)),
          // Existing roles with delta > 0: send the delta as count so the backend creates only new members
          ...form.roleConfig
            .filter(r => existingSet.has(r.id) && r.count > (existingRoleCounts[r.id] || 0))
            .map(r => ({ ...r, count: r.count - (existingRoleCounts[r.id] || 0) })),
        ]
      : form.roleConfig;

    const body = {
      teamId: form.teamId,
      teamName: form.teamName.trim(),
      // The wizard reuses an existing Working Environment: the backend resolves
      // repository + credentials + MCP set from environmentId. The legacy
      // repository/githubTokenId/mcpServers fields are only sent as a fallback
      // when no environment id is known (pre-env-reuse teams in extend mode).
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
      mode: effectiveMode,
    };
    // Initial team skill set (create mode) — placed on the team agent.
    if (!extendMode) body.skills = form.skills || [];
    // Knowledge learning config (create mode, #567) — autonomy/review/gates.
    // Persisted onto the new team after creation; the backend drops it when it
    // matches the defaults (no behaviour change vs today's wizard, AC-4).
    if (!extendMode && form.knowledgeConfig) body.knowledgeConfig = form.knowledgeConfig;
    // Create mode ships the Process step's bundle (#422); extend mode keeps the
    // catalog-role delta (instance counts are a roles-array concept).
    if (!extendMode && form.processBundle) {
      // With Process as step 1 the team name isn't known at weave time — bind
      // the bundle name to the team name at submit time instead (#428).
      body.processTemplate = { ...form.processBundle, name: form.teamName.trim() || form.processBundle.name };
    } else {
      body.roles = effectiveRoleConfig;
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
        // Bundle path (#422): the process-template flow has no role-card UI to
        // fall back to — keep the current step and offer "Add missing roles"
        // (mode: extend re-submits the same bundle, adding only missing members).
        if (!extendMode && form.processBundle) {
          setCollisionInfo({ existing: ev.existing, suggestion: ev.suggestion });
          setProgressSteps(null);
          return;
        }
        // Derive existing role ids + counts from the member-id list in the collision payload.
        const prefix = form.teamId + '-';
        const collisionCountMap = {};
        (ev.existing?.members || []).forEach(m => {
          if (typeof m !== 'string') return;
          if (!m.startsWith(prefix)) return;
          const roleId = m.slice(prefix.length).replace(/-\d+$/, '');
          if (roleId) collisionCountMap[roleId] = (collisionCountMap[roleId] || 0) + 1;
        });
        const collisionRoles = Object.keys(collisionCountMap);
        setExistingRoles(collisionRoles);
        setExistingRoleCounts(collisionCountMap);
        setForm(f => ({
          ...f,
          roleConfig: [
            ...collisionRoles.map(id => ({ id, count: collisionCountMap[id] })),
            ...f.roleConfig.filter(r => !collisionCountMap[r.id]),
          ],
        }));
        setExtendMode(true);
        setCollisionInfo({ existing: ev.existing, suggestion: ev.suggestion });
        setProgressSteps(null);
        setStep(0);
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

  if (extendLoading) {
    return (
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', color: 'var(--eb-text-secondary)', paddingTop: 'var(--eb-space-8)' }}>
        <Loader2 size={18} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} />
        <style>{`@keyframes team-setup-spin { to { transform: rotate(360deg); } }`}</style>
        Loading team configuration…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
      <div>
        <h1 style={{
          fontSize: 'var(--eb-text-2xl)',
          fontWeight: 'var(--eb-font-semibold)',
          margin: 0,
          color: 'var(--eb-text-primary)',
        }}>
          {extendMode ? `Extend team: ${form.teamName || form.teamId}` : 'Team Setup'}
        </h1>
        <p style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-secondary)',
          marginTop: 'var(--eb-space-2)',
          marginBottom: 0,
        }}>
          {extendMode
            ? 'Add new roles to an existing team. Existing members and configuration are unchanged.'
            : 'Spin up a complete agent team — Business Analyst, Developer, Reviewers, and more — bound to one repository, in one shot.'}
        </p>
      </div>

      {infoMessage && (
        <div style={{
          padding: 'var(--eb-space-3) var(--eb-space-4)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-status-warning)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
          display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center',
        }}>
          <AlertCircle size={15} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{infoMessage}</span>
          <button
            onClick={() => setInfoMessage(null)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-text-muted)', display: 'flex', alignItems: 'center', padding: 0, flexShrink: 0 }}
          >
            <XCircle size={15} />
          </button>
        </div>
      )}

      {extendError && <ErrorBox message={extendError} />}

      <StepIndicator
        current={step}
        onStepClick={extendMode ? (idx) => { if (idx <= 3) setStep(idx); } : undefined}
      />

      {step === 0 && (extendMode
        ? (
          <StepTeam
            form={form}
            setForm={setForm}
            templates={templates}
            roleConfig={form.roleConfig}
            setRoleConfig={fn => setForm(f => ({ ...f, roleConfig: typeof fn === 'function' ? fn(f.roleConfig) : fn }))}
            error={stepError}
            extendMode={extendMode}
            existingRoles={existingRoles}
            existingRoleCounts={existingRoleCounts}
          />
        ) : (
          <StepProcess
            form={form}
            setForm={setForm}
            templates={templates}
            error={stepError}
          />
        )
      )}
      {step === 1 && (extendMode
        ? <StepEnvironmentReadOnly form={form} environments={environments} sshKeys={sshKeys} githubTokens={githubTokens} />
        : (
          <StepEnvironmentSelect
            form={form}
            environments={environments}
            envsLoading={envsLoading}
            refetchEnvs={refetchEnvs}
            onSelect={selectEnvironment}
            error={stepError}
          />
        )
      )}
      {step === 2 && (extendMode
        ? <StepProjectReadOnly form={form} />
        : <StepProject {...stepProps} environments={environments} takenAgentIds={takenAgentIds} error={stepError} />
      )}
      {step === 3 && (extendMode
        ? <StepKnowledgeReadOnly form={form} mcpServers={mcpServers} mcpCredentials={mcpCredentials} />
        : (
          <StepKnowledgeSummary
            form={form}
            setForm={setForm}
            poolSkills={poolSkills}
            environments={environments}
            mcpServers={mcpServers}
            mcpCredentials={mcpCredentials}
            error={stepError}
          />
        )
      )}
      {step === 4 && (
        <StepReview
          form={form}
          templates={templates}
          environments={environments}
          sshKeys={sshKeys}
          githubTokens={githubTokens}
          mcpServers={mcpServers}
          mcpCredentials={mcpCredentials}
          error={stepError}
          extendMode={extendMode}
          existingRoles={existingRoles}
          existingRoleCounts={existingRoleCounts}
        />
      )}

      {progressSteps && !result && (
        <ProgressCard steps={progressSteps} error={progressError} />
      )}

      {collisionInfo && !extendMode && (
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

          {!isLast && (extendMode && step > 0 ? (
            <button type="button" onClick={() => setStep(0)} style={primaryButtonStyle(false)}>
              <ArrowLeft size={16} /> Back to Roles
            </button>
          ) : (
            <button type="button" onClick={next} disabled={tplLoading || submitting} style={primaryButtonStyle(submitting || tplLoading)}>
              Next <ArrowRight size={16} />
            </button>
          ))}
          {isLast && (
            <button type="button" onClick={() => submit('create')} disabled={submitting} style={primaryButtonStyle(submitting)}>
              {submitting
                ? (extendMode ? 'Extending team…' : 'Creating team…')
                : (extendMode ? 'Extend team' : 'Create team')}
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
