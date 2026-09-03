import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { RefreshCw, AlertCircle, Loader2, ArrowRight, Target, GitPullRequest, CircleDot, Tag, Ban, MessageSquare } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import {
  resolveOutcomeView,
  modeSummary,
  flowEditorRoutingHref,
} from './outcomes-view.js';

/**
 * Right-rail **Outcomes** tab (#963) — the outputs counterpart of the Triggers
 * tab. Triggers makes an agent's *inputs* transparent in the chat context; this
 * makes its *outputs* transparent: which outcome it picks at the end of a run,
 * under what condition, what signal that applies, and which teammate is woken
 * by it.
 *
 * **Read-only by design.** Authoring lives in the Flow Editor's Routing tab —
 * the one place that can validate an outcome against the whole graph (and the
 * LLM "Suggest outcomes…" affordance stays there too). This panel links there
 * rather than duplicating the editor.
 *
 * **Data.** No endpoint of its own: `GET /api/agents/:id` supplies the agent's
 * own `outcomes` / `emits` port, and `GET /api/process/graph?team=<team>`
 * supplies the sibling nodes needed to derive consumers — the same nodes the
 * Flow Editor's Routing tab derives them from, through the same shared
 * `consumersFor` (see ../process/outcome-consumers.js). If the team graph is
 * unavailable the outcomes still render, with the consumer column suppressed
 * rather than silently claiming "no consumer".
 */

// Outcomes only change through an explicit Flow-Editor edit — unlike triggers,
// which an agent may rewrite itself at runtime — so this polls at half the
// Triggers tab's rate. The refresh button covers the impatient case.
const POLL_MS = 60_000;

