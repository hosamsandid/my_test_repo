import React, { useState, useEffect, useCallback } from 'react';
import { TrendingUp, Play, AlertTriangle, Info, Clock, Lightbulb, Undo2, Check, X } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import WhenCell from '../../components/WhenCell';
import { apiCall } from '../../hooks/useApi';
import {
  hasSnapshot, isMaintenance, snapshotMeta, metricTiles,
  cardClassLabel, cardStatusBadge, cardsFromResponse, splitCards,
  cardAction, cardObjectLabel, verdictLine, evidenceLines,
} from './hill-climb-view';

// Improvements panel (hill-climbing loop, #1223) — sibling of the Anomalies
// panel (`FlowAnomaliesPanel.jsx`). Renders the deterministic §4 run-metric
// catalog for a LIVE team from the latest persisted snapshot
// (`GET /api/teams/:id/hill-climb/metrics`, #1222), the improvement-card list
// (`GET .../hill-climb/cards`, #1224) with the gated one-click Apply (#1225)
// and rollback (#1226) actions, the closed-card ledger, and a manual pass
// (`POST .../hill-climb/run`).
export default function ImprovementsPanel({ teamId, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, resp: null });
  const [cardState, setCardState] = useState({ loading: true, error: null, autonomy: null, cards: [] });
  const [running, setRunning] = useState(false);
  const [busyCardId, setBusyCardId] = useState(null);
  const [notice, setNotice] = useState(null); // { tone, text }

  const loadMetrics = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const resp = await apiCall('GET', `/api/teams/${encodeURIComponent(teamId)}/hill-climb/metrics`);
      setState({ loading: false, error: null, resp });
    } catch (err) {
      setState({ loading: false, error: err.message || 'Failed to load', resp: null });
    }
  }, [teamId]);

  const loadCards = useCallback(async () => {
    setCardState((s) => ({ ...s, loading: true, error: null }));
    try {
      const resp = await apiCall('GET', `/api/teams/${encodeURIComponent(teamId)}/hill-climb/cards`);
      const { autonomy, cards } = cardsFromResponse(resp);
      setCardState({ loading: false, error: null, autonomy, cards });
    } catch (err) {
      setCardState((s) => ({ ...s, loading: false, error: err.message || 'Failed to load cards' }));
    }
  }, [teamId]);

  useEffect(() => { loadMetrics(); loadCards(); }, [loadMetrics, loadCards]);

  // Run now → a manual pass (metrics + heuristic/analyst cards). The panel
  // reflects the fresh snapshot from the response without a reload (AC), then
  // re-reads the card store the pass just merged into. A pass already in
  // flight answers 409 pass-running; maintenance mode answers `{ maintenance:true }`.
  const runNow = useCallback(async () => {
    setRunning(true);
    setNotice(null);
    try {
      const resp = await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/hill-climb/run`);
      if (isMaintenance(resp)) {
        setNotice({ tone: 'info', text: 'Maintenance mode is active — the metrics pass is paused. Try again once maintenance ends.' });
      } else {
        setState({ loading: false, error: null, resp });
        await loadCards();
      }
    } catch (err) {
      if (err.status === 409) {
        setNotice({ tone: 'info', text: 'A metrics pass is already running for this team — give it a moment, then Refresh.' });
      } else {
        setNotice({ tone: 'error', text: err.message || 'Run failed' });
      }
    } finally {
      setRunning(false);
    }
  }, [teamId, loadCards]);

  // Card actions. The server holds every gate (autonomy, staleness, protected
  // triggers) — this only relays and re-reads the store afterwards so the panel
  // always shows the persisted truth, never an optimistic guess.
  const runCardAction = useCallback(async (card, action) => {
    setBusyCardId(card.id);
    setNotice(null);
    try {
      await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/hill-climb/cards/${encodeURIComponent(card.id)}/${action}`);
      const done = action === 'apply' ? 'applied — its effect is measured over the next window'
        : action === 'rollback' ? 'rolled back — the change was reverted'
        : 'dismissed — it will not be raised again';
      setNotice({ tone: 'info', text: `Card ${done}.` });
    } catch (err) {
      setNotice({ tone: 'error', text: `Could not ${action} the card: ${err.message}` });
    } finally {
      setBusyCardId(null);
      await loadCards();
    }
  }, [teamId, loadCards]);

  const resp = state.resp;
  const snapshot = hasSnapshot(resp) ? resp.snapshot : null;
  const meta = snapshot ? snapshotMeta(snapshot) : null;
  const tiles = snapshot ? metricTiles(snapshot) : [];
  const { actionable, ledger } = splitCards(cardState.cards);

  return (
    <SidePanel open onClose={onClose} title="Improvements" width="560px">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)' }}>
        <p style={{ flex: 1, margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
          Run metrics and improvement cards for this team, folded from session logs, anomaly sweeps and
          the event log. Cards are proposals with cited evidence — nothing changes until you apply one,
          and every apply runs through the same audited endpoints you would use by hand.
        </p>
        <button
          onClick={runNow}
          disabled={running}
          title="Run a metrics + card pass now"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: '4px 10px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', flexShrink: 0,
            color: 'var(--eb-text-primary)', cursor: running ? 'default' : 'pointer',
          }}
        >
          <Play size={13} style={running ? { animation: 'spin 1s linear infinite' } : undefined} />
          {running ? 'Running…' : 'Run now'}
        </button>
      </div>

      {notice && (
        <Banner icon={notice.tone === 'error' ? AlertTriangle : Info} tone={notice.tone}>{notice.text}</Banner>
      )}

      {state.loading && (
        <p style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>Loading metrics…</p>
      )}
      {state.error && !state.loading && (
        <Banner icon={AlertTriangle} tone="error">{state.error}</Banner>
      )}

      {/* Empty state — team has never run a pass. */}
      {!state.loading && !state.error && !snapshot && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--eb-space-3)',
          padding: 'var(--eb-space-6) var(--eb-space-4)', textAlign: 'center',
          color: 'var(--eb-text-secondary)',
        }}>
          <TrendingUp size={28} style={{ color: 'var(--eb-text-tertiary, var(--eb-text-secondary))' }} />
          <div style={{ fontSize: 'var(--eb-text-sm)', lineHeight: 1.5 }}>
            No metrics pass has run for this team yet.<br />
            Run one now to fold the last window of run activity into the metric catalog.
          </div>
        </div>
      )}

      {/* Metric tiles. */}
      {!state.loading && !state.error && snapshot && (
        <>
          {meta.insufficientData && (
            <Banner icon={Info}>
              Only {meta.totalRuns} run(s) in the window — below the {meta.minRuns}-run floor. Ratio metrics
              are withheld rather than reported off a thin sample; counting metrics are still shown.
            </Banner>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--eb-space-2)' }}>
            {tiles.map((t) => <MetricTile key={t.key} tile={t} />)}
          </div>

          <div style={{
            marginTop: 'var(--eb-space-4)', display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))',
          }}>
            <Clock size={12} />
            {meta.windowDays ? `${meta.windowDays}-day window · ` : ''}
            {meta.totalRuns} run(s)
            {meta.generatedAt ? <> · last pass <WhenCell iso={meta.generatedAt} /></> : ''}
          </div>
        </>
      )}

      {/* Improvement cards. */}
      <div style={{
        marginTop: 'var(--eb-space-5)', paddingTop: 'var(--eb-space-4)',
        borderTop: '1px solid var(--eb-border-default)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--eb-space-3)',
          fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: 'var(--eb-text-primary)',
        }}>
          <Lightbulb size={15} />
          Improvement cards
          {actionable.length > 0 && (
            <span style={{ fontWeight: 400, color: 'var(--eb-text-secondary)' }}>· {actionable.length} awaiting review</span>
          )}
        </div>

        {cardState.loading && (
          <p style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>Loading cards…</p>
        )}
        {cardState.error && !cardState.loading && (
          <Banner icon={AlertTriangle} tone="error">{cardState.error}</Banner>
        )}

        {!cardState.loading && !cardState.error && cardState.autonomy === 0 && (
          <Banner icon={Info}>
            The improvement loop runs collector-only for this team (autonomy 0) — metrics are gathered
            but no cards are raised.
          </Banner>
        )}

        {!cardState.loading && !cardState.error && cardState.autonomy === 1 && actionable.length > 0 && (
          <Banner icon={Info}>
            Cards are read-only at autonomy 1 — raise the team's autonomy to 2 for one-click Apply.
          </Banner>
        )}

        {!cardState.loading && !cardState.error && cardState.autonomy !== 0 && actionable.length === 0 && (
          <p style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', margin: 0 }}>
            No open improvement cards — the loop has nothing to propose right now.
          </p>
        )}

        {!cardState.loading && !cardState.error && actionable.map((card) => (
          <ImprovementCard
            key={card.id}
            card={card}
            autonomy={cardState.autonomy}
            busy={busyCardId === card.id}
            anyBusy={busyCardId != null}
            onAction={runCardAction}
          />
        ))}

        {/* Closed-card ledger — the change log of what the loop learned. */}
        {!cardState.loading && !cardState.error && ledger.length > 0 && (
          <details style={{ marginTop: 'var(--eb-space-3)' }}>
            <summary style={{
              cursor: 'pointer', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
              userSelect: 'none',
            }}>
              Change log ({ledger.length})
            </summary>
            <div style={{ marginTop: 'var(--eb-space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
              {ledger.map((card) => <LedgerRow key={card.id} card={card} />)}
            </div>
          </details>
        )}
      </div>
    </SidePanel>
  );
}

