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
 * Behaviour is unchanged from the Agents page, other than #2233 removing the
 * `agent` vs `team` role picker: the action now always produces a plain agent,
 * itself minted as a team of one (#2231) — there is nothing left to pick. The
 * `hasRepos` helper came along because nothing else on that page used it.
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

const hasRepos = (env) =>
  (Array.isArray(env?.repositories) && env.repositories.length > 0) ||
  !!env?.repository?.url;

/* ── Agent Create Form ─────────────────────────────────────────────── */
export default function AgentCreateForm({ onSave, onCancel, saving, error, idConflict }) {
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

  // The pure helper derives the gate AND the ordered list of unmet
  // requirements from one place, so the disabled button and the "why" hint
  // below can never disagree.
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
      {/* #2218 — the refusal is scoped to the id it was about: once the user
          edits the field away from that id, the suggestion no longer applies
          to what is currently typed and disappears rather than going stale.
          Accepting it goes through `handleIdChange` — the same path a keystroke
          takes — so it counts as a manual edit and a later name change never
          silently overwrites it (the useAutoDerivedId edge case). */}
      {idConflict?.suggestedId && form.id === idConflict.agentId && (
        <div style={{
          display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap',
          marginTop: 'calc(-1 * var(--eb-space-2))',
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
        }}>
          <span>
            <code>{idConflict.suggestedId}</code> is free.
          </span>
          <button
            type="button"
            onClick={() => handleIdChange(idConflict.suggestedId)}
            style={{
              background: 'none', border: 'none', padding: 0,
              color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-semibold)',
              cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline',
            }}
          >
            Use this id
          </button>
        </div>
      )}

      <div>
        <div style={labelStyle}>Environment <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
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
          Manage these from the owning team's <em>Settings</em> tab in Agent Chat. Each agent gets its own
          isolated workspace, but the recipe is shared.
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
                disabled. #2168 A2 removed the standalone "create environment"
                entry point, so the fix is no longer a link to that page — an
                environment now only comes from creating a team. */}
            No environments yet — creating a team provisions one automatically. Use the
            {' '}<Link to="/team-setup" style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-semibold)' }}>
              Agent Team Wizard
            </Link>{' '}
            first, then come back here.
          </div>
        )}
      </div>

      <div>
        <div style={labelStyle}>Skills</div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
          Skills copied into this agent's workspace at seed time. Only global-pool skills are offered here; team-tier skills become available once the agent belongs to a team and you edit it there.
        </div>
        <SkillPicker
          skills={poolSkills}
          selected={form.skills}
          onChange={v => update('skills', v)}
        />
      </div>

      <div>
        <div style={labelStyle}>
          System Prompt <span style={{ color: 'var(--eb-status-error)' }}>*</span>
        </div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-1)' }}>
          The persona Claude reads at startup. Describe the agent's role, expertise, communication style and any constraints. Markdown is fine; treat it like the <code>system</code> message in a chat completion.
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
