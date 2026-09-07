import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Plus, MessageSquare, LayoutTemplate, PenTool, Rocket, UserPlus,
  ChevronDown, ChevronRight, Eye, Star,
} from 'lucide-react';
import {
  createdAgentDestination, isSingleAgentFormOpen,
  heroEntry, entriesByTier, previewToggleLabel,
  CREATE_COPY, ADVANCED_DEFAULT_OPEN,
} from './create-launcher-view';
import { CREATE_PREVIEWS } from './create-previews.jsx';
import { apiCall } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';
import AgentCreateForm from './agent-lifecycle/AgentCreateForm.jsx';
import PageHelpButton from '../components/PageHelpButton';
import { CREATE_HELP_SECTIONS } from './create-help-sections.js';

/**
 * The unified "Create" launcher (#1665, Phase B/C of epic #1661), re-sorted into
 * three tiers by #2027.
 *
 * One front door for starting something new. It began as five equally-ranked
 * tiles (#1661 D1); #2027 replaced that flat grid with an explicit ranking,
 * simplest → most advanced, because equal weighting meant nothing signalled
 * where to begin, the two single-agent paths read as duplicates with the expert
 * one sounding easiest, and no entry said whether you would land in a chat, an
 * editor or an empty canvas:
 *
 *   1. a full-width HERO — "Chat with one assistant", the primary action;
 *   2. a FLOW group of exactly three cards under one heading that finally names
 *      the concept ("a flow") and says all three end in the same place;
 *   3. a collapsed ADVANCED disclosure holding the specialist form.
 *
 * **Nothing is rewired.** Every entry still hands off to the route it always
 * did — the routes are data in the pure, unit-tested create-launcher-view.js —
 * so the empty-state guidance of each target (no Model Provider, no saved
 * setups, …) is inherited unchanged rather than re-implemented here. This is a
 * re-sort, a re-label and a preview.
 *
 * The one entry that is not a hand-off is **Configure an agent manually**
 * (#1956, the former "Create a single agent"): the direct create form used to
 * exist only on the Agents page, which has been retired, so the launcher hosts
 * it here in a side panel keyed on a query param. The form itself is the SHARED
 * `agent-lifecycle/AgentCreateForm` — same fields, same validation gate, same
 * `POST /api/agents`.
 *
 * Every visible string comes from CREATE_COPY or an entry in the pure module,
 * where #2027's binding copy inventory lives (and where the two deviations it
 * mandates are explained).
 */

// Map the icon name carried by each pure entry to its lucide component. Keeping
// the name (not the component) in the view module leaves that module free of
// React / lucide imports and unit-testable. Same indirection for the "what you
// get" schematics, via CREATE_PREVIEWS.
const ICONS = {
  MessageSquare,
  LayoutTemplate,
  PenTool,
  Rocket,
  UserPlus,
};

const CARD_BASE = {
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  background: 'var(--eb-bg-surface)',
  textDecoration: 'none',
  transition: 'border-color var(--eb-transition-fast), background var(--eb-transition-fast)',
};

