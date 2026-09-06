/**
 * agent-form-fields.jsx — the role catalogue and the field controls that the
 * agent *create* and *edit* forms both render.
 *
 * These lived in Agents.jsx while the edit form did too. #1929 moves the edit
 * form into `AgentEditForm.jsx` so the Agent Chat right rail can host it, which
 * would have split these between the two files — so they moved here instead and
 * both forms import them. Nothing about them changed in the move.
 *
 * #1964 removed the BriefingPack half: the `orchestrator` / `bp-instance` role
 * cards and the Mission Directory field (with the `repoDirName` helper that only
 * ever fed its picker) are gone, since neither role can be created or edited any
 * more.
 */
import React from 'react';
import { User, Users, Info } from 'lucide-react';
import PageHelpButton from '../../components/PageHelpButton';

/* ── Role catalogue (single source of truth for labels + descriptions) ─
   The long per-role explanation lives in the help topic of whichever page is
   rendering this form — the `?` resolves against the live route, so it is
   `create.md` on `/create` and `agent-chat.md` on `/chats`. It was
   `help-topics/agents.md` until #1930 retired that topic into `agent-chat.md`
   (*The agent roles* chapter). Here we keep only the one-line card label and
   the one-line "when to use", so the form stays lean and the concept text has a
   single home the "?" affordance opens. */
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
  'team-member': {
    icon: User,
    title: 'Team Member',
    short: 'One agent spawned from an Agent Team — most fields inherit from the team.',
    when: 'You do not pick this role yourself — it is assigned when you add a member to a team.',
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
