import React from 'react';

/*
 * Shared knowledge *learning* configuration (#566/#567).
 *
 * The three learning settings — Autonomy, Review and Promotion gates — are
 * rendered by ONE component so the Knowledge page's slide-out panel and the
 * Team-Setup wizard's Knowledge step are visibly one experience, with no
 * divergent second implementation of the copy or controls (#567 AC-2).
 *
 * Storage lives only on the Knowledge page and is intentionally NOT here — the
 * wizard exposes only learning behaviour (#567 out-of-scope).
 *
 * The component is presentational: it renders the current values and calls back
 * on every change. Callers decide what a change means:
 *   - Knowledge page (live): each callback PUTs to the knowledge API immediately.
 *   - Wizard create: each callback updates local form state; persisted on submit.
 *   - Wizard extend: `readOnly` — the existing team's values, no editing.
 */

// One SHORT line per level (#1877). The long per-level explanation lives in the
// Knowledge help topic (help-topics/knowledge.md) — single-sourced, so both this
// panel and the wizard's Knowledge step point at the same copy instead of
// carrying two divergent tooltips.
export const AUTONOMY_LEVELS = [
  { level: 0, label: 'Off', desc: 'Agents keep lessons to themselves — nothing is shared.' },
  { level: 1, label: 'Share', desc: 'Agents pool their lessons into the shared team knowledge.' },
  { level: 2, label: 'Suggest', desc: 'Like Share — plus suggestions when knowledge converges. You confirm each.' },
  { level: 3, label: 'Auto-curate', desc: 'The team promotes converged knowledge to skills on its own, within the gates.' },
];

export const GATE_ORDER = ['team>team', 'agent>team', 'team>global'];
export const GATE_LABELS = {
  'team>team': 'Knowledge → team skill',
  'agent>team': 'Agent skill → team skill',
  'team>global': 'Team skill → all teams',
};
export const GATE_TIPS = {
  'team>team': 'Converged team knowledge becoming a team skill.',
  'agent>team': 'A skill one agent authored for itself becoming a team skill.',
  'team>global': 'A team skill becoming available to every team. This step always waits for your review — it can’t be set to automatic.',
};

// The hard-coded defaults a brand-new team is created on today (#567 AC-1/AC-4).
// These MUST match the backend resolvers a team with no override reads:
//   autonomy 1 (Share)          — api.js teamAutonomyLevel / orchestrator knowledgeAutonomyLevel
//   review off                  — api.js knowledgeReviewOn / orchestrator knowledgeReviewEnabled
//   gates DEFAULT_PROMOTION_GATES — knowledge-suggestions.js: team>team auto, agent>team review
// team>global is always reviewed (forced) and cannot be automated.
export const KNOWLEDGE_LEARNING_DEFAULTS = {
  autonomy: 1,
  review: false,
  gates: { 'team>team': 'auto', 'agent>team': 'review', 'team>global': 'review' },
};

