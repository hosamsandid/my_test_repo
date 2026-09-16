import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowLeft, ArrowRight, Check, AlertCircle, Github,
  Layers, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import SkillPicker from '../components/SkillPicker';
import PageHelpButton from '../components/PageHelpButton';
import KnowledgeLearningSections, {
  KNOWLEDGE_LEARNING_DEFAULTS, AUTONOMY_LEVELS, GATE_ORDER, GATE_LABELS,
} from '../components/KnowledgeLearningConfig';
import StepProcess, { BundleRolesSummary, BundleFlowPreview, LintBadges } from './team-setup/StepProcess';
import { buildReviewFields } from './team-setup/review-fields';
// The shared "Launch" step (#1668, epic #1661 Phase E) — the same component the
// Flows-canvas Materialize dialog renders, so the two front doors that turn a
// design into running agents can't diverge. It owns the streaming submit +
// progress/collision/error feedback; the wizard collects the team identity on
// its earlier steps and shows only the extend / materialize-now toggles here.
import LaunchStep from './process/LaunchStep';
import { useHelpSubject } from '../context/HelperChatContext.jsx';
// The id/suffix rules live in the shared launch core (single source with the
// Materialize dialog AND, byte-identically, with the server's TEAM_ID_RE /
// SUFFIX_RE) so the wizard can never drift from either (#1934 AC2/AC5).
import {
  slugify,
  sanitizeTeamIdInput,
  normalizeTeamId,
  sanitizeLabelSuffixInput,
  teamIdError,
  labelSuffixError,
  TEAM_ID_RE,
  SUFFIX_RE,
  TEAM_ID_HINT,
  SUFFIX_HINT,
  TEAM_ID_ERROR,
  SUFFIX_ERROR,
  TEAM_ID_MAX,
  SUFFIX_MAX,
} from './process/launch-team.js';

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

// Process first (#428): the process choice is the entry decision — everything
// else (environment, name, knowledge) qualifies it. The step lands directly on
// the template/draft gallery (#1703); describe/blank-canvas authoring lives in
// the "+ Create" launcher.
const STEPS = ['Process', 'Environment', 'Team', 'Knowledge (optional)', 'Review'];

