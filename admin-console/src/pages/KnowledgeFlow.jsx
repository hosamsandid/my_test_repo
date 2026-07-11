import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Brain, RefreshCw, X, ExternalLink, GitBranch, Sparkles, Check, Wand2,
  Archive, Share2, ShieldCheck, Ban, MessageSquare, Search, ArrowRight, Users,
} from 'lucide-react';
import KnowledgeFeed from '../components/KnowledgeFeed';

/*
 * Knowledge Flow — content-first redesign.
 *
 * One page, zero scope gymnastics: EVERY team is a section, immediately showing
 * what its agents learned (the aggregated team knowledge), who learned it, and
 * what got promoted — laid out as the actual flow, left to right:
 *
 *   Agents (learn)  →  Team knowledge (converges)  →  Skills (promoted)
 *
 * The learning controls (autonomy dial / supervised review / promotion gates)
 * sit ON the team section they govern and give explicit success/error feedback —
 * a failed write surfaces its server error instead of silently doing nothing.
 * Filters refine in place; they never hide the structure. The right rail keeps
 * the global live feed, or the provenance drill-down of a selected fact.
 */

const KIND_COLORS = {
  fact: 'var(--eb-status-info)',
  entity: 'var(--eb-accent-primary)',
  convention: 'var(--eb-status-warning)',
};

const AUTONOMY_LEVELS = [
  { level: 0, label: 'Off', desc: 'Private memory only — nothing is shared between agents.' },
  { level: 1, label: 'Share', desc: 'Agents pool durable lessons into the shared team KB. No promotion.' },
  { level: 2, label: 'Suggest', desc: 'Converged facts raise promotion cards; you confirm each.' },
  { level: 3, label: 'Auto-curate', desc: 'Converged facts auto-promote to team skills within the gates.' },
];

// The knowledge team ("squad") an agent belongs to — mirrors the backend's
// agentKnowledgeTeam: member → its parent team, team agent → itself,
// standalone agent → the default bucket.
function knowledgeTeamOf(a) {
  if (a.parentTeamId) return a.parentTeamId;
  if (a.role === 'team') return a.id;
  return a.teamId || 'default';
}