// One titled section: heading + plain-language paragraph + the controls.
export function PanelSection({ title, children, blurb }) {
  return (
    <section style={{ paddingTop: 'var(--eb-space-4)', marginTop: 'var(--eb-space-4)', borderTop: '1px solid var(--eb-border-default)' }}>
      <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>{title}</h3>
      <p style={{ margin: '4px 0 var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>{blurb}</p>
      {children}
    </section>
  );
}

// A muted caption naming the default value for a section (#567 AC-1).
function DefaultNote({ children }) {
  return (
    <div style={{ marginTop: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
      {children}
    </div>
  );
}

/*
 * The three learning sections, shared verbatim between the Knowledge page panel
 * and the wizard.
 *
 * Props:
 *   autonomy   number 0-3
 *   review     boolean
 *   gates      { '<transition>': 'auto' | 'review' }
 *   onAutonomy (level)            → user picked an autonomy level
 *   onReview   (nextEnabled)      → user toggled review to nextEnabled
 *   onGate     (transition, mode) → user toggled a gate to mode ('auto'|'review')
 *   busy       string | null      — key currently saving ('autonomy'|'review'|<transition>); disables just that control
 *   readOnly   boolean            — render values but disable all editing (wizard extend mode)
 *   showDefaults boolean          — append a caption naming the default per section (wizard create mode)
 */
export default function KnowledgeLearningSections({
  autonomy, review, gates,
  onAutonomy, onReview, onGate,
  busy = null, readOnly = false, showDefaults = false,
}) {
  const g = gates || {};
  const current = AUTONOMY_LEVELS.find(l => l.level === autonomy) || AUTONOMY_LEVELS[1];
  const reviewDisabled = readOnly || busy === 'review' || autonomy < 1;
  const defaultAutonomy = AUTONOMY_LEVELS.find(l => l.level === KNOWLEDGE_LEARNING_DEFAULTS.autonomy) || AUTONOMY_LEVELS[1];

  return (
    <>
      {/* Autonomy */}
      <PanelSection
        title="Autonomy"
        blurb="How much this team may do on its own with what its agents learn. You can change this at any time — higher levels never bypass the gates below.">
        <div style={{ display: 'inline-flex', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', overflow: 'hidden' }}>
          {AUTONOMY_LEVELS.map(({ level, label, desc }) => {
            const active = level === autonomy;
            const disabled = readOnly || busy === 'autonomy';
            return (
              <button
                key={level}
                type="button"
                disabled={disabled}
                title={desc}
                onClick={() => !active && !disabled && onAutonomy(level)}
                style={{
                  padding: '4px 12px', border: 'none', cursor: disabled ? 'default' : 'pointer', fontSize: 'var(--eb-text-xs)', fontWeight: 600,
                  background: active ? 'var(--eb-accent-primary)' : 'transparent',
                  color: active ? 'var(--eb-text-inverted, #fff)' : 'var(--eb-text-secondary)',
                }}>
                {level} {label}
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{current.desc}</div>
        {showDefaults && (
          <DefaultNote>
            {autonomy === KNOWLEDGE_LEARNING_DEFAULTS.autonomy
              ? `Default: ${KNOWLEDGE_LEARNING_DEFAULTS.autonomy} · ${defaultAutonomy.label}.`
              : `Default is ${KNOWLEDGE_LEARNING_DEFAULTS.autonomy} · ${defaultAutonomy.label}.`}
          </DefaultNote>
        )}
      </PanelSection>

      {/* Review */}
      <PanelSection
        title="Review"
        blurb="Whether new lessons wait for your approval before they enter the shared team knowledge. Needs autonomy 1 or higher.">
        <button
          type="button"
          disabled={reviewDisabled}
          title={autonomy < 1
            ? 'Review needs autonomy 1 or higher — at 0, nothing is shared in the first place'
            : (review ? 'Click to share new lessons immediately, without approval' : 'Click to hold every new lesson for your approval first')}
          onClick={() => !reviewDisabled && onReview(!review)}
          style={{
            fontSize: 'var(--eb-text-xs)', fontWeight: 600, cursor: reviewDisabled ? 'not-allowed' : 'pointer',
            borderRadius: 'var(--eb-radius-md)', padding: '4px 12px', opacity: autonomy < 1 ? 0.5 : 1,
            border: `1px solid ${review ? 'var(--eb-status-warning)' : 'var(--eb-border-default)'}`,
            color: review ? 'var(--eb-status-warning)' : 'var(--eb-text-muted)', background: 'transparent',
          }}>
          {review ? 'on — you approve each lesson' : 'off — shared immediately'}
        </button>
        {showDefaults && (
          <DefaultNote>
            {review === KNOWLEDGE_LEARNING_DEFAULTS.review ? 'This is the default (off).' : 'Default is off — shared immediately.'}
          </DefaultNote>
        )}
      </PanelSection>

      {/* Promotion gates */}
      <PanelSection
        title="Promotion gates"
        blurb="Checkpoints for turning knowledge into skills — each gate runs on its own (“automatic”) or waits for you (“needs review”). Gates only take effect at autonomy 3.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          {GATE_ORDER.map(tr => {
            const mode2 = g[tr] || 'review';
            const locked = tr === 'team>global';
            const disabled = readOnly || busy === tr;
            return (
              <div key={tr} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }} title={GATE_TIPS[tr]}>
                <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', flex: 1 }}>{GATE_LABELS[tr]}</span>
                {locked ? (
                  <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>always reviewed</span>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => !disabled && onGate(tr, mode2 === 'auto' ? 'review' : 'auto')}
                    title={mode2 === 'auto'
                      ? 'Runs on its own at autonomy 3 — click to require your review instead'
                      : 'Waits for your review — click to let it run on its own at autonomy 3'}
                    style={{
                      fontSize: 'var(--eb-text-xs)', fontWeight: 600, cursor: disabled ? 'default' : 'pointer', borderRadius: 4, padding: '2px 8px',
                      border: `1px solid ${mode2 === 'auto' ? 'var(--eb-status-success)' : 'var(--eb-status-warning)'}`,
                      color: mode2 === 'auto' ? 'var(--eb-status-success)' : 'var(--eb-status-warning)', background: 'transparent',
                    }}>
                    {mode2 === 'auto' ? 'automatic' : 'needs review'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {showDefaults && <DefaultNote>The values shown are the defaults. Gates only take effect at autonomy 3.</DefaultNote>}
      </PanelSection>
    </>
  );
}