// The help-context key per step (E17 #1892). A wizard step is a sub-state of one
// route, so it has no pathname of its own: the page publishes `<step>` and the
// panel resolves `/team-setup#<step>` before falling back to the wizard's own
// topic — which is how step-specific help can be authored later without touching
// this wiring again. Index-aligned with STEPS; the labels are display copy and
// change, these keys are the contract (registered in help-routes.js CONTEXT_KEYS).
const STEP_HELP_IDS = ['process', 'environment', 'team', 'knowledge', 'review'];

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
    // Trim a dash the truncation may have landed on, so the counter suffix
    // can't produce a doubled dash (`acme--2`).
    const slug = baseSlug.slice(0, TEAM_ID_MAX - suffix.length).replace(/-+$/, '') + suffix;
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
function StepProject({ form, setForm, environments, takenAgentIds, takenTeamNames, error }) {
  const env = (environments || []).find(e => e.id === form.environmentId);
  // Non-blocking duplicate-name warning (#1455): the name is cosmetic (the ID is
  // the unique key), so a collision only warns — the user may still advance.
  // Compared trimmed + lowercased, matching how takenTeamNames is built; empty
  // names are handled by the existing "Team name required" blocking check.
  const trimmedName = form.teamName.trim().toLowerCase();
  const duplicateName = !!trimmedName && takenTeamNames?.has(trimmedName);
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
          {duplicateName && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', marginTop: 'var(--eb-space-2)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
              <AlertTriangle size={12} style={{ flexShrink: 0 }} /> Another team already uses this name. Names don't have to be unique (the ID is the identifier) — you can still continue.
            </div>
          )}
        </div>

        <div>
          <label htmlFor="ts-team-id" style={labelStyle}>Team ID (slug)</label>
          <input
            id="ts-team-id"
            type="text"
            placeholder="acme-demo"
            value={form.teamId}
            maxLength={TEAM_ID_MAX}
            // Gentle live sanitising only — a dash you just typed stays put
            // (#1934 AC1); the value is settled on blur.
            onChange={e => setForm(f => ({ ...f, teamId: sanitizeTeamIdInput(e.target.value), teamIdManuallyEdited: true }))}
            onBlur={e => setForm(f => ({ ...f, teamId: normalizeTeamId(e.target.value) }))}
            style={inputStyle}
          />
          <div style={hintStyle}>{TEAM_ID_HINT} Resources will be named <code>{form.teamId || '<slug>'}-developer</code>, etc.</div>
          {teamIdError(form.teamId) && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 'var(--eb-space-2)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {teamIdError(form.teamId)}
            </div>
          )}
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
              placeholder="e.g. team-1"
              value={form.labelSuffix}
              maxLength={SUFFIX_MAX}
              onChange={e => setForm(f => ({ ...f, labelSuffix: sanitizeLabelSuffixInput(e.target.value) }))}
              style={{ ...inputStyle, flex: 1 }}
            />
            <SuggestSuffixButton onSuggest={suffix => setForm(f => ({ ...f, labelSuffix: suffix }))} />
          </div>
          <div style={hintStyle}>
            <strong>Leave this blank</strong> unless another agent team already uses the <strong>same GitHub repo</strong>. In that case, a short suffix is added to every label this team uses so the two teams&apos; issue/PR labels don&apos;t wake each other&apos;s agents. {SUFFIX_HINT}
          </div>
          {labelSuffixError(form.labelSuffix) && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 'var(--eb-space-2)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {labelSuffixError(form.labelSuffix)}
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
  // Repo-less environments are selectable too (#1623 / #1668 AC6): the team runs
  // without a repository — chat + skills only, no GitHub hand-offs. The card
  // still says so, but no longer blocks the pick.
  const selectable = true;
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--eb-space-2)', minWidth: 0 }}>
          <div
            title={env.name}
            style={{
              fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)',
              flex: '1 1 auto', minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {env.name}
          </div>
          <code
            title={env.id}
            style={{
              fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)',
              flex: '0 1 auto', minWidth: '4.5em', maxWidth: '55%',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              // The disambiguating suffix (#2217's `-2`/`-3`) sits at the END of
              // the id, but plain ellipsis+nowrap truncates from the end — so
              // two ids differing only in that suffix render identically
              // truncated (AC5, reviewer finding on #2228). Rendering the box
              // right-to-left flips which end the ellipsis eats: the id's own
              // characters stay LTR (they're plain ASCII, so the bidi
              // algorithm keeps them in source order), but the *overflow* now
              // clips the START of the string instead of the end.
              direction: 'rtl',
              textAlign: 'left',
            }}
          >
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-text-muted)' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} />
              No repository — the team runs without one (chat + skills only; no GitHub hand-offs).
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

