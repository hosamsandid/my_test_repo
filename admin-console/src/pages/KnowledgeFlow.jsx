import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Brain, RefreshCw, X, ExternalLink, GitBranch, Sparkles, Check, Wand2 } from 'lucide-react';
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
const NODE_H = { agent: 58, team: 74, skill: 46, item: 74, pending: 46 };
const PAD = 56; // top padding below lane headers

export default function KnowledgeFlow() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const scope = params.get('scope') || 'global';

  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState([]);
  const [agents, setAgents] = useState([]);
  const [filters, setFilters] = useState({ kind: 'all', convergedOnly: false, today: false, showArchived: false });
  const [selected, setSelected] = useState(null); // item id (raw hex)
  const [detail, setDetail] = useState(null);
  const [pulseId, setPulseId] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [promoting, setPromoting] = useState(null); // candidate under review

  const setScope = useCallback((s) => {
    const next = new URLSearchParams(params);
    next.set('scope', s);
    setParams(next, { replace: false });
  }, [params, setParams]);

  const load = useCallback(() => {
    setLoading(true);
    const q = filters.showArchived ? '&includeArchived=1' : '';
    fetch(`/api/knowledge/graph?scope=${encodeURIComponent(scope)}${q}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data) setGraph(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scope, filters.showArchived]);

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

  // Promotion suggestions (autonomy level 2) — team scope only (the store is
  // per-team). Reloaded on scope change and whenever a suggestion/promotion
  // event lands on the live feed.
  const loadSuggestions = useCallback(() => {
    if (parsed.kind !== 'team' || !parsed.id) { setSuggestions([]); return; }
    fetch(`/api/knowledge/promotion-suggestions?team=${encodeURIComponent(parsed.id)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setSuggestions(Array.isArray(d?.suggestions) ? d.suggestions : []))
      .catch(() => {});
  }, [parsed.kind, parsed.id]);

  useEffect(() => { loadSuggestions(); }, [loadSuggestions]);

  // Promotion gate policy + autonomy level (Phase 4) — team scope only.
  const [gates, setGates] = useState(null);
  const loadGates = useCallback(() => {
    if (parsed.kind !== 'team' || !parsed.id) { setGates(null); return; }
    fetch(`/api/knowledge/gates?team=${encodeURIComponent(parsed.id)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setGates(d))
      .catch(() => {});
  }, [parsed.kind, parsed.id]);
  useEffect(() => { loadGates(); }, [loadGates]);

  const setGate = useCallback((transition, mode) => {
    if (!parsed.id) return;
    fetch('/api/knowledge/gates', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: parsed.id, transition, mode }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(() => { loadGates(); load(); })
      .catch(() => {});
  }, [parsed.id, loadGates, load]);

  // Private (agent-tier) skills — agent scope only. The lift target (agent→team).
  const [privateSkills, setPrivateSkills] = useState([]);
  const [privateTeam, setPrivateTeam] = useState('default');
  const loadPrivateSkills = useCallback(() => {
    if (parsed.kind !== 'agent' || !parsed.id) { setPrivateSkills([]); return; }
    fetch(`/api/agents/${encodeURIComponent(parsed.id)}/private-skills`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { setPrivateSkills(Array.isArray(d?.skills) ? d.skills : []); if (d?.teamId) setPrivateTeam(d.teamId); })
      .catch(() => {});
  }, [parsed.kind, parsed.id]);
  useEffect(() => { loadPrivateSkills(); }, [loadPrivateSkills]);

  const onFeedEvent = useCallback((ev) => {
    if (ev?.type === 'suggestion' || ev?.type === 'promotion') { loadSuggestions(); load(); }
  }, [loadSuggestions, load]);

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

  const archiveItem = useCallback((id, teamId, archived) => {
    fetch(`/api/knowledge/item/${encodeURIComponent(id)}/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: teamId || parsed.id || 'default', archived }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(() => { setSelected(null); setDetail(null); load(); })
      .catch(() => {});
  }, [parsed.id, load]);

  const openItem = useCallback((rawId, teamId, archivedHint) => {
    setSelected(rawId);
    setDetail(null);
    fetch(`/api/knowledge/item/${encodeURIComponent(rawId)}?teamId=${encodeURIComponent(teamId || parsed.id || 'default')}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        // The graph node's status is authoritative (it reflects the archived
        // overlay on the canonical file); the item route may see a stale shard copy.
        if (d && d.entry && archivedHint) d.entry.status = 'archived';
        setDetail(d);
      })
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
        <Chip active={filters.showArchived} onClick={() => setFilters(f => ({ ...f, showArchived: !f.showArchived }))}>Show archived</Chip>
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
              onSelectItem={(node) => openItem(node.id.slice(5), node.teamId, node.archived)}
              onReviewPending={(node) => {
                const s = suggestions.find(x => x.id === node.suggestionId);
                if (s) setPromoting(s);
              }}
              onSelectAgent={(node) => node.agentId && navigate(`/chats/${encodeURIComponent(node.agentId)}`)} />
          )}
        </div>

        <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--eb-border-default)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--eb-bg-surface)' }}>
          {selected && detail ? (
            <Provenance detail={detail} onClose={() => { setSelected(null); setDetail(null); }} onOpenAgent={(id) => navigate(`/chats/${encodeURIComponent(id)}`)} onArchive={archiveItem} />
          ) : (
            <>
              {parsed.kind === 'team' && gates && (
                <GatePanel data={gates} onSet={setGate} />
              )}
              {parsed.kind === 'team' && suggestions.length > 0 && (
                <SuggestionsPanel suggestions={suggestions} onReview={(s) => setPromoting(s)} />
              )}
              {parsed.kind === 'agent' && privateSkills.length > 0 && (
                <PrivateSkillsPanel agentId={parsed.id} teamId={privateTeam} skills={privateSkills}
                  onDone={() => { loadPrivateSkills(); load(); }} />
              )}
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <KnowledgeFeed scope={scope} onHarvest={onHarvest} onEvent={onFeedEvent} />
              </div>
            </>
          )}
        </div>
      </div>

      {promoting && (
        <PromotionDialog
          suggestion={promoting}
          teamId={parsed.id}
          onClose={() => setPromoting(null)}
          onDone={() => { setPromoting(null); loadSuggestions(); load(); }}
        />
      )}
    </div>
  );
}

/* ── Promotion suggestions (autonomy level 2) ───────────────────────────────── */

function SuggestionsPanel({ suggestions, onReview }) {
  return (
    <div style={{ borderBottom: '1px solid var(--eb-border-default)', maxHeight: '46%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-2) var(--eb-space-3)', borderBottom: '1px solid var(--eb-border-default)',
        color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        <Sparkles size={13} style={{ color: 'var(--eb-status-warning)' }} />
        <span>Promotion suggestions</span>
        <span style={{ marginLeft: 'auto', color: 'var(--eb-text-muted)' }}>{suggestions.length}</span>
      </div>
      <div style={{ overflowY: 'auto', padding: 'var(--eb-space-2)' }}>
        {suggestions.map(s => (
          <div key={s.id} style={{
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)', background: 'var(--eb-bg-app)',
          }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', wordBreak: 'break-word' }}>{s.text}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)' }}>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', fontWeight: 'var(--eb-font-semibold)' }}>
                {s.convergenceCount}× independent
              </span>
              {s.source === 'agent-nominated' && (
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>nominated</span>
              )}
              <button onClick={() => onReview(s)} style={primaryBtn}>Review & promote</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Private (agent-tier) skills — lift to team (Phase 4 agent→team) ─────────── */

function PrivateSkillsPanel({ agentId, teamId, skills, onDone }) {
  const [state, setState] = useState({}); // name -> 'lifting' | 'done' | 'exists' | 'error'
  const [errMsg, setErrMsg] = useState({}); // name -> server error text

  const lift = (name) => {
    setState(s => ({ ...s, [name]: 'lifting' }));
    fetch('/api/knowledge/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'agent', to: 'team', teamId, agentId, name }),
    })
      .then(async r => {
        if (r.status === 201) { setState(s => ({ ...s, [name]: 'done' })); onDone && onDone(); return; }
        if (r.status === 409) { setState(s => ({ ...s, [name]: 'exists' })); return; }
        const body = await r.json().catch(() => ({}));
        setErrMsg(m => ({ ...m, [name]: body.error || 'Lift failed' }));
        setState(s => ({ ...s, [name]: 'error' }));
      })
      .catch(() => setState(s => ({ ...s, [name]: 'error' })));
  };

  return (
    <div style={{ borderBottom: '1px solid var(--eb-border-default)', maxHeight: '46%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-2) var(--eb-space-3)', borderBottom: '1px solid var(--eb-border-default)',
        color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        <GitBranch size={13} style={{ color: 'var(--eb-status-warning)' }} />
        <span>Private skills</span>
        <span style={{ marginLeft: 'auto', color: 'var(--eb-text-muted)' }}>{skills.length}</span>
      </div>
      <div style={{ overflowY: 'auto', padding: 'var(--eb-space-2)' }}>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', padding: '0 var(--eb-space-1) var(--eb-space-2)' }}>
          Lift a private skill up to <strong>{teamId}</strong> so the whole team gets it (agent→team).
        </div>
        {skills.map(sk => {
          const st = state[sk.name];
          return (
            <div key={sk.name} style={{
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
              padding: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)', background: 'var(--eb-bg-app)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
                <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', wordBreak: 'break-word', flex: 1 }}>{sk.name}</div>
                <button onClick={() => lift(sk.name)} disabled={st === 'lifting' || st === 'done'} style={primaryBtn}>
                  {st === 'lifting' ? 'Lifting…' : st === 'done' ? 'Lifted ✓' : 'Lift to team'}
                </button>
              </div>
              {st === 'exists' && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', marginTop: 4 }}>A team skill with this name already exists.</div>}
              {st === 'error' && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 4 }}>{errMsg[sk.name] || 'Lift failed — try again.'}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PromotionDialog({ suggestion, teamId, onClose, onDone }) {
  const [name, setName] = useState(suggestion.draft?.name || '');
  const [skillMd, setSkillMd] = useState(suggestion.draft?.skillMd || '');
  const [tier, setTier] = useState('team');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const draftWithAI = () => {
    setBusy('draft'); setError('');
    fetch(`/api/knowledge/promotion-suggestions/${encodeURIComponent(suggestion.id)}/draft`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: teamId }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.draft?.skillMd) { setSkillMd(d.draft.skillMd); if (d.draft.name) setName(d.draft.name); } })
      .catch(() => setError('Draft failed'))
      .finally(() => setBusy(''));
  };

  const promote = () => {
    setBusy('promote'); setError('');
    fetch('/api/knowledge/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'team', to: tier, teamId, name, skillMd,
        entryIds: suggestion.entryIds, suggestionId: suggestion.id,
      }),
    })
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); })
      .then(() => onDone())
      .catch(e => { setError(e.message); setBusy(''); });
  };

  const dismiss = () => {
    setBusy('dismiss');
    fetch(`/api/knowledge/promotion-suggestions/${encodeURIComponent(suggestion.id)}/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: teamId }),
    }).catch(() => {}).finally(() => onDone());
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--eb-space-4)',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 640, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto',
        background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-4)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Sparkles size={18} style={{ color: 'var(--eb-status-warning)' }} />
          <h2 style={{ margin: 0, fontSize: 'var(--eb-text-lg)', color: 'var(--eb-text-primary)' }}>Promote to a skill</h2>
          <button onClick={onClose} style={{ ...btn(false), marginLeft: 'auto' }}><X size={14} /></button>
        </div>

        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          {suggestion.convergenceCount}× independent · {(suggestion.convergence || []).join(', ')}
        </div>
        <div style={{
          fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', background: 'var(--eb-bg-app)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
        }}>
          {suggestion.text}
        </div>

        <label style={lbl}>Skill name</label>
        <input value={name} onChange={e => setName(e.target.value)} style={inp} />

        <label style={lbl}>Target tier</label>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <Chip active={tier === 'team'} onClick={() => setTier('team')}>Team skill</Chip>
          <Chip active={tier === 'global'} onClick={() => setTier('global')}>Global skill</Chip>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <label style={lbl}>SKILL.md</label>
          <button onClick={draftWithAI} disabled={!!busy} style={{ ...btn(false), marginLeft: 'auto' }}>
            <Wand2 size={13} /> {busy === 'draft' ? 'Drafting…' : 'Draft with AI'}
          </button>
        </div>
        <textarea value={skillMd} onChange={e => setSkillMd(e.target.value)} rows={12}
          style={{ ...inp, fontFamily: 'var(--eb-font-mono, monospace)', fontSize: 'var(--eb-text-xs)', resize: 'vertical' }} />

        {error && <div style={{ color: 'var(--eb-status-danger)', fontSize: 'var(--eb-text-xs)' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end' }}>
          <button onClick={dismiss} disabled={!!busy} style={btn(false)}>Dismiss</button>
          <button onClick={promote} disabled={!!busy || !name.trim() || !skillMd.trim()} style={primaryBtn}>
            <Check size={14} /> {busy === 'promote' ? 'Promoting…' : `Promote to ${tier}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const lbl = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' };
const inp = {
  width: '100%', boxSizing: 'border-box', padding: 'var(--eb-space-2)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)',
};

/* ── Canvas (lightweight purpose-built SVG) ─────────────────────────────────── */

function Canvas({ graph, layout, pulseId, selectedId, onSelectItem, onSelectAgent, onReviewPending }) {
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
            fill="none" stroke={stroke} strokeOpacity={e.pending ? 0.55 : (e.origin || thick ? 0.75 : 0.4)}
            strokeWidth={thick ? 2.5 : 1.4}
            strokeDasharray={e.pending ? '2 4' : (e.kind === 'promoted' ? '4 3' : undefined)} />
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
        if (n.kind === 'pending') {
          return <PendingCard key={n.id} node={n} x={x} y={y} w={p.w} h={p.h}
            onClick={() => onReviewPending && onReviewPending(n)} />;
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, opacity: node.archived ? 0.5 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
            <span style={{ width: 7, height: 7, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[node.entryKind] || 'var(--eb-accent-primary)', flexShrink: 0 }} />
            <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--eb-text-muted)' }}>{node.entryKind}</span>
            {node.archived && (
              <span style={{ marginLeft: node.converged ? 0 : 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', border: '1px solid var(--eb-border-default)', padding: '0 5px', borderRadius: 'var(--eb-radius-full)' }}>archived</span>
            )}
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
  const auto = node.promotedBy === 'curator';
  return (
    <g>
      {foreign(x, y, w, h, (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <GitBranch size={13} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.label}</div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{node.tier} skill</div>
          </div>
          {auto && (
            <span title="Auto-promoted by the curator" style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: 'var(--eb-status-warning)', border: '1px solid var(--eb-status-warning)', borderRadius: 4, padding: '1px 4px' }}>auto</span>
          )}
        </div>
      ), { background: 'var(--eb-bg-elevated)' })}
    </g>
  );
}

// A ghost "skill-to-be" node for an open promotion candidate the operator still
// has to approve (a review-gated / deferred auto-promotion, or a level-2
// suggestion). Clicking opens the review dialog. Dashed border + amber to read as
// "needs review", distinct from a written skill.
function PendingCard({ node, x, y, w, h, onClick }) {
  return (
    <g style={{ cursor: 'pointer' }} onClick={onClick}>
      {foreign(x, y, w, h, (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Sparkles size={13} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.label}</div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)' }}>needs review</div>
          </div>
        </div>
      ), { background: 'var(--eb-bg-surface)', border: '1px dashed var(--eb-status-warning)' })}
    </g>
  );
}

// Autonomy level + per-transition promotion gates (Phase 4). The operator's one
// switch: flip a promotion arrow between "automatic" and "needs review".
function GatePanel({ data, onSet }) {
  const gates = (data && data.gates) || {};
  const autonomy = data ? data.autonomy : 1;
  const LABELS = {
    'team>team': 'KB → team skill',
    'team>global': 'team → global',
    'agent>team': 'agent → team',
  };
  const row = (transition) => {
    const mode = gates[transition] || 'review';
    const locked = transition === 'team>global'; // always review by construction
    return (
      <div key={transition} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
        <span style={{ flex: 1, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{LABELS[transition]}</span>
        {locked ? (
          <span style={{ fontSize: 10, color: 'var(--eb-text-muted)' }}>review (locked)</span>
        ) : (
          <button
            onClick={() => onSet(transition, mode === 'auto' ? 'review' : 'auto')}
            title="Toggle automatic / needs review"
            style={{
              fontSize: 10, fontWeight: 600, cursor: 'pointer', borderRadius: 4, padding: '2px 6px',
              border: `1px solid ${mode === 'auto' ? 'var(--eb-status-success)' : 'var(--eb-status-warning)'}`,
              color: mode === 'auto' ? 'var(--eb-status-success)' : 'var(--eb-status-warning)',
              background: 'transparent',
            }}>
            {mode === 'auto' ? 'automatic' : 'needs review'}
          </button>
        )}
      </div>
    );
  };
  return (
    <div style={{ padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Sparkles size={14} style={{ color: 'var(--eb-accent-primary)' }} />
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>Promotion gates</span>
        <span style={{ fontSize: 10, color: 'var(--eb-text-muted)', marginLeft: 'auto' }}>autonomy {autonomy}</span>
      </div>
      {autonomy < 3 && (
        <div style={{ fontSize: 10, color: 'var(--eb-text-muted)', marginBottom: 4 }}>
          Auto-promotion runs at autonomy 3. Gates below take effect there.
        </div>
      )}
      {['team>team', 'agent>team', 'team>global'].map(row)}
    </div>
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

function Provenance({ detail, onClose, onOpenAgent, onArchive }) {
  const { entry, links } = detail;
  const archived = entry.status === 'archived';
  const promoted = entry.status === 'promoted';
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
          {entry.teamId} · {entry.createdAt}{entry.status && entry.status !== 'active' ? ` · ${entry.status}` : ''}
        </div>
      </div>
      {onArchive && (
        <div style={{ borderTop: '1px solid var(--eb-border-default)', padding: 'var(--eb-space-3)' }}>
          <button
            onClick={() => onArchive(entry.id, entry.teamId, !archived)}
            disabled={promoted}
            title={promoted ? 'A promoted entry backs a skill and cannot be archived' : (archived ? 'Restore to the active KB' : 'Retire this entry from the active KB (non-destructive; kept in git)')}
            style={{ ...btn(false), width: '100%', justifyContent: 'center', opacity: promoted ? 0.5 : 1, cursor: promoted ? 'not-allowed' : 'pointer' }}>
            {archived ? 'Unarchive entry' : 'Archive entry'}
          </button>
        </div>
      )}
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

const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '4px var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-accent-primary)', background: 'var(--eb-accent-primary)',
  color: 'var(--eb-text-on-accent, #fff)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
