/**
 * AgentCreateForm.jsx — the direct "create one agent, I know what I want" form.
 *
 * Moved verbatim out of Agents.jsx for #1956 (epic #1925): the Create launcher
 * gained a fifth entry that hosts this form, so the direct create path survives
 * the Agents page's removal. The ticket is explicit that the form is *shared,
 * not duplicated* — `/create` and (while it exists) the Agents page render this
 * one component, so a change to a field, to the validation gate or to the POST
 * lands on both surfaces at once. Same route the dialog bodies (#1928) and the
 * edit form (#1929) already took into `agent-lifecycle/`.
 *
 * Behaviour is unchanged from the Agents page. The role picker (`RoleCard`) and
 * the `hasRepos` helper came along because nothing else on that page used them.
 *
 * The caller owns the request: `onSave(form)` receives the raw form object and
 * POSTs it to `/api/agents`; `saving` / `error` render the busy and failure
 * states. The form itself never calls the API.
 */
import React, { useState } from 'react';
import { Link } from 'react-router';
import { Info } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import FormInput from '../../components/FormInput';
import IdField from '../../components/IdField';
import { ID_FORMAT_HINT } from '../../components/id-field-view';
import SkillPicker from '../../components/SkillPicker';
import useAutoDerivedId from '../../hooks/useAutoDerivedId';
import { describeAgentSubmitState } from '../agent-create-submit-state.js';
import {
  labelStyle, inputStyle, helpTextStyle, PrimaryBtn, SecondaryBtn,
} from './form-kit.jsx';
import { ROLE_INFO, RoleHelpTip } from './agent-form-fields.jsx';

const hasRepos = (env) =>
  (Array.isArray(env?.repositories) && env.repositories.length > 0) ||
  !!env?.repository?.url;

/* ── Role picker ───────────────────────────────────────────────────────
   Card-style radio group. Single source of truth for what each role
   means; same component is reused for the in-form info banner. */

