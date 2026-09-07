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
 *
 * #2026 left only the *create* form as a consumer: the edit form no longer shows
 * a read-only Role field, so it has no role explanation to render either. The
 * catalogue stays here — it is the role copy's single home, and the create form
 * renders both halves of it (the cards and the "?").
 */
import React from 'react';
import { User, Users } from 'lucide-react';
import InfoTip from '../../components/InfoTip';

/* ── Role catalogue (single source of truth for labels + descriptions) ─
   The long per-role explanation lives in a help topic — `help-topics/agents.md`
   until #1930 retired that topic into `agent-chat.md` (*The agent roles*
   chapter) — reached from the page's own header "?" rather than from inside the
   form (#2026). Here we keep only the one-line card label and the one-line
   "when to use", so the form stays lean and the concept text has a single
   home. */
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

/**
 * The role explanation, as a compact "?" beside the Role label.
 *
 * This was `RoleDetailBanner` — a full-width blue info box carrying the same
 * `when` sentence (#1875) — until #2026: the box was the largest thing in a
 * form whose actual subject is the prompt, and it explained a *choice* rather
 * than qualifying an input, so it reads better on demand. Only the CREATE form
 * renders it, because that is the only place the role is picked; the edit form
 * dropped the read-only Role field and this explanation with it.
 *
 * `InfoTip` is the console's rich multi-line "?" (hover / focus / tap), so the
 * text follows the currently-selected role exactly as the box did.
 */
export function RoleHelpTip({ role }) {
  const info = ROLE_INFO[role];
  if (!info) return null;
  return <InfoTip title={`${info.title} — when to use`} text={info.when} size={14} />;
}
