/**
 * AgentLifecycleForms.jsx — the Clone / Import / Save-as-template dialog bodies.
 *
 * Moved verbatim out of Agents.jsx for #1928 (epic #1925 Phase 1), which
 * re-surfaces the same actions in Agent Chat's left rail. The ticket is explicit
 * that the dialogs are *shared, not duplicated*: both surfaces now render these
 * components, so a fix to the 409 id-conflict handling or the copy lands in both
 * places at once. Behaviour is unchanged from the Agents page.
 */
import React, { useState } from 'react';
import { Link } from 'react-router';

import FormInput from '../../components/FormInput';
import { sanitizeId } from '../../hooks/useAutoDerivedId';
import { PrimaryBtn, SecondaryBtn, labelStyle, inputStyle, helpTextStyle } from './form-kit.jsx';
import {
  suggestCloneTeamId, isValidCloneTeamId, suggestCloneTeamName, credentialsNeededLines, cloneResultNotice,
} from './clone-team-view.js';
import { OWN_TEAM_OPTION_LABEL, importConflictSeed } from './import-agent-view.js';

// Mirrors AGENT_ID_RE in admin-console/api/api.js — used only to give inline
// feedback before the server round-trip; the server remains the source of
// truth for validity.
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

// Suggests a unique clone id derived from the source id, avoiding any id
// already present in the agents list (server-side uniqueness is still
// enforced — this is just a friendlier starting point).
export function suggestCloneId(sourceId, existingIds) {
  const base = `${sourceId}-copy`;
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const errorBannerStyle = {
  color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
};
const bodyStyle = { display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' };
const leadStyle = { fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.55 };
const footerStyle = {
  display: 'flex', gap: 'var(--eb-space-2)',
  paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)',
};

/* ── Import Agent Form ──────────────────────────────────────────────── */
export function ImportAgentForm({ file, teams, onSubmit, onCancel }) {
  const [newId, setNewId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [parentTeamId, setParentTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await onSubmit({
        newId: newId.trim() || undefined,
        displayName: (newId.trim() && displayName.trim()) || undefined,
        parentTeamId: parentTeamId || undefined,
      });
      if (!ok) {
        if (data?.code === 'id-conflict') {
          setConflict(true);
          // Seed a free id and a distinguishable name so the operator can
          // just confirm (#2684).
          const seed = importConflictSeed(data, newId, displayName);
          setNewId(seed.newId);
          setDisplayName(seed.displayName);
          setError(data.error || 'That id is already in use — choose a different one.');
        } else {
          setError(data?.error || 'Import failed.');
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={bodyStyle}>
      {error && <div role="alert" style={errorBannerStyle}>{error}</div>}

      <div style={leadStyle}>
        Importing <strong style={{ color: 'var(--eb-text-primary)' }}>{file?.name}</strong>.
        The agent's memory, skills and repo clone are kept as-is; a fresh chat identity
        is provisioned on import, and the agent starts right away.
      </div>

      <div>
        <FormInput
          label={conflict ? 'New Agent ID *' : 'New Agent ID'}
          value={newId}
          onChange={setNewId}
          placeholder="leave blank to keep the exported id"
        />
        <div style={helpTextStyle}>
          {conflict
            ? 'The exported id already exists — pick an unused id to import under.'
            : 'Optional. Provide an id only to rename the agent or avoid a collision.'}
        </div>
      </div>

      {newId.trim() && (
        <div>
          <FormInput
            label="New Display Name"
            value={displayName}
            onChange={setDisplayName}
            placeholder="leave blank to keep the exported name"
          />
          <div style={helpTextStyle}>
            Shown in the agent list — give the copy a name you can tell apart from its source.
          </div>
        </div>
      )}

      <div>
        <div style={labelStyle}>
          Assign to Team
          <span style={{ marginLeft: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-normal)' }}>(optional)</span>
        </div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-1)' }}>
          Graft the imported agent into an existing team as a member. It inherits the
          team's working environment but keeps its own imported system prompt as an override.
          Leave as <em>Its own team</em> to import it as a team of one.
        </div>
        <select
          value={parentTeamId}
          onChange={e => setParentTeamId(e.target.value)}
          style={inputStyle}
        >
          <option value="">{OWN_TEAM_OPTION_LABEL}</option>
          {(teams || []).map(t => (
            <option key={t.id} value={t.id}>{t.displayName || t.id}</option>
          ))}
        </select>
      </div>

      <div style={footerStyle}>
        <PrimaryBtn onClick={submit} saving={busy} disabled={busy || (conflict && !newId.trim())}>
          {busy ? 'Importing…' : 'Import Agent'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Clone Agent Form ───────────────────────────────────────────────── */
// Direct "duplicate this agent" dialog — a one-step alternative to the
// Export → Import round trip. Only offered for `agent` and `team-member`
// sources (see buildAgentMenu in agent-lifecycle-menu.js); the backend clone
// endpoint also rejects any other role defensively.
export function CloneAgentForm({ agent, teams, existingIds, onSubmit, onCancel }) {
  const [newId, setNewId] = useState(() => suggestCloneId(agent.id, existingIds));
  const [newDisplayName, setNewDisplayName] = useState(`${agent.displayName || agent.id} (Copy)`);
  const [parentTeamId, setParentTeamId] = useState(agent.parentTeamId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const trimmedId = newId.trim();
  const idError = trimmedId && !AGENT_ID_RE.test(trimmedId)
    ? 'Only letters, digits, underscores, hyphens and dots are allowed.'
    : null;
  const canSubmit = trimmedId && !idError && newDisplayName.trim();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await onSubmit({
        newId: trimmedId,
        newDisplayName: newDisplayName.trim(),
        parentTeamId: parentTeamId || undefined,
      });
      if (!ok) {
        if (data?.code === 'id-conflict') {
          // The server's suggestion also accounts for the `<id>-team` a team
          // of one claims and for agents this list cannot see (#2684).
          setNewId(data.suggestedId || suggestCloneId(trimmedId, existingIds));
        }
        setError(data?.error || 'Clone failed.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={bodyStyle}>
      {error && <div role="alert" style={errorBannerStyle}>{error}</div>}

      <div style={leadStyle}>
        Cloning <strong style={{ color: 'var(--eb-text-primary)' }}>{agent.displayName}</strong> ({agent.id}).
        The clone gets its own workspace, prompt and chat identity — a fully independent
        copy, not a reference. Deleting one later never affects the other.
      </div>

      <FormInput
        label="New Agent ID"
        required
        value={newId}
        onChange={v => setNewId(sanitizeId(v))}
        error={idError}
        placeholder="e.g. cobol-agent-copy"
      />

      <FormInput
        label="New Display Name"
        required
        value={newDisplayName}
        onChange={setNewDisplayName}
        placeholder="COBOL Agent (Copy)"
      />

      <div>
        <div style={labelStyle}>Target Team</div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-1)' }}>
          Defaults to the source's own team (if any). Choose a different team, or
          <em> Its own team</em> to make the clone a team of one.
        </div>
        <select
          value={parentTeamId}
          onChange={e => setParentTeamId(e.target.value)}
          style={inputStyle}
        >
          <option value="">{OWN_TEAM_OPTION_LABEL}</option>
          {(teams || []).map(t => (
            <option key={t.id} value={t.id}>{t.displayName || t.id}</option>
          ))}
        </select>
      </div>

      <div style={footerStyle}>
        <PrimaryBtn onClick={submit} saving={busy} disabled={busy || !canSubmit}>
          {busy ? 'Cloning…' : 'Clone Agent'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Extract Template Form (#1509) ──────────────────────────────────── */
// "Save as template" — snapshot a live agent (standalone or team member) into
// a reusable, team-neutral user-tier Agent Template. Mirrors CloneAgentForm:
// a suggested unique id, a review/confirm dialog, and 409 id-conflict handling.
// The server is the source of truth for the mapping (effective prompt / skills /
// sessionPolicy / triggers) and for id uniqueness across both template tiers.

// Derive a slug-valid template id (lowercase letters/digits/hyphens) from an
// agent id, unique across the supplied existing-id set. Server still enforces.
export function suggestTemplateId(sourceId, existingIds) {
  const base = String(sourceId || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^-+/, '').replace(/-+$/, '') || 'agent-template';
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function ExtractTemplateForm({ agent, existingTemplateIds, onSubmit, onCancel }) {
  // Client-side pre-fill of the editable category/patternRole (AC-2); the
  // server re-infers if either is omitted. A team member or a per-invocation
  // agent reads as event-driven ("reactive"); otherwise a "chat" companion.
  const reactive = agent.role === 'team-member' || agent.sessionPolicy === 'per-invocation';
  const [templateId, setTemplateId] = useState(() => suggestTemplateId(agent.id, existingTemplateIds));
  const [displayName, setDisplayName] = useState(agent.displayName || agent.id);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(reactive ? 'reactive' : 'chat');
  const [patternRole, setPatternRole] = useState(reactive ? 'author' : 'companion');
  const [includeTriggers, setIncludeTriggers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // created template id

  const trimmedId = templateId.trim();
  const idError = trimmedId && !TEMPLATE_ID_RE.test(trimmedId)
    ? 'Lowercase letters, digits and hyphens only; must not start with a hyphen.'
    : null;
  const canSubmit = trimmedId && !idError && displayName.trim();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await onSubmit({
        id: trimmedId,
        displayName: displayName.trim(),
        description: description.trim() || undefined,
        category,
        patternRole,
        includeTriggers,
      });
      if (ok) {
        setDone(data?.id || trimmedId);
      } else {
        if (data?.code === 'id-conflict') {
          setTemplateId(suggestTemplateId(trimmedId, existingTemplateIds));
        }
        setError(data?.error || 'Could not save template.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={bodyStyle}>
        <div style={leadStyle}>
          Saved <strong style={{ color: 'var(--eb-text-primary)' }}>{agent.displayName}</strong> as the
          Agent Template <strong style={{ color: 'var(--eb-text-primary)' }}>{done}</strong>. It now appears on the
          Agent Templates page with a <em>Custom</em> badge, ready to create new agents from.
        </div>
        <div style={footerStyle}>
          <Link
            to="/role-templates"
            style={{
              display: 'inline-flex', alignItems: 'center', padding: '8px 16px',
              borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-accent-primary)',
              color: 'var(--eb-text-inverted)', fontWeight: 600, textDecoration: 'none',
              fontSize: 'var(--eb-text-sm)',
            }}
          >
            Open Agent Templates
          </Link>
          <SecondaryBtn onClick={onCancel}>Close</SecondaryBtn>
        </div>
      </div>
    );
  }

  return (
    <div style={bodyStyle}>
      {error && <div role="alert" style={errorBannerStyle}>{error}</div>}

      <div style={leadStyle}>
        Captures <strong style={{ color: 'var(--eb-text-primary)' }}>{agent.displayName}</strong> ({agent.id})
        — its effective prompt, skills and configuration — as a reusable, team-neutral Agent
        Template. This is a one-shot snapshot: the agent is left unchanged and stays independent
        of the template. The template appears on the <em>Agent Templates</em> page.
      </div>

      <FormInput
        label="Template ID"
        required
        value={templateId}
        onChange={v => setTemplateId(v)}
        error={idError}
        placeholder="e.g. tuned-developer"
      />

      <FormInput
        label="Display Name"
        required
        value={displayName}
        onChange={setDisplayName}
        placeholder="e.g. Tuned Developer"
      />

      <FormInput
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="What this template is for (optional)"
      />

      <div>
        <div style={labelStyle}>Role type</div>
        <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle}>
          <option value="chat">chat — always-on companion; responds to direct messages</option>
          <option value="reactive">reactive — event-driven; wakes on GitHub / label triggers</option>
          <option value="pattern">pattern — scaffold role</option>
        </select>
      </div>

      <div>
        <div style={labelStyle}>Pattern role</div>
        <select value={patternRole} onChange={e => setPatternRole(e.target.value)} style={inputStyle}>
          {['scout', 'author', 'companion', 'intake', 'standalone'].map(r => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={includeTriggers}
          onChange={e => setIncludeTriggers(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--eb-text-primary)' }}>Include triggers</strong> — carry the agent's
          triggers into the template. Off by default; leave off for a prompt-and-skills-only template.
        </span>
      </label>

      <div style={footerStyle}>
        <PrimaryBtn onClick={submit} saving={busy} disabled={busy || !canSubmit}>
          {busy ? 'Saving…' : 'Save as template'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Clone Team Form (#2171, epic #2166 A5) ─────────────────────────── */
// Clones a team's STRUCTURE (repositories, MCP refs, toolchain, additional
// context, process wiring) into a brand new team — never its credentials.
// `onSubmit` does the two-step work server-side supplies no single endpoint
// for (create the credential-stripped environment, then materialize the team
// from the source's exported process bundle) and returns the parsed team
// response, whose `credentialsNeeded` this form renders so the creator knows
// exactly what to add before materializing the new team's members.
export function CloneTeamForm({ team, existingIds, onSubmit, onCancel }) {
  const [teamId, setTeamId] = useState(() => suggestCloneTeamId(team.id, existingIds));
  const [teamName, setTeamName] = useState(() => suggestCloneTeamName(team.displayName || team.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // the server's team-create response

  const trimmedId = teamId.trim();
  const idError = trimmedId && !isValidCloneTeamId(trimmedId)
    ? 'Lowercase letters, digits and hyphens only; must not start with a hyphen.'
    : null;
  const canSubmit = trimmedId && !idError && teamName.trim();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await onSubmit({ teamId: trimmedId, teamName: teamName.trim() });
      if (ok) {
        setDone(data);
      } else {
        if (data?.code === 'id-conflict' || /already exists/.test(data?.error || '')) {
          setTeamId(suggestCloneTeamId(trimmedId, existingIds));
        }
        setError(data?.error || 'Clone failed.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const needs = credentialsNeededLines(done.credentialsNeeded);
    return (
      <div style={bodyStyle}>
        <div style={leadStyle}>{cloneResultNotice(done)}</div>
        {needs.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            {needs.map((line, i) => (<li key={i}>{line}</li>))}
          </ul>
        )}
        <div style={footerStyle}>
          <Link
            to={`/chats/${encodeURIComponent(done.teamId)}`}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: '8px 16px',
              borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-accent-primary)',
              color: 'var(--eb-text-inverted)', fontWeight: 600, textDecoration: 'none',
              fontSize: 'var(--eb-text-sm)',
            }}
          >
            Open the new team
          </Link>
          <SecondaryBtn onClick={onCancel}>Close</SecondaryBtn>
        </div>
      </div>
    );
  }

  return (
    <div style={bodyStyle}>
      {error && <div role="alert" style={errorBannerStyle}>{error}</div>}

      <div style={leadStyle}>
        Clones <strong style={{ color: 'var(--eb-text-primary)' }}>{team.displayName || team.id}</strong>'s
        structure — its repository URLs and branches, MCP server references, toolchain and additional
        context — into a brand new team. Credentials (SSH keys, the GitHub token, MCP credentials) are
        never copied; the new team's members are created as stubs so nothing is cloned or attempted until
        you supply them and materialize.
      </div>

      <FormInput
        label="New Team ID"
        required
        value={teamId}
        onChange={v => setTeamId(sanitizeId(v).toLowerCase())}
        error={idError}
        placeholder="e.g. payments-team-clone"
      />

      <FormInput
        label="New Team Name"
        required
        value={teamName}
        onChange={setTeamName}
        placeholder="e.g. Payments Team (Clone)"
      />

      <div style={footerStyle}>
        <PrimaryBtn onClick={submit} saving={busy} disabled={busy || !canSubmit}>
          {busy ? 'Cloning…' : 'Clone team'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}
