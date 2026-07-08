import React, { useState, useCallback, useRef } from 'react';
import { Brain, Sparkles } from 'lucide-react';
import useSSE from '../hooks/useSSE';

/**
 * Live feed of recent knowledge harvests / promotions (Shared Agent Learning,
 * Phase 2). Subscribes to GET /api/knowledge/stream?scope=… through the shared
 * useSSE hook; new events animate in at the top. Used in the Knowledge Flow
 * right rail, the agent-chat Knowledge tab (scope=agent:<id>), and the team view.
 *
 * Purely presentational + its own SSE subscription. Control frames (_cursor /
 * _truncated) are ignored. `onHarvest(event)` lets a parent pulse a matching
 * node when a harvest lands.
 */
const KIND_COLORS = {
  fact: 'var(--eb-status-info)',
  entity: 'var(--eb-accent-primary)',
  convention: 'var(--eb-status-warning)',
};

export default function KnowledgeFeed({ scope, max = 40, onHarvest, onEvent, emptyHint }) {
  const [events, setEvents] = useState([]);
  const onHarvestRef = useRef(onHarvest);
  onHarvestRef.current = onHarvest;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const handleEvent = useCallback((ev) => {
    if (!ev || typeof ev.type !== 'string' || ev.type.startsWith('_')) return;
    setEvents(prev => [{ ...ev, _rx: Date.now() }, ...prev].slice(0, max));
    if (ev.type === 'harvest') { try { onHarvestRef.current?.(ev); } catch { /* ignore */ } }
    try { onEventRef.current?.(ev); } catch { /* ignore */ }
  }, [max]);

  const url = scope ? `/api/knowledge/stream?scope=${encodeURIComponent(scope)}` : null;
  const { status } = useSSE(url, { onEvent: handleEvent });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-2) var(--eb-space-3)', borderBottom: '1px solid var(--eb-border-default)',
        color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        <Brain size={13} style={{ color: 'var(--eb-accent-primary)' }} />
        <span>Live learning</span>
        <span title={`feed ${status}`} style={{
          marginLeft: 'auto', width: 7, height: 7, borderRadius: 'var(--eb-radius-full)',
          background: status === 'open' ? 'var(--eb-status-success)' : 'var(--eb-text-muted)',
        }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--eb-space-2)' }}>
        {events.length === 0 ? (
          <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)', padding: 'var(--eb-space-3)' }}>
            {emptyHint || 'Waiting for harvests… durable lessons agents record will appear here in real time.'}
          </div>
        ) : (
          events.map((ev, i) => <FeedRow key={`${ev.entry?.id || ev.ts}-${i}`} ev={ev} />)
        )}
      </div>
    </div>
  );
}

function FeedRow({ ev }) {
  const isPromotion = ev.type === 'promotion';
  const isSuggestion = ev.type === 'suggestion';
  const entry = ev.entry || null;
  const kind = entry?.kind || 'fact';
  if (isSuggestion) {
    const n = ev.count || (Array.isArray(ev.samples) ? ev.samples.length : 1);
    const sample = Array.isArray(ev.samples) && ev.samples[0];
    return (
      <div style={{
        display: 'flex', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2)',
        borderRadius: 'var(--eb-radius-md)', marginBottom: 'var(--eb-space-1)',
        background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-status-warning)',
        animation: 'kf-fade-in 260ms ease-out',
      }}>
        <div style={{ flexShrink: 0, marginTop: 2 }}>
          <Sparkles size={13} style={{ color: 'var(--eb-status-warning)' }} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
            {n} promotion suggestion{n === 1 ? '' : 's'} ready to review
          </div>
          {sample?.text && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 2, wordBreak: 'break-word' }}>
              e.g. “{sample.text}”{sample.convergenceCount > 1 ? ` · ${sample.convergenceCount}× independent` : ''}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div style={{
      display: 'flex', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2)',
      borderRadius: 'var(--eb-radius-md)', marginBottom: 'var(--eb-space-1)',
      background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
      animation: 'kf-fade-in 260ms ease-out',
    }}>
      <div style={{ flexShrink: 0, marginTop: 2 }}>
        {isPromotion
          ? <Sparkles size={13} style={{ color: 'var(--eb-status-warning)' }} />
          : <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[kind] || 'var(--eb-accent-primary)' }} />}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', wordBreak: 'break-word' }}>
          {isPromotion
            ? <>Promoted skill <strong>{ev.skill?.name || 'skill'}</strong></>
            : (entry?.text || 'A durable lesson was recorded')}
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 2 }}>
          {!isPromotion && <span style={{ textTransform: 'uppercase', letterSpacing: '0.03em' }}>{kind}</span>}
          {ev.agentId && <> · {ev.agentId}</>}
          {entry?.convergenceCount > 1 && <> · {entry.convergenceCount}× independent</>}
        </div>
      </div>
    </div>
  );
}
