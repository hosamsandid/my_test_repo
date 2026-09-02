import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Brain, RefreshCw, Archive, Sparkles, ArrowUpRight } from 'lucide-react';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * Agent-chat "Knowledge" tab: the CONCRETE facts this agent has learned, not a
 * live event ticker (harvests are rare — a feed sat empty most of the time).
 * Each entry carries condensation actions: nominate it as a promotion candidate
 * ("Propose as skill") or retire it from the shared KB. A header link jumps to
 * the Knowledge page scoped to the agent's team for the full team view.
 */

const KIND_COLORS = {
  fact: 'var(--eb-status-info)',
  entity: 'var(--eb-accent-primary)',
  convention: 'var(--eb-status-warning)',
};

function fmtWhen(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `today ${hm}` : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${hm}`;
}

export default function AgentKnowledgePanel({ agentId, active = false }) {
  const navigate = useNavigate();
  const [items, setItems] = useState(null); // null = loading
  const [teamId, setTeamId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState({}); // itemId -> { state: 'busy'|'proposed'|'error', msg? }
  const [retireTarget, setRetireTarget] = useState(null); // item pending retire-confirm

  const load = useCallback(() => {
    if (!agentId) { setItems([]); return; }
    setLoading(true);
    fetch(`/api/knowledge/graph?scope=agent:${encodeURIComponent(agentId)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(g => {
        if (!g) return;
        const list = (g.nodes || [])
          .filter(n => n.kind === 'item')
          .map(n => ({ ...n, id: n.id.slice(5) }))
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        setItems(list);
        const agentNode = (g.nodes || []).find(n => n.kind === 'agent' && n.agentId === agentId);
        setTeamId(agentNode?.teamId || list[0]?.teamId || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { load(); }, [load]);
  // Refetch when the tab becomes visible again — cheaper and more predictable
  // than keeping an SSE feed open for events that land a few times a day.
  useEffect(() => { if (active) load(); }, [active, load]);

  const nominate = useCallback((item) => {
    setAction(a => ({ ...a, [item.id]: { state: 'busy' } }));
    fetch(`/api/knowledge/item/${encodeURIComponent(item.id)}/nominate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setAction(a => ({ ...a, [item.id]: { state: 'proposed' } }));
      })
      .catch(e => setAction(a => ({ ...a, [item.id]: { state: 'error', msg: e.message } })));
  }, [agentId]);

  const retire = useCallback((item) => {
    setRetireTarget(null);
    setAction(a => ({ ...a, [item.id]: { state: 'busy' } }));
    fetch(`/api/knowledge/item/${encodeURIComponent(item.id)}/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: item.teamId || teamId, archived: true }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        load();
      })
      .catch(e => setAction(a => ({ ...a, [item.id]: { state: 'error', msg: e.message } })));
  }, [teamId, load]);

  const count = Array.isArray(items) ? items.length : 0;
  const teamHref = useMemo(() => (teamId ? `/knowledge?team=${encodeURIComponent(teamId)}` : '/knowledge'), [teamId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-2) var(--eb-space-3)', borderBottom: '1px solid var(--eb-border-default)',
        color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        <Brain size={13} style={{ color: 'var(--eb-accent-primary)' }} />
        <span>Learned</span>
        <span style={{ color: 'var(--eb-text-muted)' }}>{count}</span>
        <button onClick={load} title="Refresh" style={{ ...iconBtn, marginLeft: 'auto' }}>
          <RefreshCw size={12} className={loading ? 'kf-spin' : undefined} />
        </button>
        <button
          onClick={() => navigate(teamHref)}
          title="Open the Knowledge page with the whole team's shared knowledge"
          style={{ ...linkBtn }}>
          Team knowledge <ArrowUpRight size={11} />
        </button>
        <button
          onClick={() => navigate(teamId ? `/skills?team=${encodeURIComponent(teamId)}` : '/skills')}
          title="Open the Skills surface — files, version history, lineage & usage for this team's skills"
          style={{ ...linkBtn }}>
          Skills <ArrowUpRight size={11} />
        </button>
      </div>

      {/* Entries */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--eb-space-2)' }}>
        {items === null ? (
          <Hint>Loading…</Hint>
        ) : items.length === 0 ? (
          <Hint>
            Nothing learned yet. This agent records durable lessons (facts, entities,
            conventions) at the end of its sessions — they will show up here.
          </Hint>
        ) : (
          items.map(it => {
            const st = action[it.id];
            const own = it.provenance?.originAgent === agentId;
            return (
              <div key={it.id} style={{
                border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                background: 'var(--eb-bg-surface)', padding: 'var(--eb-space-2)',
                marginBottom: 'var(--eb-space-2)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[it.entryKind] || 'var(--eb-accent-primary)', flexShrink: 0 }} />
                  <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--eb-text-muted)' }}>{it.entryKind}</span>
                  {it.converged && (
                    <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-accent-primary)', background: 'var(--eb-accent-muted)', padding: '0 6px', borderRadius: 'var(--eb-radius-full)' }}>
                      {it.convergenceCount}×
                    </span>
                  )}
                  {it.inDigest && (
                    <span
                      title="Inside the team knowledge digest — guaranteed in the agent's context at session start (everything else is reachable via knowledge search)"
                      style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-success, #16a34a)', border: '1px solid currentColor', padding: '0 6px', borderRadius: 'var(--eb-radius-full)' }}>
                      digest
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>{fmtWhen(it.createdAt)}</span>
                </div>
                <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.35, wordBreak: 'break-word' }}>
                  {it.text}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {!own && (
                    <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                      with {it.provenance?.originAgent || 'team'}
                    </span>
                  )}
                  <button
                    onClick={() => nominate(it)}
                    disabled={st?.state === 'busy' || st?.state === 'proposed'}
                    title="Raise a promotion-suggestion card on the Knowledge page — you confirm the skill there"
                    style={{ ...miniBtn, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Sparkles size={11} style={{ color: 'var(--eb-status-warning)' }} />
                    {st?.state === 'busy' ? '…' : st?.state === 'proposed' ? 'Proposed ✓' : 'Propose as skill'}
                  </button>
                  <button
                    onClick={() => setRetireTarget(it)}
                    disabled={st?.state === 'busy'}
                    title="Retire this learning from the shared KB (non-destructive; kept in git)"
                    style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--eb-status-warning)', borderColor: 'var(--eb-status-warning)' }}>
                    <Archive size={11} /> Retire
                  </button>
                </div>
                {st?.state === 'error' && (
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error, #d33)', marginTop: 4 }}>
                    ⚠ {st.msg || 'Action failed'}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        open={!!retireTarget}
        title="Retire this learning?"
        message={
          <>
            <p style={{ margin: 0 }}>
              Retire this learning from the shared knowledge base?
            </p>
            {retireTarget?.text && (
              <p style={{ margin: 'var(--eb-space-2) 0 0', fontStyle: 'italic', color: 'var(--eb-text-primary)' }}>
                “{retireTarget.text}”
              </p>
            )}
            <p style={{ margin: 'var(--eb-space-3) 0 0', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
              It stays in git for audit and can be un-retired on the Knowledge page.
            </p>
          </>
        }
        variant="warning"
        confirmLabel="Retire"
        onConfirm={() => retire(retireTarget)}
        onCancel={() => setRetireTarget(null)}
      />
    </div>
  );
}

const Hint = ({ children }) => (
  <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)', padding: 'var(--eb-space-3)' }}>{children}</div>
);

const iconBtn = {
  display: 'inline-flex', alignItems: 'center', padding: 3, borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
  color: 'var(--eb-text-secondary)', cursor: 'pointer',
};

const linkBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 3,
  padding: '2px 8px', borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
  color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-xs)', cursor: 'pointer',
  textTransform: 'none', letterSpacing: 'normal', fontWeight: 'var(--eb-font-medium)',
};

const miniBtn = {
  fontSize: 'var(--eb-text-xs)', padding: '2px 8px', borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-app)',
  color: 'var(--eb-text-secondary)', cursor: 'pointer',
};
