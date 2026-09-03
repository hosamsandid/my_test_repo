import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Plus, MessageSquare, LayoutTemplate, PenTool, Rocket, UserPlus,
} from 'lucide-react';
import {
  createEntries, createdAgentDestination, isSingleAgentFormOpen,
} from './create-launcher-view';
import { apiCall } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';
import AgentCreateForm from './agent-lifecycle/AgentCreateForm.jsx';
import PageHelpButton from '../components/PageHelpButton';
import { CREATE_HELP_SECTIONS } from './create-help-sections.js';

/**
 * The unified "Create" launcher (#1665, Phase B/C of epic #1661).
 *
 * One front door for starting something new: a small set of equally-ranked,
 * plainly-labelled choices (Describe it · Start from a ready-made setup · Build
 * it yourself · Just one assistant to chat with). The user picks how they want
 * to start, not which internal artifact type they are making — so a first-time
 * user never has to know the words agent / team / flow / template (AC7).
 *
 * Reached from both a persistent "+ Create" control in the sidebar and this
 * dedicated route (both render this same launcher — D4). Each entry hands off
 * to the EXISTING backend/flow for that path; the routes are data in the pure,
 * unit-tested create-launcher-view.js, so the empty-state guidance of each
 * target (no Model Provider, no saved setups, …) is inherited unchanged rather
 * than re-implemented here.
 *
 * The one exception is the fifth entry, **Create a single agent** (#1956): the
 * direct create form used to exist only on the Agents page, which is being
 * retired, so the launcher hosts it here in a side panel keyed on a query param
 * rather than handing off elsewhere. The form itself is the SHARED
 * `agent-lifecycle/AgentCreateForm` — same fields, same validation gate, same
 * `POST /api/agents` — so this page cannot drift from the Agents page's copy.
 */

// Map the icon name carried by each pure entry to its lucide component. Keeping
// the name (not the component) in the view module leaves that module free of
// React / lucide imports and unit-testable.
const ICONS = {
  MessageSquare,
  LayoutTemplate,
  PenTool,
  Rocket,
  UserPlus,
};

export default function Create() {
  const entries = createEntries();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const singleAgentOpen = isSingleAgentFormOpen(searchParams);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Closing drops the param rather than navigating, so the launcher stays put
  // and Back still leaves the page (`replace`, so an open/close pair does not
  // stack two history entries the user has to press Back through twice).
  function closeSingleAgent() {
    setSaveError(null);
    setSearchParams({}, { replace: true });
  }

  // The Agents page's `handleCreateAgent`, minus the list it has and this page
  // has not: the same raw form object, the same endpoint. On success there is
  // no list to refetch here, so the user is taken to the agent they just made.
  async function handleCreateAgent(form) {
    setSaving(true);
    setSaveError(null);
    try {
      const created = await apiCall('POST', '/api/agents', form);
      navigate(createdAgentDestination({ id: created?.id || form.id, role: form.role }));
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      padding: 'var(--eb-space-8) var(--eb-space-6)',
      maxWidth: 860,
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-6)',
    }}>
      {/* Header. The one-line question stays; what each entry path produces (and
          what "a team of one" means) is the create help topic — E14, #1888.
          Since #1992 the "?" names its chapter explicitly rather than relying on
          the entry paths happening to be the topic's first section. */}
      <div>
        <p style={{
          margin: 0,
          color: 'var(--eb-text-secondary)',
          fontSize: 'var(--eb-text-md)',
          lineHeight: 1.6,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
        }}>
          <span>How would you like to start? Pick whichever fits — you can always change direction later.</span>
          <PageHelpButton
            label="What does each of these create?"
            size={14}
            style={{ padding: 0, flexShrink: 0 }}
            section={CREATE_HELP_SECTIONS.entryPaths}
          />
        </p>
      </div>

      {/* Equally-ranked entry tiles. Every tile shares one style (no forced
          default — D1): same border, background, padding and hover treatment. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
        gap: 'var(--eb-space-4)',
      }}>
        {entries.map((entry) => {
          const Icon = ICONS[entry.icon] || Plus;
          return (
            <Link
              key={entry.key}
              to={entry.to}
              data-testid={`create-entry-${entry.key}`}
              style={{
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-lg)',
                background: 'var(--eb-bg-surface)',
                padding: 'var(--eb-space-5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--eb-space-3)',
                textDecoration: 'none',
                transition: 'border-color var(--eb-transition-fast), background var(--eb-transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--eb-accent-primary)';
                e.currentTarget.style.background = 'var(--eb-bg-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--eb-border-default)';
                e.currentTarget.style.background = 'var(--eb-bg-surface)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 40,
                  height: 40,
                  borderRadius: 'var(--eb-radius-md)',
                  background: 'var(--eb-bg-elevated)',
                  color: 'var(--eb-accent-primary)',
                  flexShrink: 0,
                }}>
                  <Icon size={20} />
                </span>
                <span style={{ fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
                  {entry.title}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
                {entry.description}
              </p>
            </Link>
          );
        })}
      </div>

      <SidePanel
        open={singleAgentOpen}
        onClose={closeSingleAgent}
        title="New Agent"
        width="600px"
        loading={saving}
      >
        {singleAgentOpen && (
          <AgentCreateForm
            onSave={handleCreateAgent}
            onCancel={closeSingleAgent}
            saving={saving}
            error={saveError}
          />
        )}
      </SidePanel>
    </div>
  );
}