const BADGE_TONE_COLORS = {
  ok: 'var(--eb-status-success, #16a34a)',
  info: 'var(--eb-accent-primary)',
  warn: 'var(--eb-status-warning, #d97706)',
  error: 'var(--eb-status-error, #dc2626)',
  muted: 'var(--eb-text-secondary)',
};

function StatusBadge({ status }) {
  const badge = cardStatusBadge(status);
  const color = BADGE_TONE_COLORS[badge.tone] || BADGE_TONE_COLORS.muted;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, color,
      border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
      background: `color-mix(in srgb, ${color} 10%, transparent)`,
      whiteSpace: 'nowrap',
    }}>
      {badge.label}
    </span>
  );
}

// One actionable card: class/risk/source chips + status, title, detail, the
// object it targets, its evidence citations, and the gated action row.
function ImprovementCard({ card, autonomy, busy, anyBusy, onAction }) {
  const action = cardAction(card, autonomy);
  const object = cardObjectLabel(card);
  const evidence = evidenceLines(card);
  const verdict = verdictLine(card);
  const regressedReason = card.status === 'regressed' && card.rollback ? card.rollback.reason : null;

  return (
    <div style={{
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)',
      marginBottom: 'var(--eb-space-2)', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <StatusBadge status={card.status} />
        <span style={{ fontSize: 11, color: 'var(--eb-text-secondary)' }}>
          {cardClassLabel(card.class)} · {card.riskClass} risk · {card.source}
          {card.seen > 1 ? ` · seen ${card.seen}×` : ''}
        </span>
      </div>

      <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: 'var(--eb-text-primary)', lineHeight: 1.4 }}>
        {card.title}
      </div>
      {card.detail && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
          {card.detail}
        </div>
      )}

      {regressedReason && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: BADGE_TONE_COLORS.error, lineHeight: 1.4 }}>
          {regressedReason}
        </div>
      )}
      {!regressedReason && verdict && (
        <div style={{ fontSize: 11, color: 'var(--eb-text-secondary)', fontFamily: 'var(--eb-font-mono, monospace)' }}>
          {verdict}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))' }}>
        {object && <span>{object} · </span>}
        target metric <span style={{ fontFamily: 'var(--eb-font-mono, monospace)' }}>{card.targetMetric}</span>
      </div>

      {evidence.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--eb-text-secondary)', userSelect: 'none' }}>
            Evidence ({evidence.length})
          </summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {evidence.map((line, i) => (
              <li key={i} style={{ fontSize: 11, color: 'var(--eb-text-secondary)', fontFamily: 'var(--eb-font-mono, monospace)', lineHeight: 1.6 }}>
                {line}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 2, flexWrap: 'wrap' }}>
        {action.kind === 'apply' && (
          <ActionButton
            primary
            icon={Check}
            label={busy ? 'Applying…' : 'Apply'}
            disabled={!action.enabled || anyBusy}
            title={action.hint || 'Run this card’s change through the audited apply path'}
            onClick={() => onAction(card, 'apply')}
          />
        )}
        {action.kind === 'rollback' && (
          <ActionButton
            primary
            icon={Undo2}
            label={busy ? 'Rolling back…' : 'Roll back'}
            disabled={!action.enabled || anyBusy}
            title={action.hint || 'Revert this change through the same audited path'}
            onClick={() => onAction(card, 'rollback')}
          />
        )}
        <ActionButton
          icon={X}
          label={busy ? 'Working…' : 'Dismiss'}
          disabled={anyBusy}
          title="Close this card without acting — the finding will not be raised again"
          onClick={() => onAction(card, 'dismiss')}
        />
        {action.hint && (
          <span style={{ fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))', flexBasis: '100%' }}>
            {action.hint}
          </span>
        )}
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, disabled, title, primary }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: primary && !disabled ? 'var(--eb-accent-primary)' : 'none',
        color: primary && !disabled ? 'var(--eb-text-inverted, #fff)' : 'var(--eb-text-primary)',
        border: primary && !disabled ? '1px solid transparent' : '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)', padding: '3px 10px',
        fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
      }}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