function fmtWhen(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `today ${hm}` : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${hm}`;
}

export default function KnowledgeFlow() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  // teams: [{ id, displayName, members: [{id, displayName, role}] }]
  const [teams, setTeams] = useState(null);
  // data: teamId -> { graph, gates, suggestions, reviewQueue, privateSkills }
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ q: '', kind: 'all', convergedOnly: false, today: false, showArchived: false });
  const [selected, setSelected] = useState(null); // { id, teamId }
  const [detail, setDetail] = useState(null);
  const [pulseId, setPulseId] = useState(null);
  const [promoting, setPromoting] = useState(null); // { suggestion, teamId }
  const [sharing, setSharing] = useState(null); // { node, teamId }

  const sectionRefs = useRef({});

  const loadTeams = useCallback(() => {
    return fetch('/api/matrix/agents')
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        const arr = Array.isArray(list) ? list : [];
        const byTeam = new Map();
        for (const a of arr) {
          const t = knowledgeTeamOf(a);
          if (!byTeam.has(t)) byTeam.set(t, { id: t, displayName: t, members: [] });
          if (a.role === 'team') byTeam.get(t).displayName = a.displayName || t;
          else byTeam.get(t).members.push({ id: a.id, displayName: a.displayName || a.id, role: a.role });
        }
        const out = [...byTeam.values()].sort((x, y) => x.id.localeCompare(y.id));
        setTeams(out);
        return out;
      })
      .catch(() => { setTeams([]); return []; });
  }, []);

  const loadTeamData = useCallback((teamId, members, { withPrivate = true } = {}) => {
    const enc = encodeURIComponent(teamId);
    const q = filters.showArchived ? '&includeArchived=1' : '';
    const gets = [
      fetch(`/api/knowledge/graph?scope=team:${enc}${q}`).then(r => (r.ok ? r.json() : null)),
      fetch(`/api/knowledge/gates?team=${enc}`).then(r => (r.ok ? r.json() : null)),
      fetch(`/api/knowledge/promotion-suggestions?team=${enc}`).then(r => (r.ok ? r.json() : null)),
      fetch(`/api/knowledge/review-queue?team=${enc}`).then(r => (r.ok ? r.json() : null)),
    ];
    return Promise.all(gets).then(async ([graph, gates, sugg, review]) => {
      let privateSkills = [];
      if (withPrivate && Array.isArray(members)) {
        const lists = await Promise.all(members.map(m =>
          fetch(`/api/agents/${encodeURIComponent(m.id)}/private-skills`)
            .then(r => (r.ok ? r.json() : null)).catch(() => null)));
        privateSkills = lists.flatMap((d, i) => (Array.isArray(d?.skills)
          ? d.skills.map(s => ({ ...s, agentId: members[i].id })) : []));
      }
      setData(prev => ({
        ...prev,
        [teamId]: {
          graph,
          gates,
          suggestions: Array.isArray(sugg?.suggestions) ? sugg.suggestions.filter(s => s.status === 'open' || !s.status) : [],
          reviewQueue: Array.isArray(review?.items) ? review.items : [],
          privateSkills: withPrivate ? privateSkills : (prev[teamId]?.privateSkills || []),
        },
      }));
    }).catch(() => {});
  }, [filters.showArchived]);

  const loadAll = useCallback(() => {
    setLoading(true);
    loadTeams()
      .then(list => Promise.all(list.map(t => loadTeamData(t.id, t.members))))
      .finally(() => setLoading(false));
  }, [loadTeams, loadTeamData]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Deep link: /knowledge?team=<id> (also accepts the legacy ?scope=team:<id>).
  useEffect(() => {
    const scope = params.get('scope') || '';
    const want = params.get('team') || (scope.startsWith('team:') ? scope.slice(5) : null);
    if (want && teams && sectionRefs.current[want]) {
      sectionRefs.current[want].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [teams, params]);

  // Live feed → pulse the matching card + refresh that team's slice.
  const reloadTimers = useRef({});
  const scheduleTeamReload = useCallback((teamId) => {
    if (!teamId) return;
    clearTimeout(reloadTimers.current[teamId]);
    reloadTimers.current[teamId] = setTimeout(() => {
      const t = (teams || []).find(x => x.id === teamId);
      loadTeamData(teamId, t ? t.members : [], { withPrivate: false });
    }, 400);
  }, [teams, loadTeamData]);

  const onFeedEvent = useCallback((ev) => {
    if (!ev || !ev.teamId) return;
    if (ev.type === 'harvest' && ev.entry?.id) {
      setPulseId(ev.entry.id);
      setTimeout(() => setPulseId(p => (p === ev.entry.id ? null : p)), 1000);
    }
    scheduleTeamReload(ev.teamId);
  }, [scheduleTeamReload]);

  const openItem = useCallback((id, teamId) => {
    setSelected({ id, teamId });
    setDetail(null);
    fetch(`/api/knowledge/item/${encodeURIComponent(id)}?teamId=${encodeURIComponent(teamId)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setDetail(d))
      .catch(() => {});
  }, []);

  const archiveItem = useCallback((id, teamId, archived) => {
    return fetch(`/api/knowledge/item/${encodeURIComponent(id)}/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, archived }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(() => {
        setSelected(null); setDetail(null);
        const t = (teams || []).find(x => x.id === teamId);
        return loadTeamData(teamId, t ? t.members : [], { withPrivate: false });
      })
      .catch(() => {});
  }, [teams, loadTeamData]);

  // Aggregate header counts over every team graph.
  const totals = useMemo(() => {
    const t = { items: 0, today: 0, converged: 0, skills: 0, agents: 0 };
    for (const d of Object.values(data)) {
      const c = d.graph?.counts;
      if (!c) continue;
      t.items += c.items || 0; t.today += c.today || 0; t.converged += c.converged || 0;
      t.skills += c.skills || 0; t.agents += c.agents || 0;
    }
    return t;
  }, [data]);

  const orderedTeams = useMemo(() => {
    if (!teams) return [];
    return [...teams].sort((a, b) => {
      const ia = data[a.id]?.graph?.counts?.items || 0;
      const ib = data[b.id]?.graph?.counts?.items || 0;
      return ib - ia || a.id.localeCompare(b.id);
    });
  }, [teams, data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-4) var(--eb-space-4) var(--eb-space-2)', flexWrap: 'wrap' }}>
        <Brain size={20} style={{ color: 'var(--eb-accent-primary)' }} />
        <h1 style={{ margin: 0, fontSize: 'var(--eb-text-xl)', fontFamily: 'var(--eb-font-display)', color: 'var(--eb-text-primary)' }}>
          Knowledge Flow
        </h1>
        <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
          {totals.items} learned{totals.today ? <span style={{ color: 'var(--eb-status-success)' }}> (+{totals.today} today)</span> : null} · {totals.converged} converged · {totals.skills} skills
        </span>
        <FlowLegend />
        <button onClick={loadAll} title="Refresh" style={{ ...btn, marginLeft: 'auto' }}>
          <RefreshCw size={14} className={loading ? 'kf-spin' : undefined} /> Refresh
        </button>
      </div>

      {/* ── Filter bar (refines in place — never a precondition to see data) ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: '0 var(--eb-space-4) var(--eb-space-3)', flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: '3px var(--eb-space-2)', background: 'var(--eb-bg-surface)' }}>
          <Search size={13} style={{ color: 'var(--eb-text-muted)' }} />
          <input
            value={filters.q}
            onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
            placeholder="Search learned facts…"
            style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', width: 220 }}
          />
          {filters.q && (
            <X size={12} style={{ cursor: 'pointer', color: 'var(--eb-text-muted)' }} onClick={() => setFilters(f => ({ ...f, q: '' }))} />
          )}
        </div>
        {[['all', 'All kinds'], ['fact', 'Facts'], ['entity', 'Entities'], ['convention', 'Conventions']].map(([k, label]) => (
          <Chip key={k} active={filters.kind === k} onClick={() => setFilters(f => ({ ...f, kind: k }))}>
            {label}
          </Chip>
        ))}
        <div style={{ width: 1, height: 20, background: 'var(--eb-border-default)' }} />
        <Chip active={filters.convergedOnly} onClick={() => setFilters(f => ({ ...f, convergedOnly: !f.convergedOnly }))}>Converged only</Chip>
        <Chip active={filters.today} onClick={() => setFilters(f => ({ ...f, today: !f.today }))}>Today</Chip>
        <Chip active={filters.showArchived} onClick={() => setFilters(f => ({ ...f, showArchived: !f.showArchived }))}>Show archived</Chip>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, borderTop: '1px solid var(--eb-border-default)' }}>
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--eb-bg-app)', padding: 'var(--eb-space-4)' }}>
          {teams === null ? (
            <div style={{ color: 'var(--eb-text-muted)' }}>Loading…</div>
          ) : orderedTeams.length === 0 ? (
            <div style={{ color: 'var(--eb-text-muted)' }}>No agents yet — create a team and its agents will start learning.</div>
          ) : (
            orderedTeams.map(t => (
              <TeamSection
                key={t.id}
                ref={el => { sectionRefs.current[t.id] = el; }}
                team={t}
                data={data[t.id]}
                filters={filters}
                pulseId={pulseId}
                selectedId={selected?.teamId === t.id ? selected.id : null}
                onOpenItem={openItem}
                onRetireItem={(item) => {
                  if (window.confirm(`Retire this learning from the shared KB?\n\n“${item.text}”\n\nIt stays in git for audit and can be un-retired.`)) {
                    archiveItem(item.id, t.id, true);
                  }
                }}
                onUnarchiveItem={(item) => archiveItem(item.id, t.id, false)}
                onOpenChat={(agentId) => navigate(`/chats/${encodeURIComponent(agentId)}`)}
                onReviewSuggestion={(s) => setPromoting({ suggestion: s, teamId: t.id })}
                onShareSkill={(node) => setSharing({ node, teamId: t.id })}
                onControlsChanged={() => loadTeamData(t.id, t.members, { withPrivate: false })}
                onLifted={() => loadTeamData(t.id, t.members)}
              />
            ))
          )}
        </div>

        {/* Right rail: provenance of the selected fact, else the live feed. */}
        <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--eb-border-default)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--eb-bg-surface)' }}>
          {selected && detail ? (
            <Provenance
              detail={detail}
              onClose={() => { setSelected(null); setDetail(null); }}
              onOpenAgent={(id) => navigate(`/chats/${encodeURIComponent(id)}`)}
              onArchive={(id, teamId, archived) => archiveItem(id, teamId ?? selected.teamId, archived)}
            />
          ) : (
            <KnowledgeFeed scope="global" onEvent={onFeedEvent} />
          )}
        </div>
      </div>

      {promoting && (
        <PromotionDialog
          suggestion={promoting.suggestion}
          teamId={promoting.teamId}
          onClose={() => setPromoting(null)}
          onDone={() => {
            const teamId = promoting.teamId;
            setPromoting(null);
            const t = (teams || []).find(x => x.id === teamId);
            loadTeamData(teamId, t ? t.members : [], { withPrivate: false });
          }}
        />
      )}
      {sharing && (
        <ShareDialog
          node={sharing.node}
          teams={(teams || []).map(t => t.id)}
          onClose={() => setSharing(null)}
          onDone={() => { setSharing(null); loadAll(); }}
        />
      )}
    </div>
  );
}

/* ── The flow legend in the header ──────────────────────────────────────────── */

function FlowLegend() {
  const step = (label) => (
    <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{label}</span>
  );
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'var(--eb-space-2)', padding: '2px var(--eb-space-2)', border: '1px dashed var(--eb-border-default)', borderRadius: 'var(--eb-radius-full)' }}>
      {step('Agents learn')}
      <ArrowRight size={11} style={{ color: 'var(--eb-text-muted)' }} />
      {step('Team knowledge converges')}
      <ArrowRight size={11} style={{ color: 'var(--eb-text-muted)' }} />
      {step('Skills promoted')}
    </span>
  );
}

/* ── One team = one section showing its whole flow ──────────────────────────── */

const TeamSection = React.forwardRef(function TeamSection({
  team, data, filters, pulseId, selectedId,
  onOpenItem, onRetireItem, onUnarchiveItem, onOpenChat,
  onReviewSuggestion, onShareSkill, onControlsChanged, onLifted,
}, ref) {
  const [agentFilter, setAgentFilter] = useState(null); // agentId | null
  const [hoverConv, setHoverConv] = useState(null); // Set<agentId> | null

  const graph = data?.graph;
  const counts = graph?.counts || { items: 0, today: 0, converged: 0, skills: 0 };
  const gates = data?.gates || null;
  const autonomy = gates ? gates.autonomy : 1;

  const agents = useMemo(() => {
    const fromGraph = new Map((graph?.nodes || [])
      .filter(n => n.kind === 'agent')
      .map(n => [n.agentId, n]));
    // Every member appears — even before it contributed anything.
    return team.members.map(m => ({
      id: m.id,
      displayName: m.displayName,
      counts: fromGraph.get(m.id)?.counts || { items: 0, today: 0 },
    }));
  }, [graph, team.members]);

  const items = useMemo(() => {
    const list = (graph?.nodes || []).filter(n => n.kind === 'item');
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    const q = filters.q.trim().toLowerCase();
    return list
      .map(n => ({ ...n, id: n.id.slice(5) })) // strip "item:" prefix
      .filter(n => {
        if (filters.kind !== 'all' && n.entryKind !== filters.kind) return false;
        if (filters.convergedOnly && !n.converged) return false;
        if (filters.today) {
          const t = n.createdAt ? Date.parse(n.createdAt) : NaN;
          if (Number.isNaN(t) || now - t >= DAY) return false;
        }
        if (q && !(n.text || '').toLowerCase().includes(q)) return false;
        if (agentFilter && !(n.convergence || []).includes(agentFilter)) return false;
        return true;
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [graph, filters, agentFilter]);

  const skills = useMemo(() => (graph?.nodes || []).filter(n => n.kind === 'skill'), [graph]);
  const pending = useMemo(() => (graph?.nodes || []).filter(n => n.kind === 'pending'), [graph]);
  const suggestions = data?.suggestions || [];
  const reviewQueue = data?.reviewQueue || [];
  const privateSkills = data?.privateSkills || [];
  const warnings = graph?.warnings || [];

  return (
    <section ref={ref} style={{
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)',
      background: 'var(--eb-bg-surface)', marginBottom: 'var(--eb-space-4)', overflow: 'hidden',
    }}>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', flexWrap: 'wrap' }}>
        <Users size={15} style={{ color: 'var(--eb-accent-primary)', alignSelf: 'center' }} />
        <span style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
          {team.displayName}
        </span>
        {team.displayName !== team.id && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{team.id}</span>
        )}
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {agents.length} agents · {counts.items} learned{counts.today ? <span style={{ color: 'var(--eb-status-success)' }}> (+{counts.today} today)</span> : null} · {counts.converged} converged · {skills.length} skills
        </span>
        {warnings.length > 0 && (
          <span title={warnings.join('\n')} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)' }}>
            KB not synced yet — reading agents’ local lessons
          </span>
        )}
      </div>

      {/* Learning controls — visible, on the team they govern, with feedback */}
      {gates && <ControlStrip teamId={team.id} gates={gates} onChanged={onControlsChanged} />}

      {/* The flow: three columns joined by arrows */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) 20px minmax(0, 1fr) 20px minmax(200px, 260px)', gap: 0, padding: 'var(--eb-space-3) var(--eb-space-4) var(--eb-space-4)' }}>
        {/* Agents */}
        <div>
          <ColHeader label="Agents" hint="record lessons" />
          {agents.map(a => (
            <AgentRow
              key={a.id}
              agent={a}
              active={agentFilter === a.id}
              highlighted={hoverConv ? hoverConv.has(a.id) : false}
              onToggle={() => setAgentFilter(f => (f === a.id ? null : a.id))}
              onOpenChat={() => onOpenChat(a.id)}
            />
          ))}
        </div>

        <FlowArrow />

        {/* Team knowledge */}
        <div style={{ minWidth: 0 }}>
          <ColHeader label="Team knowledge" hint="shared facts, entities & conventions" trailing={agentFilter && (
            <Chip active onClick={() => setAgentFilter(null)}>only {agentFilter} ✕</Chip>
          )} />
          {reviewQueue.length > 0 && (
            <ReviewQueueBlock teamId={team.id} items={reviewQueue} onChanged={onControlsChanged} />
          )}
          {items.length === 0 ? (
            <EmptyKnowledge autonomy={autonomy} counts={counts} filtered={!!(filters.q || filters.kind !== 'all' || filters.convergedOnly || filters.today || agentFilter)} />
          ) : (
            items.map(n => (
              <ItemCard
                key={n.id}
                item={n}
                pulsing={pulseId === n.id}
                selected={selectedId === n.id}
                onClick={() => onOpenItem(n.id, team.id)}
                onHover={(on) => setHoverConv(on ? new Set(n.convergence || []) : null)}
                onRetire={() => onRetireItem(n)}
                onUnarchive={() => onUnarchiveItem(n)}
              />
            ))
          )}
        </div>

        <FlowArrow />

        {/* Skills */}
        <div>
          <ColHeader label="Skills" hint="promoted, reusable" />
          {suggestions.map(s => (
            <SuggestionCard key={s.id} suggestion={s} onReview={() => onReviewSuggestion(s)} />
          ))}
          {pending.map(p => {
            const s = suggestions.find(x => x.id === p.suggestionId);
            return s ? null : (
              <div key={p.id} style={amberCard}>
                <Sparkles size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)' }}>{p.label}</span>
                <span style={{ fontSize: 10, color: 'var(--eb-status-warning)', marginLeft: 'auto' }}>needs review</span>
              </div>
            );
          })}
          {skills.length === 0 && suggestions.length === 0 && pending.length === 0 && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2) 0' }}>
              No skills yet. {autonomy >= 2 ? 'Converged facts will raise promotion cards here.' : 'At autonomy 2+, converged facts raise promotion cards here.'}
            </div>
          )}
          {skills.map(sk => (
            <SkillCard key={sk.id} skill={sk} onShare={() => onShareSkill(sk)} />
          ))}
          {privateSkills.length > 0 && (
            <PrivateSkillsBlock teamId={team.id} skills={privateSkills} onLifted={onLifted} />
          )}
        </div>
      </div>
    </section>
  );
});

function ColHeader({ label, hint, trailing }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 'var(--eb-space-2)', minHeight: 24 }}>
      <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-secondary)' }}>{label}</span>
      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{hint}</span>
      {trailing}
    </div>
  );
}

function FlowArrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 26 }}>
      <ArrowRight size={14} style={{ color: 'var(--eb-border-strong, var(--eb-border-default))' }} />
    </div>
  );
}

function AgentRow({ agent, active, highlighted, onToggle, onOpenChat }) {
  return (
    <div
      onClick={onToggle}
      title={active ? 'Click to clear the filter' : `Show only what ${agent.displayName} learned`}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', marginBottom: 4,
        borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
        border: `1px solid ${active || highlighted ? 'var(--eb-accent-primary)' : 'transparent'}`,
        background: active || highlighted ? 'var(--eb-accent-muted)' : 'transparent',
        transition: 'background 120ms ease, border-color 120ms ease',
      }}>
      <span style={{ width: 7, height: 7, borderRadius: 'var(--eb-radius-full)', background: agent.counts.items > 0 ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)', flexShrink: 0 }} />
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
        {agent.displayName}
      </span>
      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>
        {agent.counts.items}{agent.counts.today ? <span style={{ color: 'var(--eb-status-success)' }}>+{agent.counts.today}</span> : ''}
      </span>
      <span
        title="Open chat"
        onClick={(e) => { e.stopPropagation(); onOpenChat(); }}
        style={{ display: 'inline-flex', flexShrink: 0, cursor: 'pointer', color: 'var(--eb-text-muted)' }}>
        <MessageSquare size={12} />
      </span>
    </div>
  );
}

function EmptyKnowledge({ autonomy, counts, filtered }) {
  let msg;
  if (filtered) msg = 'Nothing matches the current filters.';
  else if (autonomy === 0) msg = 'Learning is off for this team (autonomy 0). Set it to 1 · Share and the agents will pool the lessons they learn.';
  else if (counts.items === 0) msg = 'Nothing shared yet. Agents record durable lessons at the end of their sessions — they will appear here.';
  else msg = 'No entries.';
  return (
    <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-3) 0' }}>{msg}</div>
  );
}

function ItemCard({ item, pulsing, selected, onClick, onHover, onRetire, onUnarchive }) {
  const canRetire = !item.archived && item.status !== 'promoted';
  return (
    <div
      className={`kf-item${pulsing ? ' kf-node-pulse' : ''}`}
      onClick={onClick}
      onMouseEnter={() => onHover && onHover(true)}
      onMouseLeave={() => onHover && onHover(false)}
      style={{
        position: 'relative', border: `1px solid ${selected ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        boxShadow: selected ? '0 0 0 2px var(--eb-accent-muted)' : 'none',
        borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-app)',
        padding: 'var(--eb-space-2) var(--eb-space-3)', marginBottom: 'var(--eb-space-2)',
        cursor: 'pointer', opacity: item.archived ? 0.55 : 1,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ width: 7, height: 7, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[item.entryKind] || 'var(--eb-accent-primary)', flexShrink: 0 }} />
        <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--eb-text-muted)' }}>{item.entryKind}</span>
        {item.archived && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', border: '1px solid var(--eb-border-default)', padding: '0 5px', borderRadius: 'var(--eb-radius-full)' }}>archived</span>
        )}
        {item.converged && (
          <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-accent-primary)', background: 'var(--eb-accent-muted)', padding: '0 6px', borderRadius: 'var(--eb-radius-full)' }}>
            {item.convergenceCount}× independent
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>{fmtWhen(item.createdAt)}</span>
      </div>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.35, wordBreak: 'break-word' }}>
        {item.text}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          learned by <strong style={{ color: 'var(--eb-text-secondary)' }}>{item.provenance?.originAgent || (item.convergence || [])[0] || '—'}</strong>
          {item.convergenceCount > 1 ? ` + ${item.convergenceCount - 1} more` : ''}
        </span>
        {item.archived ? (
          <button onClick={(e) => { e.stopPropagation(); onUnarchive(); }} style={{ ...miniBtn, marginLeft: 'auto' }}>Un-retire</button>
        ) : canRetire && (
          <button
            className="kf-retire"
            title="Retire this learning from the shared KB (non-destructive; kept in git)"
            onClick={(e) => { e.stopPropagation(); onRetire(); }}
            style={{ ...miniBtn, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--eb-status-warning)', borderColor: 'var(--eb-status-warning)' }}>
            <Archive size={11} /> Retire
          </button>
        )}
      </div>
    </div>
  );
}

