import React from 'react';
import { Link } from 'react-router';
import {
  Compass, MessageCircle, Layers, Building2, GitBranch,
  Boxes, Brain, Sparkles, Rocket, Users2,
} from 'lucide-react';
import { useHelperChat } from '../context/HelperChatContext';

/**
 * Getting Started — a persistent, always-reachable concept overview (#1107).
 *
 * The Setup Wizard runs exactly once and only covers credentials, so after
 * first-run there was no place for a newcomer to re-read what the core
 * concepts (Agents, Teams, Flows, Working Environments, Knowledge, Model
 * Providers) actually are. This page fills that gap; About stays legal/version
 * only. Linked from the sidebar and the /chats empty state.
 */

// One card per core concept: a short plain-language paragraph plus a link to
// the page where you actually work with it. Icons mirror the sidebar (Shell.jsx)
// so the concept and its nav entry read as the same thing.
const CONCEPTS = [
  {
    Icon: Layers,
    title: 'Agents',
    to: '/agents',
    linkLabel: 'Open Agents',
    body: 'An agent is a single AI worker with its own workspace, prompt and memory. It can chat with you or run unattended on schedules and GitHub events. Each agent keeps a private notebook of what it has learned.',
  },
  {
    Icon: Building2,
    title: 'Access & Users',
    to: '/teams',
    linkLabel: 'Open Access & Users',
    body: 'Manage access scopes (Teams — the human tenant every agent, environment and credential is owned by) and the human users in them. Team Admins and Members control who can change what. This is not the Agent Team squad — that lives on the Agents page.',
  },
  {
    Icon: GitBranch,
    title: 'Flows',
    to: '/flows',
    linkLabel: 'Open Flows',
    body: 'A flow (process) is the wiring diagram of a team: which agent starts the work, how outcomes and labels hand off between them, and where a human approves or receives the result. Design it visually, then materialise it into a live team.',
  },
  {
    Icon: Boxes,
    title: 'Working Environments',
    to: '/environments',
    linkLabel: 'Open Working Environments',
    body: 'A working environment defines where an agent runs and which repository it clones — together with the credentials (SSH key or GitHub token) it uses to read and write that repo.',
  },
  {
    Icon: Brain,
    title: 'Knowledge',
    to: '/knowledge',
    linkLabel: 'Open Knowledge',
    body: 'Knowledge is the team-shared memory: durable facts, entities and conventions that any agent can learn from. The best lessons can be distilled into Skills — polished instruction files agents load automatically.',
  },
  {
    Icon: Sparkles,
    title: 'Model Providers',
    to: '/models',
    linkLabel: 'Open Model Providers',
    body: 'Model Providers connect the platform to the LLMs your agents run on (for example Anthropic Claude). Setting up at least one provider is the one prerequisite before an agent can do any work.',
  },
];

// The next-step call-to-action buttons. Model Providers is repeated here on
// purpose — it is the required first step, so it earns a spot in both the
// concept map and the "where to go next" row.
const NEXT_STEPS = [
  { Icon: Rocket, to: '/quickstart', label: 'Create a single agent', primary: true },
  { Icon: Users2, to: '/team-setup', label: 'Set up a team' },
  { Icon: Sparkles, to: '/models', label: 'Connect a model provider' },
];

export default function GettingStarted() {
  const { openTour } = useHelperChat();
  return (
    <div style={{
      padding: 'var(--eb-space-8) var(--eb-space-6)',
      maxWidth: 860,
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-6)',
    }}>
      {/* Header */}
      <div>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-md)', lineHeight: 1.6 }}>
          A quick tour of the core concepts. Come back here any time you need a refresher —
          the pages you can act on are one click away from each card.
        </p>
        <button
          onClick={openTour}
          style={{
            marginTop: 'var(--eb-space-4)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--eb-space-2)',
            background: 'var(--eb-accent-primary)',
            color: 'var(--eb-text-inverted)',
            border: 'none',
            borderRadius: 'var(--eb-radius-md)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-semibold)',
            padding: 'var(--eb-space-2) var(--eb-space-4)',
          }}
        >
          <Compass size={16} /> Take the Tour
        </button>
      </div>

      {/* Concept map — one card per core concept */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 'var(--eb-space-4)',
      }}>
        {CONCEPTS.map(({ Icon, title, to, linkLabel, body }) => (
          <div key={title} style={{
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-lg)',
            background: 'var(--eb-bg-surface)',
            padding: 'var(--eb-space-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--eb-space-2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <Icon size={18} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
              <span style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
                {title}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6, flex: 1 }}>
              {body}
            </p>
            <Link to={to} style={{
              fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
              color: 'var(--eb-accent-primary)', textDecoration: 'none',
            }}>
              {linkLabel} →
            </Link>
          </div>
        ))}
      </div>

      {/* Where to go next */}
      <div style={{
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)',
        background: 'var(--eb-bg-surface)',
        padding: 'var(--eb-space-4)',
      }}>
        <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-3)' }}>
          Where to go next
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)' }}>
          {NEXT_STEPS.map(({ Icon, to, label, primary }) => (
            <Link key={to} to={to} style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
              padding: '8px 14px', borderRadius: 'var(--eb-radius-md)',
              fontWeight: 600, textDecoration: 'none', fontSize: 'var(--eb-text-sm)',
              background: primary ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
              color: primary ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)',
              border: primary ? 'none' : '1px solid var(--eb-border-default)',
            }}>
              <Icon size={16} /> {label}
            </Link>
          ))}
        </div>
      </div>

      {/* Chat pointer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
        <MessageCircle size={16} style={{ flexShrink: 0 }} />
        <span>
          Already have agents? Head to{' '}
          <Link to="/chats" style={{ color: 'var(--eb-accent-primary)', textDecoration: 'none' }}>Agent Chat</Link>
          {' '}to talk to them.
        </span>
      </div>
    </div>
  );
}
