import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Brain, RefreshCw, X, ExternalLink, GitBranch } from 'lucide-react';
import { computeFlowLayout, assignCrossCoords } from './process/flow-layout';
import KnowledgeFeed from '../components/KnowledgeFeed';

// The T0 → T1 → T2 maturity ladder rendered left→right as three fixed lanes.
const LANES = ['agent', 'team', 'global'];
const LANE_LABELS = { agent: 'Agents · T0', team: 'Team KB · T1', global: 'Skills · T2' };
const LANE_HINTS = {
  agent: 'the contributors / learners',
  team: 'durable facts, entities & conventions',
  global: 'promoted skills',
};
const KIND_COLORS = {
  fact: 'var(--eb-status-info)',
  entity: 'var(--eb-accent-primary)',
  convention: 'var(--eb-status-warning)',
};

const CARD_W = 210;
const COL_GAP = 90;
const NODE_H = { agent: 58, team: 74, skill: 46, item: 74 };
const PAD = 56; // top padding below lane headers

export default function KnowledgeFlow() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const scope = params.get('scope') || 'global';

  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState([]);
  const [agents, setAgents] = useState([]);
  const [filters, setFilters] = useState({ kind: 'all', convergedOnly: false, today: false });
  const [selected, setSelected] = useState(null); // item id (raw hex)
  const [detail, setDetail] = useState(null);
  const [pulseId, setPulseId] = useState(null);

  const setScope = useCallback((s) => {
    const next = new URLSearchParams(params);
    next.set('scope', s);
    setParams(next, { replace: false });
  }, [params, setParams]);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/knowledge/graph?scope=${encodeURIComponent(scope)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data) setGraph(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  // Scope pickers: teams + agents for the segmented control.
  useEffect(() => {
    fetch('/api/matrix/agents').then(r => r.ok ? r.json() : []).then(list => {
      const arr = Array.isArray(list) ? list : [];
      setAgents(arr.filter(a => a.role !== 'team'));
      const t = new Set();
      arr.forEach(a => t.add(a.teamId || a.parentTeamId || 'default'));
      setTeams([...t]);
    }).catch(() => {});
  }, []);

  const parsed = useMemo(() => {
    if (scope.startsWith('agent:')) return { kind: 'agent', id: scope.slice(6) };
    if (scope.startsWith('team:')) return { kind: 'team', id: scope.slice(5) };
    return { kind: 'global', id: null };
  }, [scope]);

  // Apply filter chips to item nodes, then drop edges that lose an endpoint.
  const filtered = useMemo(() => {
    if (!graph) return { nodes: [], edges: [] };
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    const keepItem = (n) => {
      if (n.kind !== 'item') return true;
      if (filters.kind !== 'all' && n.entryKind !== filters.kind) return false;
      if (filters.convergedOnly && !n.converged) return false;
      if (filters.today) {
        const t = n.createdAt ? Date.parse(n.createdAt) : NaN;
        if (Number.isNaN(t) || now - t >= DAY) return false;
      }
      return true;
    };
    const nodes = graph.nodes.filter(keepItem);
    const ids = new Set(nodes.map(n => n.id));
    const edges = graph.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    return { nodes, edges };
  }, [graph, filters]);

  // Layout: lane = stage → three exclusive column-bands via the shared pure core.
  const layout = useMemo(() => {
    const { nodes, edges } = filtered;
    if (nodes.length === 0) return { positions: new Map(), width: 400, height: 200 };
    const ids = nodes.map(n => n.id);
    const laneOf = new Map(nodes.map(n => [n.id, n.lane]));
    const heightOf = new Map(nodes.map(n => [n.id, NODE_H[n.kind] || 60]));
    const { columns } = computeFlowLayout(ids, edges, {
      stageOf: (id) => laneOf.get(id),
      stageOrder: LANES,
    });
    const center = assignCrossCoords(columns, edges, (id) => heightOf.get(id), { gap: 22 });
    // Map each lane to a fixed column x (lanes are contiguous exclusive bands).
    const laneIndex = { agent: 0, team: 1, global: 2 };
    const positions = new Map();
    let maxY = 0;
    for (const n of nodes) {
      const cx = laneIndex[n.lane] * (CARD_W + COL_GAP) + CARD_W / 2;
      const cy = (center.get(n.id) || 0) + PAD;
      positions.set(n.id, { cx, cy, w: CARD_W, h: heightOf.get(n.id) });
      maxY = Math.max(maxY, cy + heightOf.get(n.id) / 2);
    }
    const width = 3 * CARD_W + 2 * COL_GAP + 20;
    return { positions, width, height: Math.max(maxY + 40, 240) };
  }, [filtered]);

  // Pulse the matching item node when a live harvest lands.
  const onHarvest = useCallback((ev) => {
    const id = ev.entry?.id;
    if (!id) { load(); return; }
    setPulseId(`item:${id}`);
    setTimeout(() => setPulseId(p => (p === `item:${id}` ? null : p)), 950);
    // A never-seen entry means the graph is stale — refetch to place it.
    setGraph(g => {
      if (g && g.nodes.some(n => n.id === `item:${id}`)) return g;
      load();
      return g;
    });
  }, [load]);

  const openItem = useCallback((rawId, teamId) => {
    setSelected(rawId);
    setDetail(null);
    fetch(`/api/knowledge/item/${encodeURIComponent(rawId)}?teamId=${encodeURIComponent(teamId || parsed.id || 'default')}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setDetail(d))
      .catch(() => {});
  }, [parsed.id]);

  const counts = graph?.counts || { items: 0, converged: 0, today: 0, skills: 0, agents: 0 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-4)', flexWrap: 'wrap' }}>
        <Brain size={20} style={{ color: 'var(--eb-accent-primary)' }} />
        <h1 style={{ margin: 0, fontSize: 'var(--eb-text-xl)', fontFamily: 'var(--eb-font-display)', color: 'var(--eb-text-primary)' }}>
          Knowledge Flow
        </h1>
        <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
          {counts.items} learned · {counts.converged} converged · {counts.skills} skills
        </span>
        <button onClick={load} title="Refresh"
          style={btn(false)}>
          <RefreshCw size={14} className={loading ? 'kf-spin' : undefined} /> Refresh
        </button>
      </div>

      {/* Scope + filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', padding: '0 var(--eb-space-4) var(--eb-space-3)', flexWrap: 'wrap' }}>
        <Segmented value={parsed.kind} onGlobal={() => setScope('global')}
          onTeam={() => setScope(`team:${parsed.kind === 'team' ? parsed.id : (teams[0] || 'default')}`)}
          onAgent={() => setScope(`agent:${parsed.kind === 'agent' ? parsed.id : (agents[0]?.id || '')}`)} />
        {parsed.kind === 'team' && (
          <Picker value={parsed.id} options={teams.map(t => ({ value: t, label: t }))} onChange={(v) => setScope(`team:${v}`)} />
        )}
        {parsed.kind === 'agent' && (
          <Picker value={parsed.id} options={agents.map(a => ({ value: a.id, label: a.displayName || a.id }))} onChange={(v) => setScope(`agent:${v}`)} />
        )}
        <div style={{ width: 1, height: 22, background: 'var(--eb-border-default)' }} />
        <Picker value={filters.kind} onChange={(v) => setFilters(f => ({ ...f, kind: v }))}
          options={[{ value: 'all', label: 'All kinds' }, { value: 'fact', label: 'Facts' }, { value: 'entity', label: 'Entities' }, { value: 'convention', label: 'Conventions' }]} />
        <Chip active={filters.convergedOnly} onClick={() => setFilters(f => ({ ...f, convergedOnly: !f.convergedOnly }))}>Converged only</Chip>
        <Chip active={filters.today} onClick={() => setFilters(f => ({ ...f, today: !f.today }))}>Today</Chip>
      </div>

      {(graph?.warnings || []).length > 0 && (
        <div style={{ padding: '0 var(--eb-space-4) var(--eb-space-2)', color: 'var(--eb-status-warning)', fontSize: 'var(--eb-text-xs)' }}>
          {graph.warnings.join(' · ')}
        </div>
      )}

      {/* Body: canvas + right rail */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, borderTop: '1px solid var(--eb-border-default)' }}>
        <div style={{ flex: 1, overflow: 'auto', position: 'relative', background: 'var(--eb-bg-app)' }}>
          <LaneHeaders />
          {filtered.nodes.length === 0 ? (
            <div style={{ padding: 'var(--eb-space-8)', color: 'var(--eb-text-muted)' }}>
              {loading ? 'Loading…' : 'No knowledge in this scope yet. Run a team at autonomy ≥ 1 and harvests will appear here.'}
            </div>
          ) : (
            <Canvas graph={filtered} layout={layout} pulseId={pulseId}
              selectedId={selected ? `item:${selected}` : null}
              onSelectItem={(node) => openItem(node.id.slice(5), node.teamId)}
              onSelectAgent={(node) => node.agentId && navigate(`/chats/${encodeURIComponent(node.agentId)}`)} />
          )}
        </div>

        <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--eb-border-default)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--eb-bg-surface)' }}>
          {selected && detail ? (
            <Provenance detail={detail} onClose={() => { setSelected(null); setDetail(null); }} onOpenAgent={(id) => navigate(`/chats/${encodeURIComponent(id)}`)} />
          ) : (
            <KnowledgeFeed scope={scope} onHarvest={onHarvest} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Canvas (lightweight purpose-built SVG) ─────────────────────────────────── */

function Canvas({ graph, layout, pulseId, selectedId, onSelectItem, onSelectAgent }) {
  const { positions, width, height } = layout;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* edges first, under the cards */}
      {graph.edges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        const x1 = a.cx + a.w / 2;
        const x2 = b.cx - b.w / 2;
        const mx = (x1 + x2) / 2;
        const target = graph.nodes.find(n => n.id === e.to);
        const thick = e.kind === 'harvested' && target && target.converged;
        const stroke = e.kind === 'promoted' ? 'var(--eb-status-warning)' : 'var(--eb-accent-primary)';
        return (
          <path key={i}
            d={`M ${x1} ${a.cy} C ${mx} ${a.cy}, ${mx} ${b.cy}, ${x2} ${b.cy}`}
            fill="none" stroke={stroke} strokeOpacity={e.origin || thick ? 0.75 : 0.4}
            strokeWidth={thick ? 2.5 : 1.4}
            strokeDasharray={e.kind === 'promoted' ? '4 3' : undefined} />
        );
      })}
      {/* nodes */}
      {graph.nodes.map((n) => {
        const p = positions.get(n.id);
        if (!p) return null;
        const x = p.cx - p.w / 2;
        const y = p.cy - p.h / 2;
        const pulsing = n.id === pulseId;
        if (n.kind === 'agent' || n.kind === 'team') {
          return <AgentCard key={n.id} node={n} x={x} y={y} w={p.w} h={p.h}
            onClick={() => onSelectAgent(n)} pulsing={pulsing} />;
        }
        if (n.kind === 'item') {
          return <ItemCard key={n.id} node={n} x={x} y={y} w={p.w} h={p.h}
            selected={n.id === selectedId} pulsing={pulsing} onClick={() => onSelectItem(n)} />;
        }
        return <SkillCard key={n.id} node={n} x={x} y={y} w={p.w} h={p.h} />;
      })}
    </svg>
  );
}

function foreign(x, y, w, h, children, extra = {}) {
  return (
    <foreignObject x={x} y={y} width={w} height={h}>
      <div xmlns="http://www.w3.org/1999/xhtml" style={{
        boxSizing: 'border-box', width: '100%', height: '100%',
        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)',
        background: 'var(--eb-bg-surface)', padding: 'var(--eb-space-2)',
        overflow: 'hidden', ...extra,
      }}>{children}</div>
    </foreignObject>
  );
}

function AgentCard({ node, x, y, w, h, onClick, pulsing }) {
  return (
    <g className={pulsing ? 'kf-node-pulse' : undefined} style={{ cursor: 'pointer' }} onClick={onClick}>
      {foreign(x, y, w, h, (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: node.faded ? 0.5 : 1 }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {node.label}
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {node.kind === 'team' ? 'team' : 'agent'} · {node.counts?.items || 0} learned
            {node.counts?.today ? <span style={{ color: 'var(--eb-status-success)' }}> +{node.counts.today}</span> : null}
          </div>
        </div>
      ))}
    </g>
  );
}

function ItemCard({ node, x, y, w, h, selected, pulsing, onClick }) {
  return (
    <g className={pulsing ? 'kf-node-pulse' : undefined} style={{ cursor: 'pointer' }} onClick={onClick}>
      {foreign(x, y, w, h, (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
            <span style={{ width: 7, height: 7, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[node.entryKind] || 'var(--eb-accent-primary)', flexShrink: 0 }} />
            <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--eb-text-muted)' }}>{node.entryKind}</span>
            {node.converged && (
              <span style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-accent-primary)', background: 'var(--eb-accent-muted)', padding: '0 6px', borderRadius: 'var(--eb-radius-full)' }}>
                {node.convergenceCount}× independent
              </span>
            )}
          </div>
          <div style={{
            fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.3,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{node.text}</div>
        </div>
      ), selected ? { borderColor: 'var(--eb-accent-primary)', boxShadow: '0 0 0 2px var(--eb-accent-muted)' } : {})}
    </g>
  );
}

function SkillCard({ node, x, y, w, h }) {
  return (
    <g>
      {foreign(x, y, w, h, (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <GitBranch size={13} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.label}</div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{node.tier} skill</div>
          </div>
        </div>
      ), { background: 'var(--eb-bg-elevated)' })}
    </g>
  );
}

function LaneHeaders() {
  return (
    <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 2, background: 'var(--eb-bg-app)', paddingTop: 'var(--eb-space-2)' }}>
      {LANES.map((lane, i) => (
        <div key={lane} style={{ width: CARD_W, marginLeft: i === 0 ? 10 : COL_GAP }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>{LANE_LABELS[lane]}</div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{LANE_HINTS[lane]}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Provenance drill-down ──────────────────────────────────────────────────── */

function Provenance({ detail, onClose, onOpenAgent }) {
  const { entry, links } = detail;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: 'var(--eb-space-3)', borderBottom: '1px solid var(--eb-border-default)' }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>Provenance</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', ...btn(false), padding: 4 }}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <div>
          <div style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', color: 'var(--eb-text-muted)' }}>{entry.kind}</div>
          <div style={{ fontSize: 'var(--eb-text-md)', color: 'var(--eb-text-primary)', marginTop: 2 }}>{entry.text}</div>
        </div>
        <Lineage label="Origin agent">
          {links.originAgent
            ? <LinkRow onClick={() => onOpenAgent(links.originAgent.agentId)}>{links.originAgent.agentId}</LinkRow>
            : <Muted>unknown</Muted>}
        </Lineage>
        <Lineage label="Session">
          {links.session?.href
            ? <LinkRow onClick={() => onOpenAgent(links.session.agentId)}>{links.session.roomId ? `room ${links.session.roomId}` : 'open chat'}{links.session.correlationId ? ` · ${links.session.correlationId}` : ''}</LinkRow>
            : <Muted>{entry.correlationId || 'no session link'}</Muted>}
        </Lineage>
        <Lineage label="Source">
          {(links.sourceRefs || []).length > 0
            ? links.sourceRefs.map((r, i) => (
                <a key={i} href={r.url} target="_blank" rel="noreferrer"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-sm)', textDecoration: 'none', marginBottom: 4 }}>
                  <ExternalLink size={12} /> {r.kind} {r.ref}
                </a>))
            : <Muted>no PR/issue/commit linked</Muted>}
        </Lineage>
        <Lineage label="Convergence">
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
            {entry.convergence?.length || 1}× — {(entry.convergence || []).join(', ') || entry.originAgent}
          </div>
        </Lineage>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {entry.teamId} · {entry.createdAt}
        </div>
      </div>
    </div>
  );
}

const Lineage = ({ label, children }) => (
  <div>
    <div style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--eb-text-muted)', marginBottom: 4 }}>{label}</div>
    {children}
  </div>
);
const LinkRow = ({ onClick, children }) => (
  <button onClick={onClick} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', textAlign: 'left' }}>{children}</button>
);
const Muted = ({ children }) => <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>{children}</span>;

/* ── small controls ─────────────────────────────────────────────────────────── */

function Segmented({ value, onGlobal, onTeam, onAgent }) {
  const opt = (k, label, fn) => (
    <button onClick={fn} style={{
      padding: '4px var(--eb-space-3)', border: 'none', cursor: 'pointer',
      background: value === k ? 'var(--eb-accent-primary)' : 'transparent',
      color: value === k ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)',
      fontSize: 'var(--eb-text-sm)',
    }}>{label}</button>
  );
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', overflow: 'hidden' }}>
      {opt('global', 'Global', onGlobal)}
      {opt('team', 'Team', onTeam)}
      {opt('agent', 'Agent', onAgent)}
    </div>
  );
}

function Picker({ value, options, onChange }) {
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} style={{
      padding: '4px var(--eb-space-2)', borderRadius: 'var(--eb-radius-md)',
      border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
      color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)',
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px var(--eb-space-3)', borderRadius: 'var(--eb-radius-full)', cursor: 'pointer',
      border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
      background: active ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
      color: active ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
      fontSize: 'var(--eb-text-sm)',
    }}>{children}</button>
  );
}

const btn = () => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
  padding: '4px var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
  color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
});