function SkillCard({ skill, onShare }) {
  const auto = skill.promotedBy === 'curator';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-elevated)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', marginBottom: 'var(--eb-space-2)',
    }}>
      <GitBranch size={13} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{skill.label}</div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{skill.tier} skill{auto ? ' · auto-promoted' : ''}</div>
      </div>
      <span
        title="Share this skill into another team"
        onClick={onShare}
        style={{ display: 'inline-flex', flexShrink: 0, cursor: 'pointer', color: 'var(--eb-text-muted)' }}>
        <Share2 size={13} />
      </span>
    </div>
  );
}

const amberCard = {
  display: 'flex', alignItems: 'center', gap: 8,
  border: '1px dashed var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
  background: 'var(--eb-bg-surface)', padding: 'var(--eb-space-2) var(--eb-space-3)',
  marginBottom: 'var(--eb-space-2)',
};

function SuggestionCard({ suggestion, onReview }) {
  return (
    <div style={{ ...amberCard, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Sparkles size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
        <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-warning)' }}>
          Promotion suggestion
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {suggestion.convergenceCount}×{suggestion.source === 'agent-nominated' ? ' · nominated' : ''}
        </span>
      </div>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', wordBreak: 'break-word' }}>{suggestion.text}</div>
      <button onClick={onReview} style={{ ...primaryBtn, alignSelf: 'flex-end' }}>Review & promote</button>
    </div>
  );
}

function PrivateSkillsBlock({ teamId, skills, onLifted }) {
  const [state, setState] = useState({}); // name -> 'lifting' | 'done' | 'exists' | 'error'
  const lift = (sk) => {
    setState(s => ({ ...s, [sk.name]: 'lifting' }));
    fetch('/api/knowledge/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'agent', to: 'team', teamId, agentId: sk.agentId, name: sk.name }),
    })
      .then(r => {
        if (r.status === 201) { setState(s => ({ ...s, [sk.name]: 'done' })); onLifted && onLifted(); return; }
        setState(s => ({ ...s, [sk.name]: r.status === 409 ? 'exists' : 'error' }));
      })
      .catch(() => setState(s => ({ ...s, [sk.name]: 'error' })));
  };
  return (
    <div style={{ marginTop: 'var(--eb-space-3)' }}>
      <ColHeader label="Private skills" hint="one agent only — lift to share" />
      {skills.map(sk => {
        const st = state[sk.name];
        return (
          <div key={`${sk.agentId}:${sk.name}`} style={{
            display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-app)',
            padding: 'var(--eb-space-2) var(--eb-space-3)', marginBottom: 'var(--eb-space-2)',
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sk.name}</div>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{sk.agentId}</div>
            </div>
            <button onClick={() => lift(sk)} disabled={st === 'lifting' || st === 'done'} style={miniBtn}>
              {st === 'lifting' ? 'Lifting…' : st === 'done' ? 'Lifted ✓' : st === 'exists' ? 'Name taken' : 'Lift to team'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ── Review queue (supervised review): approve before it enters the shared KB ── */

function ReviewQueueBlock({ teamId, items, onChanged }) {
  const [busy, setBusy] = useState({});
  const decide = (id, decision) => {
    setBusy(b => ({ ...b, [id]: true }));
    fetch(`/api/knowledge/item/${encodeURIComponent(id)}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, decision }),
    })
      .then(() => onChanged && onChanged())
      .catch(() => {})
      .finally(() => setBusy(b => ({ ...b, [id]: false })));
  };
  return (
    <div style={{ border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)', marginBottom: 'var(--eb-space-3)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px var(--eb-space-3)', borderBottom: '1px solid var(--eb-status-warning)' }}>
        <ShieldCheck size={13} style={{ color: 'var(--eb-status-warning)' }} />
        <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-warning)' }}>Awaiting your review</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{items.length}</span>
      </div>
      <div style={{ padding: 'var(--eb-space-2) var(--eb-space-3)' }}>
        {items.map(it => (
          <div key={it.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--eb-border-default)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ width: 6, height: 6, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[it.entryKind] || 'var(--eb-accent-primary)' }} />
              <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', color: 'var(--eb-text-muted)' }}>{it.entryKind}</span>
              <span style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{it.originAgent}</span>
            </div>
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', wordBreak: 'break-word' }}>{it.text}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4, justifyContent: 'flex-end' }}>
              <button disabled={busy[it.id]} onClick={() => decide(it.id, 'approved')} style={{ ...primaryBtn, padding: '2px 8px' }}>
                <Check size={11} /> Approve
              </button>
              <button disabled={busy[it.id]} onClick={() => decide(it.id, 'rejected')} style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Ban size={11} /> Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Learning controls: autonomy dial · review toggle · gates — with feedback ── */

function ControlStrip({ teamId, gates, onChanged }) {
  const [busy, setBusy] = useState(null); // which control is writing
  const [flash, setFlash] = useState(null); // { kind: 'ok' | 'error', text }
  const flashTimer = useRef(null);

  const feedback = (kind, text) => {
    setFlash({ kind, text });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), kind === 'error' ? 8000 : 3500);
  };

  const call = (label, url, body) => {
    setBusy(label);
    return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        feedback('ok', 'Saved. Running agents pick this up at their next rebuild.');
        onChanged && onChanged();
      })
      .catch(e => feedback('error', `Not saved: ${e.message}`))
      .finally(() => setBusy(null));
  };

  const autonomy = gates.autonomy;
  const review = !!gates.review;
  const g = gates.gates || {};
  const current = AUTONOMY_LEVELS.find(l => l.level === autonomy) || AUTONOMY_LEVELS[1];
  const GATE_LABELS = { 'team>team': 'KB → team skill', 'agent>team': 'agent → team', 'team>global': 'team → global' };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-2) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-app)', flexWrap: 'wrap' }}>
      <ShieldCheck size={13} style={{ color: 'var(--eb-accent-primary)' }} />
      <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-muted)' }}>Autonomy</span>
      <div style={{ display: 'inline-flex', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', overflow: 'hidden' }}>
        {AUTONOMY_LEVELS.map(({ level, label, desc }) => {
          const active = level === autonomy;
          return (
            <button
              key={level}
              disabled={busy === 'autonomy'}
              title={desc}
              onClick={() => !active && call('autonomy', '/api/knowledge/autonomy', { teamId, level })}
              style={{
                padding: '3px 10px', border: 'none', cursor: 'pointer', fontSize: 'var(--eb-text-xs)', fontWeight: 600,
                background: active ? 'var(--eb-accent-primary)' : 'transparent',
                color: active ? 'var(--eb-text-inverted, #fff)' : 'var(--eb-text-secondary)',
              }}>
              {level} {label}
            </button>
          );
        })}
      </div>
      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{current.desc}</span>

      <div style={{ width: 1, height: 18, background: 'var(--eb-border-default)' }} />

      <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-muted)' }}>Review</span>
      <button
        disabled={busy === 'review' || autonomy < 1}
        title="Hold newly-learned facts for your approval before they enter the shared KB"
        onClick={() => call('review', '/api/knowledge/review-mode', { teamId, enabled: !review })}
        style={{
          fontSize: 'var(--eb-text-xs)', fontWeight: 600, cursor: autonomy < 1 ? 'not-allowed' : 'pointer',
          borderRadius: 'var(--eb-radius-md)', padding: '3px 10px', opacity: autonomy < 1 ? 0.5 : 1,
          border: `1px solid ${review ? 'var(--eb-status-warning)' : 'var(--eb-border-default)'}`,
          color: review ? 'var(--eb-status-warning)' : 'var(--eb-text-muted)', background: 'transparent',
        }}>
        {review ? 'on — approve first' : 'off — auto-share'}
      </button>

      <div style={{ width: 1, height: 18, background: 'var(--eb-border-default)' }} />

      <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-muted)' }}
        title="Gates apply to auto-promotion (autonomy 3)">Gates</span>
      {['team>team', 'agent>team', 'team>global'].map(tr => {
        const mode = g[tr] || 'review';
        const locked = tr === 'team>global';
        return (
          <span key={tr} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{GATE_LABELS[tr]}</span>
            {locked ? (
              <span style={{ fontSize: 10, color: 'var(--eb-text-muted)' }}>review (locked)</span>
            ) : (
              <button
                disabled={busy === tr}
                onClick={() => call(tr, '/api/knowledge/gates', { teamId, transition: tr, mode: mode === 'auto' ? 'review' : 'auto' })}
                title="Toggle automatic / needs review (takes effect at autonomy 3)"
                style={{
                  fontSize: 10, fontWeight: 600, cursor: 'pointer', borderRadius: 4, padding: '1px 6px',
                  border: `1px solid ${mode === 'auto' ? 'var(--eb-status-success)' : 'var(--eb-status-warning)'}`,
                  color: mode === 'auto' ? 'var(--eb-status-success)' : 'var(--eb-status-warning)', background: 'transparent',
                }}>
                {mode === 'auto' ? 'automatic' : 'needs review'}
              </button>
            )}
          </span>
        );
      })}

      {gates.sharedWith && gates.sharedWith.length > 0 && (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}
          title={`These controls live on the shared environment '${gates.environment?.name || ''}' — changing them here also changes them for the listed team(s).`}>
          ⚠ shared with {gates.sharedWith.join(', ')}
        </span>
      )}

      {flash && (
        <span style={{
          marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', fontWeight: 600,
          color: flash.kind === 'ok' ? 'var(--eb-status-success)' : 'var(--eb-status-error, #d33)',
        }}>
          {flash.kind === 'ok' ? '✓ ' : '⚠ '}{flash.text}
        </span>
      )}
    </div>
  );
}

/* ── Provenance drill-down (right rail) ─────────────────────────────────────── */

function Provenance({ detail, onClose, onOpenAgent, onArchive }) {
  const { entry, links } = detail;
  const archived = entry.status === 'archived';
  const promoted = entry.status === 'promoted';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: 'var(--eb-space-3)', borderBottom: '1px solid var(--eb-border-default)' }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>Provenance</span>
        <button onClick={onClose} style={{ ...btn, marginLeft: 'auto', padding: 4 }}><X size={14} /></button>
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
            style={{ ...btn, width: '100%', justifyContent: 'center', opacity: promoted ? 0.5 : 1, cursor: promoted ? 'not-allowed' : 'pointer' }}>
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

/* ── Promotion dialog (unchanged mechanics: draft → confirm → promote) ────────── */

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
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={{ ...dialog, width: 640, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Sparkles size={18} style={{ color: 'var(--eb-status-warning)' }} />
          <h2 style={{ margin: 0, fontSize: 'var(--eb-text-lg)', color: 'var(--eb-text-primary)' }}>Promote to a skill</h2>
          <button onClick={onClose} style={{ ...btn, marginLeft: 'auto' }}><X size={14} /></button>
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
          <button onClick={draftWithAI} disabled={!!busy} style={{ ...btn, marginLeft: 'auto' }}>
            <Wand2 size={13} /> {busy === 'draft' ? 'Drafting…' : 'Draft with AI'}
          </button>
        </div>
        <textarea value={skillMd} onChange={e => setSkillMd(e.target.value)} rows={12}
          style={{ ...inp, fontFamily: 'var(--eb-font-mono, monospace)', fontSize: 'var(--eb-text-xs)', resize: 'vertical' }} />

        {error && <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-xs)' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end' }}>
          <button onClick={dismiss} disabled={!!busy} style={btn}>Dismiss</button>
          <button onClick={promote} disabled={!!busy || !name.trim() || !skillMd.trim()} style={primaryBtn}>
            <Check size={14} /> {busy === 'promote' ? 'Promoting…' : `Promote to ${tier}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Share dialog: route a skill sideways into another team ───────────────────── */

function ShareDialog({ node, teams, onClose, onDone }) {
  const name = node.label;
  const sourceIsTeam = node.tier === 'team';
  const sourceTeamId = sourceIsTeam ? (node.teamId || node.originTeamId || null) : null;
  const options = (Array.isArray(teams) ? teams : []).filter(t => t !== sourceTeamId);
  const [target, setTarget] = useState(options[0] || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const share = () => {
    setBusy(true); setErr('');
    fetch('/api/knowledge/share-to-team', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sourceIsTeam ? 'team' : 'global', name, sourceTeamId, targetTeamId: target }),
    })
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'share failed'); return d; })
      .then(() => onDone())
      .catch(e => { setErr(e.message); setBusy(false); });
  };

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...dialog, width: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--eb-space-3)' }}>
          <Share2 size={16} style={{ color: 'var(--eb-accent-primary)' }} />
          <span style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>Share skill to a team</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', ...btn, padding: 4 }}><X size={14} /></button>
        </div>
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-3)' }}>
          Copy <strong>{name}</strong> ({node.tier} skill) into another team’s pool. Provenance is preserved and the share is stamped.
        </div>
        <label style={lbl}>Target team</label>
        <select value={target} onChange={e => setTarget(e.target.value)} style={{ ...inp, marginTop: 4 }}>
          {options.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {err && <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-xs)', marginTop: 'var(--eb-space-2)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end', marginTop: 'var(--eb-space-3)' }}>
          <button onClick={onClose} disabled={busy} style={btn}>Cancel</button>
          <button onClick={share} disabled={busy || !target} style={primaryBtn}>
            <Share2 size={13} /> {busy ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────────────── */

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '3px var(--eb-space-3)', borderRadius: 'var(--eb-radius-full)', cursor: 'pointer',
      border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
      background: active ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
      color: active ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
      fontSize: 'var(--eb-text-xs)',
    }}>{children}</button>
  );
}

const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '4px var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
  color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};

const miniBtn = {
  fontSize: 'var(--eb-text-xs)', padding: '2px 8px', borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
  color: 'var(--eb-text-secondary)', cursor: 'pointer',
};

const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '4px var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
  border: '1px solid var(--eb-accent-primary)', background: 'var(--eb-accent-primary)',
  color: 'var(--eb-text-on-accent, #fff)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};

const lbl = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' };
const inp = {
  width: '100%', boxSizing: 'border-box', padding: 'var(--eb-space-2)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)',
};
const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--eb-space-4)',
};
const dialog = {
  maxWidth: '100%', maxHeight: '90vh', overflow: 'auto',
  background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-4)',
};