// A small pill. `tone: 'accent'` is the hero's "Fastest start" and card A's
// "Recommended"; everything else (the two "Advanced" markers) stays muted, so
// the badge row itself carries the ranking rather than merely decorating it.
function Badge({ children, tone = 'muted', icon = null }) {
  const accent = tone === 'accent';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--eb-space-1)',
      flexShrink: 0,
      padding: '2px var(--eb-space-2)',
      borderRadius: 'var(--eb-radius-full)',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-medium)',
      whiteSpace: 'nowrap',
      color: accent ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
      background: accent ? 'var(--eb-bg-selected)' : 'var(--eb-bg-elevated)',
      border: `1px solid ${accent ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
    }}>
      {icon}
      {children}
    </span>
  );
}

// The "→ …" line every entry carries: what kind of screen selecting it opens.
function Outcome({ children }) {
  return (
    <p style={{
      margin: 0,
      fontSize: 'var(--eb-text-xs)',
      color: 'var(--eb-text-secondary)',
      fontWeight: 'var(--eb-font-medium)',
    }}>
      {children}
    </p>
  );
}

/**
 * The "what you get" reveal.
 *
 * Shown on hover and on keyboard focus (parity, per the shared-tooltip standard
 * #1850), and on touch via the eye control — which is a SIBLING of the entry's
 * <Link>, not a descendant, for two reasons: a <button> inside an <a> is
 * invalid HTML, and as a sibling laid over the card its tap lands on the button
 * instead of the link, so the preview affordance cannot swallow the card's own
 * action (AC5). It is independently focusable and carries its own label.
 *
 * The reveal is a plain mount/unmount with NO animation and no transition, for
 * everyone — so `prefers-reduced-motion` needs no separate fallback path
 * (there is nothing to fall back from), and the behaviour matches #1850's
 * "appears instantly" tooltip standard. The panel is absolutely positioned
 * below the card so revealing it never reflows the row.
 */
function PreviewReveal({ entry, shown }) {
  const Schematic = CREATE_PREVIEWS[entry.preview.schematic];
  if (!shown || !Schematic) return null;
  return (
    <div style={{
      position: 'absolute',
      top: 'calc(100% + var(--eb-space-2))',
      left: 0,
      right: 0,
      zIndex: 5,
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      background: 'var(--eb-bg-surface)',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
      padding: 'var(--eb-space-3)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-2)',
      pointerEvents: 'none',
    }}>
      <Schematic />
      <p style={{
        margin: 0,
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-secondary)',
        lineHeight: 1.5,
      }}>
        {entry.preview.caption}
      </p>
    </div>
  );
}

// One entry, whatever tier it is in. `variant` only changes the layout — the
// copy, the badge, the outcome line and the preview are the entry's own, so a
// tier cannot silently drop one of them.
function EntryCard({ entry, variant = 'card' }) {
  // Hover/focus and the touch toggle are tracked separately: leaving the card
  // must not close a preview the user pinned open with the eye control.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const shown = hovered || pinned;

  const Icon = ICONS[entry.icon] || Plus;
  const hero = variant === 'hero';
  const badgeTone = entry.badge === 'Advanced' ? 'muted' : 'accent';

  return (
    <div
      style={{ position: 'relative', display: 'flex' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link
        to={entry.to}
        data-testid={`create-entry-${entry.key}`}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          ...CARD_BASE,
          flex: '1 1 auto',
          display: 'flex',
          flexDirection: hero ? 'row' : 'column',
          alignItems: hero ? 'center' : 'stretch',
          gap: hero ? 'var(--eb-space-5)' : 'var(--eb-space-3)',
          padding: hero ? 'var(--eb-space-6)' : 'var(--eb-space-5)',
          ...(hero
            ? { borderColor: 'var(--eb-accent-primary)', background: 'var(--eb-bg-elevated)' }
            : null),
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--eb-accent-primary)';
          e.currentTarget.style.background = 'var(--eb-bg-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = hero
            ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)';
          e.currentTarget.style.background = hero
            ? 'var(--eb-bg-elevated)' : 'var(--eb-bg-surface)';
        }}
      >
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: hero ? 52 : 40,
          height: hero ? 52 : 40,
          borderRadius: 'var(--eb-radius-md)',
          background: hero ? 'var(--eb-bg-surface)' : 'var(--eb-bg-elevated)',
          color: 'var(--eb-accent-primary)',
          flexShrink: 0,
        }}>
          <Icon size={hero ? 26 : 20} />
        </span>

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-2)',
          minWidth: 0,
          flex: '1 1 auto',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--eb-space-2)',
            flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: hero ? 'var(--eb-text-xl)' : 'var(--eb-text-lg)',
              fontWeight: 'var(--eb-font-semibold)',
              color: 'var(--eb-text-primary)',
            }}>
              {entry.title}
            </span>
            {entry.badge && (
              <Badge
                tone={badgeTone}
                icon={badgeTone === 'accent' ? <Star size={11} /> : null}
              >
                {entry.badge}
              </Badge>
            )}
          </div>
          <p style={{
            margin: 0,
            fontSize: 'var(--eb-text-sm)',
            color: 'var(--eb-text-secondary)',
            lineHeight: 1.6,
          }}>
            {entry.description}
          </p>
          <Outcome>{entry.outcome}</Outcome>
        </div>

        {/* The hero is a primary action, so it says so in a button-shaped
            affordance. It is decoration inside the same <Link> — never a nested
            button — so the whole card stays one click target (AC7). */}
        {hero && entry.action && (
          <span style={{
            flexShrink: 0,
            alignSelf: 'center',
            padding: 'var(--eb-space-3) var(--eb-space-5)',
            borderRadius: 'var(--eb-radius-md)',
            background: 'var(--eb-accent-primary)',
            color: 'var(--eb-text-inverted)',
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-semibold)',
            whiteSpace: 'nowrap',
          }}>
            {entry.action}
          </span>
        )}
      </Link>

      {/* Touch affordance. Overlaid on the card rather than nested in the link,
          so tapping it previews and tapping anywhere else still navigates. */}
      <button
        type="button"
        data-testid={`create-preview-${entry.key}`}
        aria-label={previewToggleLabel(entry, shown)}
        aria-expanded={shown}
        title={previewToggleLabel(entry, shown)}
        onClick={() => setPinned((v) => !v)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          position: 'absolute',
          top: 'var(--eb-space-2)',
          right: 'var(--eb-space-2)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--eb-space-1)',
          border: 'none',
          background: 'none',
          borderRadius: 'var(--eb-radius-md)',
          color: shown ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)',
          cursor: 'pointer',
          lineHeight: 0,
        }}
      >
        <Eye size={14} />
      </button>

      <PreviewReveal entry={entry} shown={shown} />
    </div>
  );
}

export default function Create() {
  const hero = heroEntry();
  const flowCards = entriesByTier('flow');
  const advanced = entriesByTier('advanced');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const singleAgentOpen = isSingleAgentFormOpen(searchParams);
  // Collapsed on every load for every user, deliberately not persisted — see
  // ADVANCED_DEFAULT_OPEN in the pure module for why.
  const [advancedOpen, setAdvancedOpen] = useState(ADVANCED_DEFAULT_OPEN);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Closing drops the param rather than navigating, so the launcher stays put
  // and Back still leaves the page (`replace`, so an open/close pair does not
  // stack two history entries the user has to press Back through twice).
  function closeSingleAgent() {
    setSaveError(null);
    setSearchParams({}, { replace: true });
  }

  // The Agents page's `handleCreateAgent`, minus the list it had and this page
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
      {/* Header. The question and the "you can change it later" reassurance
          stay on the page; what each entry path produces (and what "a team of
          one" means) is the create help topic — E14, #1888. Since #1992 the "?"
          names its chapter explicitly rather than relying on the entry paths
          happening to be the topic's first section. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        <h2 style={{
          margin: 0,
          fontSize: 'var(--eb-text-xl)',
          fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-primary)',
        }}>
          {CREATE_COPY.pageTitle}
        </h2>
        <p style={{
          margin: 0,
          color: 'var(--eb-text-secondary)',
          fontSize: 'var(--eb-text-md)',
          lineHeight: 1.6,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
        }}>
          <span>{CREATE_COPY.pageSubhead}</span>
          <PageHelpButton
            label={CREATE_COPY.headerHelp}
            size={14}
            style={{ padding: 0, flexShrink: 0 }}
            section={CREATE_HELP_SECTIONS.entryPaths}
          />
        </p>
      </div>

      {/* Tier 1 — the hero, full width and first. */}
      {hero && <EntryCard entry={hero} variant="hero" />}

      {/* Tier 2 — the three flow options, visually one group under one heading
          that names the concept. The heading and intro are what stop these
          reading as three unrelated tiles. */}
      {flowCards.length > 0 && (
        <section style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-4)',
          padding: 'var(--eb-space-5)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)',
          background: 'var(--eb-bg-app)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            <h3 style={{
              margin: 0,
              fontSize: 'var(--eb-text-md)',
              fontWeight: 'var(--eb-font-semibold)',
              color: 'var(--eb-text-primary)',
            }}>
              {CREATE_COPY.flowHeading}
            </h3>
            <p style={{
              margin: 0,
              fontSize: 'var(--eb-text-sm)',
              color: 'var(--eb-text-secondary)',
              lineHeight: 1.6,
            }}>
              {CREATE_COPY.flowIntro}
            </p>
          </div>
          {/* auto-fit + minmax stacks the three cards vertically at narrow
              widths while they stay inside this one bordered group (edge case). */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--eb-space-4)',
            alignItems: 'stretch',
          }}>
            {flowCards.map((entry) => (
              <EntryCard key={entry.key} entry={entry} />
            ))}
          </div>
        </section>
      )}

      {/* Tier 3 — the expert path, behind a disclosure. It never hides the two
          tiers above it: it is rendered after them and only ever adds. */}
      {advanced.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          <button
            type="button"
            data-testid="create-advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-2) 0',
              border: 'none',
              background: 'none',
              color: 'var(--eb-text-secondary)',
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              cursor: 'pointer',
            }}
          >
            {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {CREATE_COPY.advancedToggle}
          </button>
          {advancedOpen && advanced.map((entry) => (
            <EntryCard key={entry.key} entry={entry} />
          ))}
        </div>
      )}

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