export default function OutcomesPanel({ agentId, active }) {
  const [agent, setAgent] = useState(null);
  const [peers, setPeers] = useState(null);
  const [labels, setLabels] = useState(null); // graph label registry (#981) — brake/gate flags
  const [humans, setHumans] = useState(null); // graph human-role registry (#1001) — artifact reviewers
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async (id) => {
    if (!id) { setAgent(null); setPeers(null); setLabels(null); setHumans(null); return; }
    setLoading(true);
    setError(null);
    try {
      const cfg = await apiCall('GET', `/api/agents/${encodeURIComponent(id)}`);
      setAgent(cfg);
      // Consumers are a property of the team graph, so they need the siblings.
      // A failure here is not fatal: the outcomes themselves are already known.
      const team = typeof cfg?.parentTeamId === 'string' ? cfg.parentTeamId.trim() : '';
      if (!team) { setPeers(null); setLabels(null); setHumans(null); return; }
      try {
        const graph = await apiCall('GET', `/api/process/graph?team=${encodeURIComponent(team)}`);
        setPeers(Array.isArray(graph?.nodes) ? graph.nodes : null);
        setLabels(Array.isArray(graph?.labels) ? graph.labels : null);
        setHumans(Array.isArray(graph?.humans) ? graph.humans : null);
      } catch { setPeers(null); setLabels(null); setHumans(null); }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    fetchAll(agentId);
    const timer = setInterval(() => fetchAll(agentId), POLL_MS);
    return () => clearInterval(timer);
  }, [agentId, active, fetchAll]);

  const view = resolveOutcomeView(agent, peers, labels, humans);
  const href = flowEditorRoutingHref(agent);

  /* ── Toolbar ──────────────────────────────────────────────────────── */
  const toolbar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-2) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      flexShrink: 0, background: 'var(--eb-bg-surface)', minHeight: 36,
    }}>
      <span style={{ flex: 1, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {loading && !agent
          ? 'Loading…'
          : view.rows.length > 0
            ? `${view.rows.length} outcome${view.rows.length === 1 ? '' : 's'}`
            : agentId ? 'No outcomes' : ''}
      </span>
      <button
        onClick={() => fetchAll(agentId)}
        disabled={loading || !agentId}
        title="Refresh"
        style={{
          background: 'none', border: 'none', color: 'var(--eb-text-muted)',
          cursor: agentId ? 'pointer' : 'default', padding: 2,
          display: 'flex', alignItems: 'center',
          opacity: (!agentId || loading) ? 0.4 : 1,
        }}
      >
        <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
      </button>
      {/* #1972: this tab's "?" — same slot as the Triggers toolbar's, landing on
          the Outcomes chapter. The tab is conditional (team members only), so
          the affordance appears exactly when the surface does. */}
      <PageHelpButton
        label="What an outcome is"
        size={13}
        section={AGENT_CHAT_HELP_SECTIONS.outcomes}
        style={{ padding: 2 }}
      />
    </div>
  );

  if (!agentId) {
    return (
      <div style={panelBox}>
        {toolbar}
        <div style={centered}>Select an agent to view its outcomes.</div>
      </div>
    );
  }

  return (
    <div style={panelBox}>
      {toolbar}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && !agent && (
          <div style={{ ...centered, gap: 'var(--eb-space-2)', flexDirection: 'row', padding: 'var(--eb-space-6)' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            Loading outcomes…
          </div>
        )}

        {error && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-4)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            {error}
          </div>
        )}

        {!error && agent && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-3) var(--eb-space-4)' }}>
            {/* Mode lead — the same contract the agent's `## Outcomes` prompt
                block states, so the rail and the prompt cannot read differently. */}
            {view.kind === 'structured' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                <Target size={12} style={{ flexShrink: 0, color: 'var(--eb-accent-primary)' }} />
                <span>{modeSummary(view.mode)}</span>
              </div>
            )}

            {/* AC3 — a legacy flat `emits[]` agent has labels but no structure.
                What a structured outcome *is* (condition + title, and the
                exactly-one / any-of modes) moved to the Agent Chat help topic in
                E15 (#1889); the actionable "where to fix it" pointer stays. */}
            {view.kind === 'legacy' && (
              <div style={hintBox}>
                This agent still declares plain flat labels. Structured outcomes can
                be authored in the Flow Editor.
              </div>
            )}

            {/* AC4 — nothing configured at all. */}
            {view.kind === 'empty' && (
              <div style={{ padding: 'var(--eb-space-5) var(--eb-space-2)', textAlign: 'center', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.6 }}>
                No outcomes configured.
                <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)' }}>
                  This agent signals nothing when a run ends, so no teammate is woken
                  by its work. Outcomes are authored in the Flow Editor.
                </div>
              </div>
            )}

            {view.rows.map((row, i) => (
              <OutcomeCard
                key={row.key}
                index={i}
                row={row}
                showConsumers={view.consumersResolved}
              />
            ))}

            {/* AC5 — read-only, with the jump to where editing happens. */}
            <div style={{ marginTop: 'var(--eb-space-1)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {href ? (
                // A real anchor, not a button: the target is a bookmarkable URL,
                // so middle-click / open-in-new-tab should work.
                <Link
                  to={href}
                  style={linkBtn}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-accent-primary)'; }}
                >
                  Edit in Flow Editor → Routing → Outcomes
                  <ArrowRight size={11} />
                </Link>
              ) : (
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                  Outcomes are edited in the Flow Editor → Routing → Outcomes.
                </span>
              )}
              {view.rows.length > 0 && !view.consumersResolved && (
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                  Consumers could not be derived — the team flow graph is unavailable.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── one outcome ─────────────────────────────────────────────────────── */
function OutcomeCard({ index, row, showConsumers }) {
  return (
    <div style={cardBox}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>{index + 1}.</span>
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', wordBreak: 'break-word' }}>
          {row.title}
        </span>
      </div>

      {row.when && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
          <span style={fieldLabel}>when</span> {row.when}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
        <span style={fieldLabel}>then</span>
        {row.actions.map((a, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ color: 'var(--eb-text-muted)' }}>and</span>}
            <ActionChip action={a} />
          </React.Fragment>
        ))}
        {row.notifyDm && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--eb-text-muted)' }}>
            <MessageSquare size={10} /> reports in the DM
          </span>
        )}
      </div>

      {showConsumers && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
          {row.terminal
            ? 'Terminal outcome — no signal (dead-end by design).'
            : row.marker === 'terminal'
              // Declared open end (#1004): a proper endpoint, never "no consumer".
              ? '⏹ Terminal by design — the end product.'
              : row.marker === 'external'
                ? <>↗ external{row.markerNote ? <>: {row.markerNote}</> : ' — consumed outside this flow'}</>
                : row.humanHandoff
              // Brake label (#981): the hand-off to a person IS the consumer.
              ? <>hands off to a person 👤 — the flow pauses for a decision{row.consumers.length ? <> · also wakes {row.consumers.join(', ')}</> : null}</>
              : (row.humanReviewers || []).length
                // Bound human reviewer of the opened PR/issue (#1001): a
                // consumer, not a warning — mirrors the Routing tab.
                ? <>reviewed by 👤 {row.humanReviewers.join(', ')}{row.consumers.length ? <> · also wakes {row.consumers.join(', ')}</> : null}</>
                : row.consumers.length
                  ? <><span style={fieldLabel}>wakes</span> {row.consumers.join(', ')}</>
                  : <span style={{ color: 'var(--eb-status-warning, #d97706)' }}>
                      no consumer — nothing reacts to this outcome&apos;s signal
                    </span>}
        </div>
      )}
    </div>
  );
}

const ACTION_ICONS = { setLabel: Tag, openPr: GitPullRequest, openIssue: CircleDot, none: Ban };

function ActionChip({ action }) {
  const Icon = ACTION_ICONS[action.type] || Ban;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Icon size={10} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
      {action.text}
      {action.label && <code style={codeChip}>{action.label}</code>}
    </span>
  );
}

/* ── styles ──────────────────────────────────────────────────────────── */
const panelBox = { display: 'flex', flexDirection: 'column', height: '100%' };
const centered = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-4)',
};
const cardBox = {
  display: 'flex', flexDirection: 'column', gap: 5,
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2)', background: 'var(--eb-bg-surface)',
};
const fieldLabel = {
  fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--eb-text-muted)', marginRight: 2,
};
const codeChip = {
  fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
  background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-sm)',
  padding: '0 4px', color: 'var(--eb-text-primary)',
};
const hintBox = {
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
};
const linkBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
  background: 'none', border: 'none', padding: 0,
  color: 'var(--eb-accent-primary)', fontFamily: 'inherit',
  fontSize: 'var(--eb-text-xs)', cursor: 'pointer', textAlign: 'left',
  textDecoration: 'none',
};