// A compact ledger row: what happened to a closed (or still-measuring) card.
function LedgerRow({ card }) {
  const verdict = verdictLine(card);
  const when = card.status === 'applied' && card.appliedAt ? card.appliedAt : card.updatedAt;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 3,
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
      background: 'var(--eb-bg-elevated)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <StatusBadge status={card.status} />
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>{card.title}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))' }}>
        {cardClassLabel(card.class)}
        {card.appliedBy ? ` · applied by ${card.appliedBy}` : ''}
        {when ? <> · <WhenCell iso={when} /></> : ''}
        {verdict ? ` · ${verdict}` : ''}
      </div>
    </div>
  );
}

// One metric tile. Big value for 'ok'; an explicit muted state label for
// 'insufficient' / 'none' — never a misleading zero.
function MetricTile({ tile }) {
  const isValue = tile.state === 'ok';
  const stateLabel = tile.state === 'insufficient' ? 'Insufficient data' : '—';
  return (
    <div style={{
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div
        title={tile.help || undefined}
        style={{
          fontSize: 11, color: 'var(--eb-text-secondary)', textTransform: 'uppercase',
          letterSpacing: '0.03em', cursor: tile.help ? 'help' : undefined,
        }}
      >{tile.label}</div>
      <div style={{
        fontSize: isValue ? 'var(--eb-text-xl, 1.35rem)' : 'var(--eb-text-sm)',
        fontWeight: isValue ? 600 : 400,
        color: isValue ? 'var(--eb-text-primary)' : 'var(--eb-text-tertiary, var(--eb-text-secondary))',
        fontStyle: isValue ? 'normal' : 'italic',
      }}>
        {isValue ? tile.value : stateLabel}
      </div>
      {tile.sub && (
        <div style={{ fontSize: 11, color: 'var(--eb-text-secondary)' }}>{tile.sub}</div>
      )}
      {tile.note && (
        <div style={{ fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))', lineHeight: 1.4 }}>
          {tile.note}
        </div>
      )}
    </div>
  );
}

function Banner({ icon: Icon, tone, children }) {
  const color = tone === 'error' ? 'var(--eb-status-error, #dc2626)' : 'var(--eb-text-secondary)';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
      background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
      fontSize: 'var(--eb-text-sm)', color,
    }}>
      <Icon size={15} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{children}</span>
    </div>
  );
}