function StepEnvironmentSelect({
  form, environments, envsLoading, refetchEnvs, onSelect, error,
  envTemplates, envTemplatesLoading, refetchEnvTemplates, onSelectTemplate, templateMinting,
}) {
  const envs = environments || [];
  const templates = envTemplates || [];
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
          {/* E14 (#1888): the step's own restatement of what the wizard builds is
              gone — that belongs to the team-setup topic. What remains is the one
              line that names the immediate input. */}
          <p style={{ margin: 0 }}>
            Optionally reuse an existing <strong style={{ color: 'var(--eb-text-primary)' }}>Environment</strong> —
            it already bundles the repository, credentials and knowledge sources. Pick nothing and the team
            gets a fresh, repo-less one of its own (#2168 A2 — no environment to name or find first).
          </p>
        </div>

        {/* Start from a template (#2170, epic #2166 A4). Distinct from reusing an
            existing environment below: a template is a curated copy source, so
            picking one mints a brand-new environment seeded from its structure —
            the team gets its OWN environment, never a live binding to the
            template, and never the template's credentials. */}
        {templates.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
              Start from a template
            </div>
            <div style={{ ...hintStyle, marginTop: 0 }}>
              A System-Admin-curated starting point. Repositories, MCP pairings, model provider,
              toolchain and additional context are copied into a fresh environment of your own —
              credentials are never copied, so you supply your own afterwards.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--eb-space-3)' }} role="radiogroup" aria-label="Environment template">
              {templates.map(t => (
                <EnvironmentCard
                  key={t.id}
                  env={t}
                  selected={false}
                  onSelect={() => { if (!templateMinting) onSelectTemplate?.(t); }}
                />
              ))}
            </div>
            {templateMinting && <div style={{ ...hintStyle, marginTop: 0 }}>Creating environment from template…</div>}
          </div>
        )}

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
              No working environment exists yet — that&apos;s fine, click <strong>Next</strong> and one will be
              created for this team automatically.
            </div>
            <button type="button" onClick={refetchEnvs} style={secondaryButtonStyle()}>
              Refresh list
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--eb-space-3)' }} role="radiogroup" aria-label="Environment">
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
              Not picking one is fine too — click <strong>Next</strong> and the team gets its own, freshly
              created. To change an existing one, open its owning team and use the <strong>Settings</strong>{' '}
              tab's Environment section in Agent Chat.
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
          {/* E14 (#1888): why only global skills are offered here (the team-tier
              pool does not exist yet) is in the team-setup topic. */}
          <div style={{ ...hintStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
            Skills from the global pool the whole team starts with — every member inherits them.
          </div>
          <SkillPicker
            skills={poolSkills || []}
            selected={form.skills || []}
            onChange={v => setForm(f => ({ ...f, skills: v }))}
          />
        </div>
        {/* E14 (#1888): what an MCP knowledge source is, why the set is read-only
            here and where per-member overrides happen moved to the topic. The
            live pointer (which environment it comes from, how to change it, and
            that the step is optional) stays — it guides this step's decision. */}
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
          Knowledge sources are inherited read-only from the working environment{env ? <> <strong style={{ color: 'var(--eb-text-primary)' }}>{env.name}</strong></> : null};
          change them from that environment's owning team, in Agent Chat's Settings tab.
          {' '}<strong style={{ color: 'var(--eb-text-primary)' }}>This step is optional</strong> — just continue if the inherited set looks right.
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
        {/* Knowledge learning configuration (#567). Collapsed by default (#1131):
            autonomy levels + promotion gates are advanced concepts that overwhelm
            a first-time team creator, and the step is optional with sensible
            defaults — so hide them behind a closed disclosure with a one-line
            summary, keeping the skill picker above always visible. */}
        <details
          style={{
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            background: 'var(--eb-bg-surface)',
            padding: 'var(--eb-space-3) var(--eb-space-4)',
          }}
        >
          <summary style={{ cursor: 'pointer' }}>
            <span style={{ ...labelStyle, display: 'inline', marginBottom: 0 }}>Advanced: knowledge learning</span>
            <span style={{ ...hintStyle, marginTop: 'var(--eb-space-1)', display: 'block' }}>
              Controls how much the team auto-learns from its work — defaults are fine to start.
            </span>
          </summary>
          <div style={{ marginTop: 'var(--eb-space-3)' }}>
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
        </details>

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
//
// E14 (#1888) KEPT this notice: it states the consequence of a consequential
// click, the same reason the Model-Provider single-user rule and the Token-Usage
// cost note stayed on their pages. Only the follow-up advice (staging the
// rollout by disabling members on the Agents page) moved into the team-setup
// topic, reachable from the "?" next to the heading.
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
        <div style={{
          fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-warning)',
          marginBottom: 'var(--eb-space-1)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        }}>
          What happens next
          <PageHelpButton label="What does Create team provision?" size={13} style={{ padding: 0, flexShrink: 0, color: 'var(--eb-status-warning)' }} />
        </div>
        <p style={{ margin: 0 }}>
          Creating the team provisions {agents} that go live immediately and begin watching{' '}
          {repoLabel ? <code>{repoLabel}</code> : 'the bound repository'} for issues and pull requests,
          acting autonomously from that moment.
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

// ─── Main wizard ─────────────────────────────────────────────────────
export default function TeamSetup() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState(null);

  // Tell the help panel which step is showing (E17 #1892) — the step is a
  // sub-state of one route, so nothing else can know it.
  useHelpSubject({ step: STEP_HELP_IDS[step] || '' });
  // The shared LaunchStep owns the submit/progress state now; the wizard only
  // needs to know when a launch is in flight (to lock the Back button).
  const [launchBusy, setLaunchBusy] = useState(false);

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
    // Launch toggles surfaced by the shared LaunchStep on the Review step.
    // materializeNow defaults on — the wizard has always materialized members
    // immediately (the backend default), now made explicit (#1668).
    extend: false,
    materializeNow: true,
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
    processMode: null,        // null | 'template' (describe/blank moved to "+ Create", #1703)
    processTemplateId: null,  // 'registry:<id>' | 'draft:<id>'
    processBundle: null,      // processTemplateVersion-1 bundle
    processLints: null,       // authoritative lints for the current bundle
  });

  const { data: templatesResp, loading: tplLoading } = useApi('/api/agent-templates');
  const { data: environments, loading: envsLoading, refetch: refetchEnvs } = useApi('/api/environments');
  // Environment Templates (#2170, epic #2166 A4) — a System-Admin-curated copy
  // source, NOT the same thing as the process/role `templatesResp` above. Open
  // to any authenticated caller (the catalog read), so no admin gate is needed
  // here.
  const { data: envTemplates, loading: envTemplatesLoading, refetch: refetchEnvTemplates } = useApi('/api/environments?isTemplate=true');
  const { data: agentsList } = useApi('/api/agents');
  const { data: sshKeys } = useApi('/api/ssh-keys');
  const { data: githubTokens } = useApi('/api/github-tokens');
  const { data: mcpServers } = useApi('/api/mcp-servers');
  const { data: mcpCredentials } = useApi('/api/mcp-credentials');
  const { data: skillsData } = useApi('/api/skills');
  // #2179: block team creation on a platform with no registered model
  // provider — mirrors the server-side check in POST /api/teams(/stream).
  const { data: llmEndpoints, loading: llmEndpointsLoading } = useApi('/api/llm-endpoints');
  const hasUsableProvider = llmEndpointsLoading ? undefined : (Array.isArray(llmEndpoints) && llmEndpoints.length > 0);
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
  // Lowercased display names of existing Agent Teams — used only to WARN (never
  // block) about a duplicate team name on the Team step (#1455). Built the same
  // way suggestTeamNaming's `takenNames` is (role === 'team', trimmed +
  // lowercased) so the warning is consistent with the auto-suggestion.
  const takenTeamNames = useMemo(
    () => new Set(
      (Array.isArray(agentsList) ? agentsList : [])
        .filter(a => a.role === 'team')
        .map(a => String(a.displayName || '').trim().toLowerCase()),
    ),
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

  // Start from a template (#2170, epic #2166 A4): a template is a copy source,
  // never a live-shared binding, so picking one mints a brand-new, real
  // environment (`copyFromTemplateId`) rather than binding to the template
  // directly — the server refuses that outright (`template-not-bindable`).
  // Once minted, the fresh environment is an ORDINARY reused environment, so
  // `selectEnvironment` handles the rest unchanged (repo/creds/MCP pull,
  // team-name suggestion, step advance) — no separate code path downstream.
  const [templateMinting, setTemplateMinting] = useState(false);
  async function selectTemplate(template) {
    setStepError(null);
    setTemplateMinting(true);
    try {
      const suffix = Math.random().toString(36).slice(2, 8);
      const minted = await apiCall('POST', '/api/environments', {
        id: `${template.id}-${suffix}`,
        name: template.name,
        description: template.description || '',
        copyFromTemplateId: template.id,
      });
      // The minted record is an ORDINARY environment now — refresh the reuse
      // list so it appears there too if the user navigates back to this step.
      refetchEnvs();
      selectEnvironment(minted);
    } catch (e) {
      setStepError(e.message);
    } finally {
      setTemplateMinting(false);
    }
  }

  // Create mode composes the team via the Process step (#422).

  function validateStep(f = form) {
    if (step === 0) {
      if (!f.processBundle || (f.processBundle.roles || []).length === 0) {
        return 'Pick a process template or saved draft first';
      }
      if ((f.processLints || []).some(l => l.severity === 'error')) {
        return 'The process has wiring errors — fix them before continuing';
      }
      return null;
    }
    if (step === 1) {
      // Picking a Working Environment is optional (#2168 A2): a team can be
      // created with none at all, exactly like the repo-less case (#1623 /
      // #1668 AC6) — `launchExtraBody()` falls through to the auto-created,
      // repo-less environment when none is selected here.
      return null;
    }
    if (step === 2) {
      if (!f.teamName.trim()) return 'Team name required';
      if (!TEAM_ID_RE.test(f.teamId)) return TEAM_ID_ERROR;
      if (takenAgentIds.has(f.teamId)) return `Team ID '${f.teamId}' is already used by an existing agent or team — pick a different one (to add agents to an existing team, open it in the Flow Editor)`;
      if (f.labelSuffix && !SUFFIX_RE.test(f.labelSuffix)) return SUFFIX_ERROR;
      return null;
    }
    // Step 3 — Knowledge sources are inherited from the environment and
    // optional — nothing to validate.
    return null;
  }

  function next() {
    // Settle a mid-edit team id first (a dash typed last is legal while typing
    // but not at submit position, #1934 AC1) and validate the settled value, so
    // "Next" doesn't report a trailing dash the blur has already removed.
    const settled = { ...form, teamId: normalizeTeamId(form.teamId) };
    if (settled.teamId !== form.teamId) setForm(f => ({ ...f, teamId: normalizeTeamId(f.teamId) }));
    const err = validateStep(settled);
    if (err) { setStepError(err); return; }
    setStepError(null);
    setStep(s => Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStepError(null);
    setStep(s => Math.max(s - 1, 0));
  }

  // Land on the Business Analyst chat when it was created, else the first
  // created agent. Falls through to /chats if nothing was created (it was
  // /agents until #1930 removed that page).
  function landingAgent(created) {
    const ba = (created || []).find(id => id.endsWith('-business-analyst'));
    return ba || (created || [])[0] || null;
  }

  // Entry-point-specific POST fields the shared LaunchStep passes through as
  // `extra` (the canonical teamId/teamName/mode/environmentId/labelSuffix/
  // materializeMembers/processTemplate are built by buildLaunchBody). The legacy
  // repository/githubTokenId/mcpServers fallback is only sent when no
  // environmentId is known (never today — the env step requires one).
  function launchExtraBody() {
    const extra = {
      readyLabel: (form.readyLabel || 'ready').trim() || 'ready',
      dispatchLabel: (form.dispatchLabel || 'dispatch').trim() || 'dispatch',
      maxParallel: Number.isInteger(form.maxParallel) ? form.maxParallel : 1,
      // Initial team skill set — placed on the team agent.
      skills: form.skills || [],
    };
    // Knowledge learning config (#567) — the backend drops it when it matches
    // the defaults (no behaviour change vs today's wizard, AC-4).
    if (form.knowledgeConfig) extra.knowledgeConfig = form.knowledgeConfig;
    if (!form.environmentId) {
      extra.repository = { url: form.repoUrl.trim(), branch: form.branch.trim() || 'main', sshKeyId: form.sshKeyId };
      extra.githubTokenId = form.githubTokenId;
      extra.mcpServers = (form.mcpSelections || []).filter(s => s.serverId);
    }
    return extra;
  }

  // On a successful launch, land on the Business Analyst chat when it was
  // created, else the first created agent (unchanged behaviour). Keep the brief
  // success card visible before navigating away.
  function onLaunchComplete(result) {
    const land = landingAgent(result?.created);
    setTimeout(() => {
      if (land) navigate(`/chats/${land}`);
      else navigate('/chats');
    }, 1500);
  }

  const stepProps = { form, setForm };
  const isLast = step === STEPS.length - 1;

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
      <div>
        <h2 style={{
          fontSize: 'var(--eb-text-2xl)',
          fontWeight: 'var(--eb-font-semibold)',
          margin: 0,
          color: 'var(--eb-text-primary)',
        }}>
          Agent Team Wizard
        </h2>
        {/* One-line description + "?" (E14, #1888). The Agent-Team-vs-access-scope
            distinction and what each step decides live in the team-setup topic.
            The "?" follows the current step, not just the route (E17, #1892):
            useHelpSubject() above publishes the step, so this one button resolves
            to the step's help — no second affordance next to the title. */}
        <p style={{
          fontSize: 'var(--eb-text-md)',
          color: 'var(--eb-text-secondary)',
          marginTop: 'var(--eb-space-2)',
          marginBottom: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
        }}>
          <span>
            Spin up a complete agent team — Business Analyst, Developer, Reviewers, and more — bound to one repository, in one shot.
          </span>
          <PageHelpButton label="What do these steps do, and what gets created?" size={14} style={{ padding: 0, flexShrink: 0 }} />
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
          envTemplates={envTemplates}
          envTemplatesLoading={envTemplatesLoading}
          refetchEnvTemplates={refetchEnvTemplates}
          onSelectTemplate={selectTemplate}
          templateMinting={templateMinting}
          error={stepError}
        />
      )}
      {step === 2 && (
        <StepProject {...stepProps} environments={environments} takenAgentIds={takenAgentIds} takenTeamNames={takenTeamNames} error={stepError} />
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

      {/* Non-final steps keep the Back / Next nav. */}
      {!isLast && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--eb-space-3)' }}>
          <button
            type="button"
            onClick={back}
            disabled={step === 0}
            style={{
              ...secondaryButtonStyle(),
              opacity: step === 0 ? 0.4 : 1,
              cursor: step === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <ArrowLeft size={16} /> Back
          </button>
          <button type="button" onClick={next} disabled={tplLoading} style={primaryButtonStyle(tplLoading)}>
            Next <ArrowRight size={16} />
          </button>
        </div>
      )}

      {/* The final step delegates the launch to the shared LaunchStep — the same
          component the Flows-canvas Materialize dialog renders (#1668). The team
          identity + environment are already collected on earlier steps, so only
          the extend / materialize-now toggles show here; LaunchStep owns the
          "Create team" button, the streaming submit, and the progress /
          collision / rollback / success feedback. */}
      {isLast && (
        <LaunchStep
          bundle={form.processBundle}
          environments={environments}
          values={form}
          onChange={patch => setForm(f => ({ ...f, ...patch }))}
          fields={['extend', 'materializeNow']}
          extraBody={launchExtraBody()}
          onComplete={onLaunchComplete}
          onBusyChange={setLaunchBusy}
          hasUsableProvider={hasUsableProvider}
          leftAction={(
            <button
              type="button"
              onClick={back}
              disabled={launchBusy}
              style={{
                ...secondaryButtonStyle(),
                opacity: launchBusy ? 0.4 : 1,
                cursor: launchBusy ? 'not-allowed' : 'pointer',
              }}
            >
              <ArrowLeft size={16} /> Back
            </button>
          )}
        />
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