function RoleCard({ value, current, onSelect }) {
  const info = ROLE_INFO[value];
  if (!info) return null;
  const Icon = info.icon;
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      style={{
        textAlign: 'left',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: 'var(--eb-space-3)',
        alignItems: 'flex-start',
        padding: 'var(--eb-space-3)',
        background: active ? 'var(--eb-bg-elevated)' : 'var(--eb-bg-surface)',
        border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-md)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'var(--eb-text-primary)',
        outline: active ? '2px solid var(--eb-accent-primary)' : 'none',
        outlineOffset: -2,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 'var(--eb-radius-md)',
        background: active ? 'var(--eb-accent-primary)' : 'var(--eb-bg-app)',
        color: active ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)',
        flexShrink: 0,
      }}>
        <Icon size={15} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)' }}>
          {info.title}
        </span>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
          {info.short}
        </span>
      </span>
      <span
        aria-hidden="true"
        style={{
          width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
          marginTop: 4,
          border: `2px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
          background: active ? 'var(--eb-accent-primary)' : 'transparent',
          boxShadow: active ? 'inset 0 0 0 3px var(--eb-bg-elevated)' : 'none',
        }}
      />
    </button>
  );
}

/* ── Agent Create Form ─────────────────────────────────────────────── */
export default function AgentCreateForm({ onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    id: '', displayName: '', role: 'agent', environmentId: '', systemPrompt: '',
    skills: [],
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName: v => update('displayName', v),
    setId:   v => update('id', v),
    getName: () => form.displayName,
  });
  const { data: environments } = useApi('/api/environments');
  const envs = environments || [];
  // Create form has no team context yet, so only the global pool is offered
  // (grant-aware picker, #633 — team skills appear once the agent belongs to a
  // team and is edited).
  const { data: skillsData } = useApi('/api/skills');
  const poolSkills = (skillsData || []).filter(s => s.source === 'pool');

  // System prompt is optional for a team: members can be given their own
  // per-role prompts later, so a team can be created without a default. The
  // pure helper derives the gate AND the ordered list of unmet requirements
  // from one place, so the disabled button and the "why" hint below can never
  // disagree.
  const { canSubmit, reasons: submitBlockers } = describeAgentSubmitState(form);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <div>
        <FormInput label="Display Name *" value={form.displayName} onChange={handleNameChange} placeholder="COBOL Agent" />
        <div style={helpTextStyle}>
          A short, human-readable label shown in the agents list and chat header — e.g. <em>COBOL Agent</em>.
        </div>
      </div>

      <IdField
        value={form.id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        placeholder="e.g. cobol-agent"
        helpText={
          <>
            Auto-derived from Display Name; edit to override.
            {' '}{ID_FORMAT_HINT} Used as the agent's URL
            (<code>/chats/{form.id || 'id'}</code>) and the workspace folder name.
            <strong> Cannot be changed after creation.</strong>
          </>
        }
      />

      <div>
        <div style={labelStyle}>Working Environment <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <select value={form.environmentId} onChange={e => update('environmentId', e.target.value)} style={inputStyle} disabled={envs.length === 0}>
          <option value="">— please select —</option>
          {envs.map(env => (
            <option key={env.id} value={env.id}>
              {env.name} ({env.id})
              {hasRepos(env) ? ' · Git' : ''}
            </option>
          ))}
        </select>
        <div style={helpTextStyle}>
          Defines the repositories, GitHub token and model provider the agent receives at creation time.
          Manage these on the <em>Working Environments</em> page. Each agent gets its own isolated workspace,
          but the recipe is shared.
        </div>
        {envs.length === 0 && (
          <div style={{
            marginTop: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-status-warning-bg)',
            border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-primary)',
          }}>
            {/* #1956 edge case: on `/create` this form is reachable on a stack
                that has no environment at all, and the picker above is already
                disabled. Rather than a dead end, the card links to the page that
                fixes it — the same "warning card with a direct link" the other
                launcher paths use. */}
            No Working Environments yet — create one on the{' '}
            <Link to="/environments" style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-semibold)' }}>
              Working Environments
            </Link>{' '}
            page first.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        {/* The role explanation is a "?" on the label rather than a box below
            the cards (#2026): it follows the selection and costs no height in a
            form whose subject is the prompt. */}
        <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <span>Role <span style={{ color: 'var(--eb-status-error)' }}>*</span></span>
          <RoleHelpTip role={form.role} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <RoleCard value="agent" current={form.role} onSelect={v => update('role', v)} />
          <RoleCard value="team"  current={form.role} onSelect={v => update('role', v)} />
        </div>
        {(form.role === 'team' || form.role === 'team-member') && (
          <div style={{
            display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
            padding: 'var(--eb-space-3)',
            background: 'color-mix(in srgb, var(--eb-accent-primary) 8%, transparent)',
            border: '1px solid var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-primary)',
            lineHeight: 1.6,
          }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-accent-primary)' }} />
            <span>
              Consider using the{' '}
              <Link to="/team-setup" style={{ color: 'var(--eb-accent-primary)' }}>
                Agent Team Wizard
              </Link>{' '}
              instead — it sets up the full team structure automatically.
            </span>
          </div>
        )}
      </div>

      <div>
        <div style={labelStyle}>Skills</div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
          {form.role === 'team'
            ? "The whole team's skill set, copied into every member's workspace at seed time — members inherit it unless they set their own override."
            : "Skills copied into this agent's workspace at seed time. Only global-pool skills are offered here; team-tier skills become available once the agent belongs to a team and you edit it there."}
        </div>
        <SkillPicker
          skills={poolSkills}
          selected={form.skills}
          onChange={v => update('skills', v)}
        />
      </div>

      <div>
        <div style={labelStyle}>
          {form.role === 'team' ? 'System Prompt Template' : 'System Prompt'}
          {form.role === 'team'
            ? <span style={{ marginLeft: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-normal)' }}>(optional)</span>
            : <>{' '}<span style={{ color: 'var(--eb-status-error)' }}>*</span></>}
        </div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-1)' }}>
          {form.role === 'team'
            ? <>Stored once and reused for every member that inherits it. Define the persona, expertise, and tone — each member gets its own workspace but the same instructions. Leave blank to give members an empty default; you can then set a custom prompt per member.</>
            : <>The persona Claude reads at startup. Describe the agent's role, expertise, communication style and any constraints. Markdown is fine; treat it like the <code>system</code> message in a chat completion.</>}
        </div>
        <textarea
          value={form.systemPrompt}
          onChange={e => update('systemPrompt', e.target.value)}
          placeholder={'You are an experienced COBOL developer with 20+ years working on mainframe migrations.\n\nWhen analysing code, always:\n- Identify the COBOL dialect (IBM Enterprise, GnuCOBOL, …)\n- Highlight any non-standard extensions\n- Suggest a Java equivalent for each paragraph'}
          rows={9}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        {/* When the button is disabled (and not merely saving), spell out
            exactly which required field is still empty so a user new to the
            console isn't left guessing why the form looks broken. */}
        {!saving && submitBlockers.length > 0 && (
          <div style={{
            display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
          }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
            <span>
              Create Agent is disabled until you:
              <ul style={{ margin: 'var(--eb-space-1) 0 0', paddingLeft: 'var(--eb-space-4)' }}>
                {submitBlockers.map(r => (
                  <li key={r.field}>{r.message}</li>
                ))}
              </ul>
            </span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit}>
            {saving ? 'Creating…' : 'Create Agent'}
          </PrimaryBtn>
          <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
        </div>
      </div>
    </div>
  );
}
