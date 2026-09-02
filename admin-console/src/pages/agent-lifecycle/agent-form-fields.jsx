/**
 * agent-form-fields.jsx — the role catalogue and the field controls that the
 * agent *create* and *edit* forms both render.
 *
 * These lived in Agents.jsx while the edit form did too. #1929 moves the edit
 * form into `AgentEditForm.jsx` so the Agent Chat right rail can host it, which
 * would have split these three between the two files — so they moved here
 * instead and both forms import them. Nothing about them changed in the move.
 */
import React, { useEffect, useState } from 'react';
import { User, Users, Workflow, FileText, Info } from 'lucide-react';
import PageHelpButton from '../../components/PageHelpButton';
import { labelStyle, inputStyle } from './form-kit.jsx';

/**
 * Directory a repository URL is cloned into — the last path segment without
 * the `.git` suffix. Drives the Mission Directory picker's options.
 */
export function repoDirName(url) {
  if (!url) return '';
  return url.replace(/\.git$/, '').split(/[/:]/g).filter(Boolean).pop() || '';
}

/* ── Role catalogue (single source of truth for labels + descriptions) ─
   The long per-role explanation lives in the page's help topic
   (api/helper-chat/help-topics/agents.md, #1875) — here we keep only the
   one-line card label and the one-line "when to use", so the form stays lean
   and the concept text has a single home the "?" affordance opens. */
export const ROLE_INFO = {
  'agent': {
    icon: User,
    title: 'Agent (standalone)',
    short: 'A single chat agent with its own system prompt.',
    when: 'Use this for one-of-a-kind agents that act on their own.',
  },
  'team': {
    icon: Users,
    title: 'Agent Team',
    short: 'A reusable template — spawn multiple team members from one prompt.',
    when: 'Use when you need several copies of the same kind of agent — e.g. a pool of three reviewer agents working in parallel.',
  },
  'orchestrator': {
    icon: Workflow,
    title: 'Orchestrator',
    short: 'Watches a folder of mission files and runs one agent per mission.',
    when: 'Use when you have an ACE briefings repository whose missions you want to drive end-to-end through this console.',
  },
  'team-member': {
    icon: User,
    title: 'Team Member',
    short: 'One agent spawned from an Agent Team — most fields inherit from the team.',
    when: 'You do not pick this role yourself — it is assigned when you add a member to a team.',
  },
  'bp-instance': {
    icon: FileText,
    title: 'Mission Agent (bp-instance)',
    short: 'One agent per mission, managed by an Orchestrator from a BriefingPack.',
    when: 'You do not pick this role yourself — the orchestrator assigns it per mission.',
  },
};

export function RoleDetailBanner({ role }) {
  const info = ROLE_INFO[role];
  if (!info) return null;
  return (
    <div style={{
      display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-status-info-bg, var(--eb-bg-elevated))',
      border: '1px solid var(--eb-status-info, var(--eb-border-default))',
      borderRadius: 'var(--eb-radius-md)',
      fontSize: 'var(--eb-text-xs)',
      lineHeight: 1.6,
      color: 'var(--eb-text-primary)',
    }}>
      <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-status-info, var(--eb-text-secondary))' }} />
      <div style={{ flex: '1 1 auto', minWidth: 0, color: 'var(--eb-text-muted)' }}>
        <strong style={{ color: 'var(--eb-text-secondary)' }}>When to use:</strong> {info.when}
      </div>
      {/* The full role catalogue moved into the page help topic (#1875) — the
          "?" is how you reach it from inside the form. */}
      <PageHelpButton label="What the roles mean" size={14} style={{ padding: 0, flexShrink: 0 }} />
    </div>
  );
}

/* ── Mission Directory Field ─────────────────────────────────────────── */
export function MissionDirectoryField({ value, onChange, repoDirs }) {
  const [showCustom, setShowCustom] = useState(
    () => value !== '' && !repoDirs.includes(value)
  );

  useEffect(() => {
    setShowCustom(value !== '' && !repoDirs.includes(value));
  }, [value, repoDirs]);

  const helpText = (
    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
      Path inside the agent's workspace where the mission files live — usually a cloned ACE briefings repository.
      The <code>artifacts/briefings/</code> subdirectory is appended automatically.
      On creation, the orchestrator scans this path and registers one stub agent per mission it finds.
    </div>
  );

  if (repoDirs.length === 0) {
    return (
      <div>
        <div style={labelStyle}>Mission Directory</div>
        <input
          style={inputStyle}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. my-repo"
        />
        {helpText}
      </div>
    );
  }

  const selectValue = showCustom ? '__custom__' : value;

  return (
    <div>
      <div style={labelStyle}>Mission Directory</div>
      <select
        style={inputStyle}
        value={selectValue}
        onChange={e => {
          if (e.target.value === '__custom__') {
            setShowCustom(true);
          } else {
            setShowCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {!selectValue && <option value="">— please select —</option>}
        {repoDirs.map(dir => (
          <option key={dir} value={dir}>{dir}</option>
        ))}
        <option disabled value="__sep__">──────────</option>
        <option value="__custom__">Custom path…</option>
      </select>
      {showCustom && (
        <input
          style={{ ...inputStyle, marginTop: 'var(--eb-space-2)' }}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. my-repo"
          autoFocus
        />
      )}
      {helpText}
    </div>
  );
}
