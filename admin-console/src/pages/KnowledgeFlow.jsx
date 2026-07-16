import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Brain, RefreshCw, X, ExternalLink, GitBranch, Sparkles, Check, Wand2,
  Archive, Share2, ShieldCheck, Ban, MessageSquare, Search, ArrowRight, Users,
  HelpCircle, BookOpen, Combine, Trash2,
} from 'lucide-react';
import InfoTip from '../components/InfoTip';
import SidePanel from '../components/SidePanel';
import KnowledgeLearningSections, {
  AUTONOMY_LEVELS, GATE_ORDER, GATE_LABELS, GATE_TIPS, PanelSection,
} from '../components/KnowledgeLearningConfig';
import useSSE from '../hooks/useSSE';
import { parseTeamParam, resolveSelectedTeam, teamTotals, streamScopeUrl } from './knowledge-scope';

/*
 * Knowledge Flow — team-scoped (#560).
 *
 * Picking a team is a mandatory first step: the page opens on a "choose a team"
 * screen and loads NO team knowledge until one is selected. Once a team is
 * chosen it shows exactly that team's knowledge — the same content-first flow,
 * left to right, for the single team in view:
 *
 *   Agents (learn)  →  Team knowledge (converges)  →  Skills (promoted)
 *
 * Only the cheap team list is fetched on mount (to populate the selector); a
 * team's expensive knowledge slice (graph/gates/suggestions/review-queue +
 * per-member private-skills) is fetched only after selection, and switching
 * teams replaces the view. Header counts, the live SSE feed and Refresh are all
 * scoped to the selected team — there is no all-teams view.
 *
 * The learning controls (autonomy dial / supervised review / promotion gates)
 * sit ON the team section they govern and give explicit success/error feedback —
 * a failed write surfaces its server error instead of silently doing nothing.
 * Filters refine in place; they never hide the structure. The right rail keeps
 * the team's live feed, or the provenance drill-down of a selected fact.
 */

const KIND_COLORS = {
  fact: 'var(--eb-status-info)',
  entity: 'var(--eb-accent-primary)',
  convention: 'var(--eb-status-warning)',
};

// Plain-language explanations of the three knowledge kinds — used by the
// intro panel, the filter chips, and the item cards.
const KIND_EXPLAIN = {
  fact: 'Fact — something an agent found to be true about the project or its tools (e.g. “the build needs Node 22”).',
  entity: 'Entity — a named thing (a system, repo, service, person) and what the team knows about it.',
  convention: 'Convention — how the team does things (processes, labels, rituals — e.g. “PRs need the ready-for-review label”).',
};

// Shape an operator's multi-select into the candidate shape PromotionDialog
// renders — id: null marks it as ad-hoc (no stored suggestion; the server
// rebuilds provenance from the entry ids).
function manualSuggestionFrom(items) {
  const list = Array.isArray(items) ? items : [];
  const agents = [...new Set(list.flatMap(i => (i.convergence && i.convergence.length ? i.convergence : [i.provenance?.originAgent]).filter(Boolean)))].sort();
  return {
    id: null,
    source: 'manual',
    text: (list[0] && list[0].text) || '',
    entryIds: list.map(i => i.id),
    members: list.map(i => ({
      id: i.id,
      originAgent: i.provenance?.originAgent || (i.convergence || [])[0] || null,
      text: i.text,
      createdAt: i.createdAt,
    })),
    convergence: agents,
    convergenceCount: agents.length,
    lessonCount: list.length,
  };
}

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
  // The one team currently in view. null → the "choose a team" screen. Never
  // auto-selected: every fresh load starts empty (no last-team memory).
  const [selectedTeam, setSelectedTeam] = useState(null);
  // data: teamId -> { graph, gates, suggestions, reviewQueue, privateSkills }.
  // At most one team's slice is loaded/shown at a time.
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ q: '', kind: 'all', convergedOnly: false, today: false, showArchived: false });
  const [selected, setSelected] = useState(null); // { id, teamId }
  const [detail, setDetail] = useState(null);
  const [pulseId, setPulseId] = useState(null);
  const [promoting, setPromoting] = useState(null); // { suggestion, teamId }
  const [sharing, setSharing] = useState(null); // { node, teamId }
  // "How it works" intro: open on first visit, dismissible, reopenable anytime.
  const [showIntro, setShowIntro] = useState(() => {
    try { return localStorage.getItem('kf.introSeen') !== '1'; } catch { return true; }
  });
  const dismissIntro = useCallback(() => {
    setShowIntro(false);
    try { localStorage.setItem('kf.introSeen', '1'); } catch { /* ignore */ }
  }, []);
  // Two ways to look at the same team knowledge: the left-to-right flow graph
  // (default) and the human-readable overview table (#635). The choice persists
  // across visits; both honour the same filter bar.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('kf.view') === 'table' ? 'table' : 'flow'; } catch { return 'flow'; }
  });
  const chooseView = useCallback((v) => {
    setView(v);
    try { localStorage.setItem('kf.view', v); } catch { /* ignore */ }
  }, []);

  // Mirrors selectedTeam for async guards: a slow in-flight response for a team
  // that is no longer selected must not flip the shared loading spinner or its
  // dialogs. Team data itself is keyed by teamId, so a stale response only ever
  // fills its own (unshown) slice — never the team currently in view.
  const activeTeamRef = useRef(null);
  useEffect(() => { activeTeamRef.current = selectedTeam; }, [selectedTeam]);
  // The deep link is applied once, on the first team-list load only — after
  // that the selector drives selection (no forced re-select on refresh).
  const deepLinkAppliedRef = useRef(false);

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

  // Load a single team's slice, guarding against out-of-order responses when
  // the user switches teams quickly.
  const loadSelectedTeam = useCallback((teamId, { withPrivate = true } = {}) => {
    if (!teamId) return Promise.resolve();
    const t = (teams || []).find(x => x.id === teamId);
    if (!t) return Promise.resolve();
    setLoading(true);
    return loadTeamData(teamId, t.members, { withPrivate }).finally(() => {
      // Only clear the spinner if this is still the team in view.
      if (activeTeamRef.current === teamId) setLoading(false);
    });
  }, [teams, loadTeamData]);

  // On mount fetch ONLY the cheap team list — no team knowledge is loaded
  // until a team is selected (AC1).
  useEffect(() => { loadTeams(); }, [loadTeams]);

  // Deep link: /knowledge?team=<id> (also accepts the legacy ?scope=team:<id>).
  // Applied once, when the team list first arrives; an unknown/absent id leaves
  // the empty selection screen in place (AC8).
  useEffect(() => {
    if (!teams || deepLinkAppliedRef.current) return;
    deepLinkAppliedRef.current = true;
    const want = resolveSelectedTeam(parseTeamParam(params), teams);
    if (want) setSelectedTeam(want);
  }, [teams, params]);

  // Reset any per-team UI (provenance rail / dialogs) opened for a team we're
  // leaving behind.
  const resetTeamUi = useCallback(() => {
    setSelected(null); setDetail(null); setPromoting(null); setSharing(null);
  }, []);

  // A team selected but no longer present (deleted/renamed between loads) →
  // fall back to the empty selection screen instead of erroring (AC/edge case).
  useEffect(() => {
    if (selectedTeam && teams && !teams.some(t => t.id === selectedTeam)) {
      setSelectedTeam(null);
      resetTeamUi();
    }
  }, [teams, selectedTeam, resetTeamUi]);

  // Selecting a team loads its (and only its) knowledge; switching resets any
  // provenance rail / dialogs opened for the previous team.
  const onSelectTeam = useCallback((teamId) => {
    const next = teamId || null;
    setSelectedTeam(prev => (prev === next ? prev : next));
    resetTeamUi();
  }, [resetTeamUi]);

  useEffect(() => {
    if (selectedTeam) loadSelectedTeam(selectedTeam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeam, loadSelectedTeam]);

  // Live feed → pulse the matching card + refresh the selected team's slice.
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
    // The stream is already scoped to the selected team, but ignore anything
    // that isn't the team currently in view as belt-and-braces.
    if (ev.teamId !== selectedTeam) return;
    if (ev.type === 'harvest' && ev.entry?.id) {
      setPulseId(ev.entry.id);
      setTimeout(() => setPulseId(p => (p === ev.entry.id ? null : p)), 1000);
    }
    scheduleTeamReload(ev.teamId);
  }, [scheduleTeamReload, selectedTeam]);

  // SSE scoped to the selected team; no connection until a team is chosen (AC6).
  useSSE(streamScopeUrl(selectedTeam), { onEvent: onFeedEvent });

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

  // Bulk retire / un-retire for the overview table. Each id is flipped
  // independently (already-in-target-state ids are filtered out by the caller,
  // so this never errors on a no-op), then the team slice is reloaded once.
  const bulkArchive = useCallback((ids, teamId, archived) => {
    const list = [...new Set(Array.isArray(ids) ? ids : [])];
    if (list.length === 0) return Promise.resolve();
    return Promise.all(list.map(id =>
      fetch(`/api/knowledge/item/${encodeURIComponent(id)}/archive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, archived }),
      }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    )).then(() => {
      setSelected(null); setDetail(null);
      const t = (teams || []).find(x => x.id === teamId);
      return loadTeamData(teamId, t ? t.members : [], { withPrivate: false });
    });
  }, [teams, loadTeamData]);

  // Generate-and-store the human-readable summaries (#635, AC3). Runs on demand
  // when the overview table is opened for a team — drains in batches (the API
  // caps each request) and reloads once if any summary was freshly persisted.
  // A team is backfilled at most once per session; unchanged entries never
  // trigger a new LLM call on subsequent opens.
  const backfilledRef = useRef(new Set());
  const runBackfill = useCallback(async (teamId) => {
    if (!teamId || backfilledRef.current.has(teamId)) return;
    backfilledRef.current.add(teamId);
    let reloadNeeded = false;
    for (let i = 0; i < 25; i++) {
      let d = null;
      try {
        const r = await fetch('/api/knowledge/summaries/backfill', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamId }),
        });
        d = r.ok ? await r.json() : null;
      } catch { d = null; }
      if (!d) break;
      if (d.generated > 0) reloadNeeded = true;
      // No LLM target (heuristic only) or nothing left / no progress → stop.
      if (d.source !== 'llm' || !d.remaining || d.remaining <= 0 || d.generated <= 0) break;
    }
    if (reloadNeeded && activeTeamRef.current === teamId) {
      const t = (teams || []).find(x => x.id === teamId);
      loadTeamData(teamId, t ? t.members : [], { withPrivate: false });
    }
  }, [teams, loadTeamData]);

  useEffect(() => {
    if (view === 'table' && selectedTeam) runBackfill(selectedTeam);
  }, [view, selectedTeam, runBackfill]);

  // Header counts scoped to the selected team only — never a cross-team sum.
  const totals = useMemo(
    () => teamTotals(selectedTeam ? data[selectedTeam] : null),
    [data, selectedTeam],
  );

  // Refresh reloads only the currently selected team; with no team selected it
  // just refreshes the team list behind the selector.
  const onRefresh = useCallback(() => {
    if (selectedTeam) loadSelectedTeam(selectedTeam);
    else loadTeams();
  }, [selectedTeam, loadSelectedTeam, loadTeams]);

  const selectedTeamObj = useMemo(
    () => (teams || []).find(t => t.id === selectedTeam) || null,
    [teams, selectedTeam],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-4) 0 0', flexWrap: 'wrap' }}>
        <Brain size={20} style={{ color: 'var(--eb-accent-primary)' }} />
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Knowledge Flow
        </h1>
        {selectedTeam && (
          <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
            <span title="Lessons this team's agents have recorded so far">{totals.items} learned</span>
            {totals.today ? <span style={{ color: 'var(--eb-status-success)' }} title="Recorded in the last 24 hours"> (+{totals.today} today)</span> : null}
            {' · '}
            <span title="Learned independently by more than one agent — a strong signal it’s true and important">{totals.converged} converged</span>
            {' · '}
            <span title="Knowledge promoted into reusable skills that agents load automatically">{totals.skills} skills</span>
          </span>
        )}
        <button
          onClick={() => (showIntro ? dismissIntro() : setShowIntro(true))}
          title="A short explanation of how the knowledge system works"
          style={{ ...btn, borderStyle: 'dashed' }}>
          <HelpCircle size={13} /> How it works
        </button>
        <button
          onClick={onRefresh}
          title={selectedTeam ? 'Reload this team’s knowledge' : 'Reload the team list'}
          style={{ ...btn, marginLeft: 'auto' }}>
          <RefreshCw size={14} className={loading ? 'kf-spin' : undefined} /> Refresh
        </button>
      </div>
      <div style={{ padding: '2px 0 var(--eb-space-2)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
        Your agents write down what they learn while working. Watch those lessons become shared team knowledge — and decide what turns into reusable skills.
      </div>

      {showIntro && <HowItWorks onDismiss={dismissIntro} />}

      {/* ── Team selector (mandatory first step — governs the whole page) ────── */}
      {teams && teams.length > 0 && (
        <TeamSelector
          teams={teams}
          selected={selectedTeam}
          onSelect={onSelectTeam}
        />
      )}

      {/* ── Filter bar (refines the selected team in place) ─────────────────── */}
      {selectedTeam && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: '0 0 var(--eb-space-3)', flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', overflow: 'hidden' }}>
          {[['flow', 'Flow', 'The left-to-right flow: agents → team knowledge → skills'],
            ['table', 'Table', 'A human-readable overview: one row per learned fact, with bulk actions']].map(([v, label, tip]) => (
            <button
              key={v}
              onClick={() => chooseView(v)}
              title={tip}
              style={{
                padding: '3px var(--eb-space-3)', border: 'none', cursor: 'pointer',
                fontSize: 'var(--eb-text-xs)',
                background: view === v ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
                color: view === v ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
                fontWeight: view === v ? 'var(--eb-font-semibold)' : 'normal',
              }}>{label}</button>
          ))}
        </div>
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
        {[
          ['all', 'All kinds', 'Show every kind of learned knowledge'],
          ['fact', 'Facts', KIND_EXPLAIN.fact],
          ['entity', 'Entities', KIND_EXPLAIN.entity],
          ['convention', 'Conventions', KIND_EXPLAIN.convention],
        ].map(([k, label, tip]) => (
          <Chip key={k} active={filters.kind === k} title={tip} onClick={() => setFilters(f => ({ ...f, kind: k }))}>
            {label}
          </Chip>
        ))}
        <div style={{ width: 1, height: 20, background: 'var(--eb-border-default)' }} />
        <Chip
          active={filters.convergedOnly}
          title="Show only knowledge that several agents learned independently of each other"
          onClick={() => setFilters(f => ({ ...f, convergedOnly: !f.convergedOnly }))}>Converged only</Chip>
        <Chip
          active={filters.today}
          title="Show only lessons recorded in the last 24 hours"
          onClick={() => setFilters(f => ({ ...f, today: !f.today }))}>Today</Chip>
        <Chip
          active={filters.showArchived}
          title="Also show retired knowledge — it’s hidden by default but kept for audit"
          onClick={() => setFilters(f => ({ ...f, showArchived: !f.showArchived }))}>Show archived</Chip>
      </div>
      )}

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, borderTop: '1px solid var(--eb-border-default)' }}>
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--eb-bg-app)', padding: 'var(--eb-space-4) 0' }}>
          {teams === null ? (
            <div style={{ color: 'var(--eb-text-muted)' }}>Loading…</div>
          ) : teams.length === 0 ? (
            <div style={{ color: 'var(--eb-text-muted)' }}>No agents yet — create a team and its agents will start learning.</div>
          ) : !selectedTeamObj ? (
            <ChooseTeam />
          ) : view === 'table' ? (
            <OverviewTable
              key={selectedTeamObj.id}
              team={selectedTeamObj}
              data={data[selectedTeamObj.id]}
              filters={filters}
              pulseId={pulseId}
              selectedId={selected?.teamId === selectedTeamObj.id ? selected.id : null}
              onOpenItem={openItem}
              onBulkArchive={(ids, archived) => bulkArchive(ids, selectedTeamObj.id, archived)}
              onCombineItems={(sel, teamSkills) => setPromoting({ suggestion: manualSuggestionFrom(sel), teamId: selectedTeamObj.id, teamSkills })}
            />
          ) : (
            <TeamSection
              key={selectedTeamObj.id}
              team={selectedTeamObj}
              data={data[selectedTeamObj.id]}
              filters={filters}
              pulseId={pulseId}
              selectedId={selected?.teamId === selectedTeamObj.id ? selected.id : null}
              onOpenItem={openItem}
              onRetireItem={(item) => {
                if (window.confirm(`Retire this learning from the shared KB?\n\n“${item.text}”\n\nIt stays in git for audit and can be un-retired.`)) {
                  archiveItem(item.id, selectedTeamObj.id, true);
                }
              }}
              onUnarchiveItem={(item) => archiveItem(item.id, selectedTeamObj.id, false)}
              onOpenChat={(agentId) => navigate(`/chats/${encodeURIComponent(agentId)}`)}
              onReviewSuggestion={(s, teamSkills) => setPromoting({ suggestion: s, teamId: selectedTeamObj.id, teamSkills })}
              onCombineItems={(sel, teamSkills) => setPromoting({ suggestion: manualSuggestionFrom(sel), teamId: selectedTeamObj.id, teamSkills })}
              onShareSkill={(node) => setSharing({ node, teamId: selectedTeamObj.id })}
              onControlsChanged={() => loadTeamData(selectedTeamObj.id, selectedTeamObj.members, { withPrivate: false })}
              onLifted={() => loadTeamData(selectedTeamObj.id, selectedTeamObj.members)}
            />
          )}
        </div>

        {/* Right rail: provenance of the selected fact. Collapsed when nothing is selected. */}
        {selected && detail && (
          <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--eb-border-default)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--eb-bg-surface)' }}>
            <Provenance
              detail={detail}
              onClose={() => { setSelected(null); setDetail(null); }}
              onOpenAgent={(id) => navigate(`/chats/${encodeURIComponent(id)}`)}
              onArchive={(id, teamId, archived) => archiveItem(id, teamId ?? selected.teamId, archived)}
            />
          </div>
        )}
      </div>

      {promoting && (
        <PromotionDialog
          suggestion={promoting.suggestion}
          teamId={promoting.teamId}
          teamSkills={promoting.teamSkills}
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
          onDone={() => {
            setSharing(null);
            // Sharing may activate a skill on the source team — reload only it.
            if (selectedTeam) loadSelectedTeam(selectedTeam, { withPrivate: false });
          }}
        />
      )}
    </div>
  );
}

/* ── "How it works" intro — the page explains itself to a first-time user ──── */

function HowItWorks({ onDismiss }) {
  const stepStyle = { flex: '1 1 220px', minWidth: 200 };
  const stepTitle = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', marginBottom: 4 };
  const stepBody = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.55, margin: 0 };
  const num = (n) => (
    <span style={{
      width: 18, height: 18, borderRadius: 'var(--eb-radius-full)', flexShrink: 0,
      background: 'var(--eb-accent-muted)', color: 'var(--eb-accent-primary)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 11, fontWeight: 700,
    }}>{n}</span>
  );
  const dot = (kind) => (
    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[kind], marginRight: 4, verticalAlign: 'baseline' }} />
  );
  return (
    <div style={{
      margin: '0 0 var(--eb-space-3)', padding: 'var(--eb-space-3) var(--eb-space-4)',
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)',
      background: 'var(--eb-bg-surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--eb-space-2)' }}>
        <BookOpen size={15} style={{ color: 'var(--eb-accent-primary)' }} />
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
          How the knowledge system works
        </span>
        <button onClick={onDismiss} style={{ ...btn, marginLeft: 'auto', padding: '2px 10px', fontSize: 'var(--eb-text-xs)' }}>
          Got it — hide this
        </button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-4)', flexWrap: 'wrap' }}>
        <div style={stepStyle}>
          <div style={stepTitle}>{num(1)} Agents learn while they work</div>
          <p style={stepBody}>
            At the end of a work session, each agent writes down the durable lessons it learned.
            Every lesson is a {dot('fact')}<strong>fact</strong> (something true about the project),
            an {dot('entity')}<strong>entity</strong> (a named thing and what’s known about it),
            or a {dot('convention')}<strong>convention</strong> (how the team does things).
          </p>
        </div>
        <div style={stepStyle}>
          <div style={stepTitle}>{num(2)} Lessons become team knowledge</div>
          <p style={stepBody}>
            Lessons flow into the team’s shared knowledge base, where every agent can use them.
            When several agents learn the same thing <em>independently</em>, it’s marked
            {' '}<strong>converged</strong> — a strong signal that it’s both true and important.
          </p>
        </div>
        <div style={stepStyle}>
          <div style={stepTitle}>{num(3)} The best knowledge becomes skills</div>
          <p style={stepBody}>
            Knowledge can be <strong>promoted to a skill</strong>: a reusable instruction file
            agents load automatically. A skill is often a <em>combination</em> of related lessons —
            the system suggests such bundles, and you can also tick several lessons yourself and
            combine them. You review every promotion, unless you let the team curate itself.
          </p>
        </div>
      </div>

      <div style={{ marginTop: 'var(--eb-space-3)', paddingTop: 'var(--eb-space-2)', borderTop: '1px dashed var(--eb-border-default)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.55 }}>
        <ShieldCheck size={12} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--eb-accent-primary)' }} />
        <strong style={{ color: 'var(--eb-text-secondary)' }}>You stay in control.</strong>{' '}
        Each team has an <strong>Autonomy</strong> dial (how much happens without you), an optional
        {' '}<strong>Review</strong> mode (you approve every new lesson first), and <strong>promotion
        gates</strong> (which promotion steps may run automatically). Nothing is deleted silently —
        retired knowledge is kept in git for audit.
      </div>
    </div>
  );
}

/* ── Team selector — the page's mandatory first step (#560) ─────────────────── */

function TeamSelector({ teams, selected, onSelect }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap',
      padding: 'var(--eb-space-3) var(--eb-space-3)', margin: '0 0 var(--eb-space-3)',
      background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
    }}>
      <Users size={16} style={{ color: 'var(--eb-accent-primary)' }} />
      <label htmlFor="kf-team-select" style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
        Team
      </label>
      <select
        id="kf-team-select"
        value={selected || ''}
        onChange={e => onSelect(e.target.value || null)}
        style={{
          minWidth: 220, padding: 'var(--eb-space-2) var(--eb-space-3)',
          border: `1px solid ${selected ? 'var(--eb-border-default)' : 'var(--eb-accent-primary)'}`,
          borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-app)',
          color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
        }}>
        <option value="">Choose a team…</option>
        {teams.map(t => (
          <option key={t.id} value={t.id}>{t.displayName || t.id}</option>
        ))}
      </select>
      <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>
        {selected ? 'Showing this team’s knowledge only.' : 'Pick a team to load its knowledge.'}
      </span>
    </div>
  );
}

/* ── Empty state shown until a team is chosen ───────────────────────────────── */

function ChooseTeam() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-8) var(--eb-space-4)',
      color: 'var(--eb-text-muted)',
    }}>
      <Users size={40} style={{ color: 'var(--eb-accent-primary)', opacity: 0.7 }} />
      <div style={{ fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
        Choose a team to view its knowledge
      </div>
      <div style={{ maxWidth: 420, fontSize: 'var(--eb-text-sm)', lineHeight: 1.55 }}>
        Use the <strong>Team</strong> selector above to pick a team. Its agents’ shared
        knowledge, converged lessons and promoted skills load once you select it.
      </div>
    </div>
  );
}

/* ── One team = one section showing its whole flow ──────────────────────────── */

const TeamSection = React.forwardRef(function TeamSection({
  team, data, filters, pulseId, selectedId,
  onOpenItem, onRetireItem, onUnarchiveItem, onOpenChat,
  onReviewSuggestion, onShareSkill, onCombineItems, onControlsChanged, onLifted,
}, ref) {
  const [agentFilter, setAgentFilter] = useState(null); // agentId | null
  const [hoverConv, setHoverConv] = useState(null); // Set<agentId> | null
  const [picked, setPicked] = useState(() => new Set()); // entry ids ticked for combining
  const togglePick = useCallback((id) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

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
  // Names already in the team's active set — used to hide them from the
  // "Add global skill…" picker.
  const activeSkillNames = useMemo(() => new Set(
    skills.filter(sk => sk.activation && sk.activation.active).map(sk => sk.label)
  ), [skills]);

  // The picked entries, resolved against ALL of the team's items (not the
  // filtered view — a tick must survive a filter change).
  const allItems = useMemo(() => (graph?.nodes || [])
    .filter(n => n.kind === 'item')
    .map(n => ({ ...n, id: n.id.slice(5) })), [graph]);
  const pickedItems = useMemo(() => allItems.filter(n => picked.has(n.id)), [allItems, picked]);
  const combine = useCallback(() => {
    if (pickedItems.length < 1) return;
    onCombineItems(pickedItems, skills);
    setPicked(new Set());
  }, [pickedItems, onCombineItems, skills]);
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
          {agents.length} agents
          {' · '}
          <span title="Lessons this team’s agents have recorded">{counts.items} learned</span>
          {counts.today ? <span style={{ color: 'var(--eb-status-success)' }} title="Recorded in the last 24 hours"> (+{counts.today} today)</span> : null}
          {' · '}
          <span title="Learned independently by more than one agent">{counts.converged} converged</span>
          {' · '}
          <span title="Reusable skills promoted from this team’s knowledge">{skills.length} skills</span>
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
          <ColHeader
            label="Agents"
            hint="learn"
            tip={{
              title: 'Where knowledge starts',
              text: 'The team’s agents. Each one records the durable lessons it learned at the end of a work session. Click an agent to see only its contributions; the speech bubble opens a chat with it.',
            }}
          />
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
          <ColHeader
            label="Team knowledge"
            hint="what the whole team knows"
            tip={{
              title: 'The shared knowledge base',
              text: 'Everything this team’s agents have learned, pooled so every agent can use it. Click a card to see where it came from — which agent, which session, which PR. Tick the checkboxes to combine several related lessons into one skill.',
            }}
            trailing={agentFilter && (
              <Chip active title="Clear this filter" onClick={() => setAgentFilter(null)}>only {agentFilter} ✕</Chip>
            )}
          />
          {reviewQueue.length > 0 && (
            <ReviewQueueBlock teamId={team.id} items={reviewQueue} onChanged={onControlsChanged} />
          )}
          {picked.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--eb-space-2)',
              border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
              background: 'var(--eb-accent-muted)', padding: 'var(--eb-space-2) var(--eb-space-3)',
            }}>
              <Combine size={13} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)' }}>
                {picked.size} lesson{picked.size === 1 ? '' : 's'} selected
              </span>
              <InfoTip
                size={12}
                title="Turn learned knowledge into a skill"
                text={picked.size < 2
                  ? 'One durable lesson can become a skill on its own. You review and edit the draft before anything is created.'
                  : 'Tick the lessons that belong to one topic — a skill is usually a synthesis of several related lessons. You review and edit the combined draft before anything is created.'}
              />
              <button
                onClick={combine}
                disabled={picked.size < 1}
                title={picked.size < 2 ? 'Open the review dialog with this lesson' : 'Open the review dialog with these lessons combined'}
                style={{ ...primaryBtn, marginLeft: 'auto', padding: '2px 10px', fontSize: 'var(--eb-text-xs)', opacity: picked.size < 1 ? 0.5 : 1 }}>
                {picked.size < 2 ? 'Turn into a skill' : 'Combine into one skill'}
              </button>
              <button onClick={() => setPicked(new Set())} style={{ ...miniBtn }}>Clear</button>
            </div>
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
                picked={picked.has(n.id)}
                anyPicked={picked.size > 0}
                onPick={() => togglePick(n.id)}
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
          <ColHeader
            label="Skills"
            hint="proven & reusable"
            tip={{
              title: 'Promoted knowledge',
              text: 'Knowledge that proved important, packaged as a reusable instruction file agents load automatically when they work. Team skills serve this team; a skill can also be shared with other teams.',
            }}
          />
          {suggestions.map(s => (
            <SuggestionCard key={s.id} suggestion={s} onReview={() => onReviewSuggestion(s, skills)} />
          ))}
          {pending.map(p => {
            const s = suggestions.find(x => x.id === p.suggestionId);
            return s ? null : (
              <div key={p.id} style={amberCard} title="This promotion stopped at a gate that requires your review — it won’t proceed on its own.">
                <Sparkles size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)' }}>{p.label}</span>
                <span style={{ fontSize: 10, color: 'var(--eb-status-warning)', marginLeft: 'auto' }}>waiting for your review</span>
              </div>
            );
          })}
          {skills.length === 0 && suggestions.length === 0 && pending.length === 0 && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2) 0' }}>
              No skills yet. {autonomy >= 2
                ? 'When several agents learn the same thing, a suggestion appears here to turn it into a reusable skill.'
                : 'Set Autonomy to “2 Suggest” and you’ll get a suggestion here whenever several agents learn the same thing.'}
            </div>
          )}
          {skills.map(sk => (
            <SkillCard key={sk.id} skill={sk} teamId={team.id} onShare={() => onShareSkill(sk)} onReload={onControlsChanged} />
          ))}
          {privateSkills.length > 0 && (
            <PrivateSkillsBlock teamId={team.id} skills={privateSkills} onLifted={onLifted} />
          )}
          <GlobalSkillPicker teamId={team.id} activeNames={activeSkillNames} onReload={onControlsChanged} />
        </div>
      </div>
    </section>
  );
});

/* ── Overview table — human-readable, one row per learned fact (#635) ───────── */

function OverviewTable({ team, data, filters, pulseId, selectedId, onOpenItem, onBulkArchive, onCombineItems }) {
  const graph = data?.graph;
  const skills = useMemo(() => (graph?.nodes || []).filter(n => n.kind === 'skill'), [graph]);

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
        if (q) {
          const hay = `${n.displaySummary || ''} ${n.text || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [graph, filters]);

  const [picked, setPicked] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());

  // Keep the selection to what's actually on screen — a filter change or a
  // reload must not leave a tick on a row nobody can see.
  useEffect(() => {
    setPicked(prev => {
      if (prev.size === 0) return prev;
      const visible = new Set(items.map(i => i.id));
      const next = new Set();
      let changed = false;
      prev.forEach(id => { if (visible.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [items]);

  const togglePick = useCallback((id) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const toggleExpand = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const allSelected = items.length > 0 && items.every(i => picked.has(i.id));
  const someSelected = picked.size > 0 && !allSelected;
  const selectAllRef = useRef(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);
  const toggleAll = useCallback(() => {
    setPicked(prev => (items.every(i => prev.has(i.id))
      ? new Set()
      : new Set(items.map(i => i.id))));
  }, [items]);

  const pickedItems = useMemo(() => items.filter(i => picked.has(i.id)), [items, picked]);
  const toRetire = useMemo(() => pickedItems.filter(i => !i.archived && i.status !== 'promoted'), [pickedItems]);
  const toUnretire = useMemo(() => pickedItems.filter(i => i.archived), [pickedItems]);
  const toCombine = useMemo(() => pickedItems.filter(i => !i.archived && i.status !== 'promoted'), [pickedItems]);

  const doRetire = useCallback(() => {
    const n = toRetire.length;
    if (n === 0) return;
    if (!window.confirm(`Retire ${n === 1 ? 'this learning' : `these ${n} learnings`} from the shared KB?\n\nThey stay in git for audit and can be un-retired.`)) return;
    Promise.resolve(onBulkArchive(toRetire.map(i => i.id), true)).finally(() => setPicked(new Set()));
  }, [toRetire, onBulkArchive]);

  const doUnretire = useCallback(() => {
    const n = toUnretire.length;
    if (n === 0) return;
    if (!window.confirm(`Un-retire ${n === 1 ? 'this learning' : `these ${n} learnings`} back into the shared KB?`)) return;
    Promise.resolve(onBulkArchive(toUnretire.map(i => i.id), false)).finally(() => setPicked(new Set()));
  }, [toUnretire, onBulkArchive]);

  const doCombine = useCallback(() => {
    if (toCombine.length < 1) return;
    onCombineItems(toCombine, skills);
    setPicked(new Set());
  }, [toCombine, onCombineItems, skills]);

  const th = { textAlign: 'left', padding: 'var(--eb-space-2) var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--eb-text-secondary)', borderBottom: '1px solid var(--eb-border-default)', whiteSpace: 'nowrap' };
  const td = { padding: 'var(--eb-space-2) var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', borderBottom: '1px solid var(--eb-border-default)', verticalAlign: 'top' };

  return (
    <section style={{
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)',
      background: 'var(--eb-bg-surface)', marginBottom: 'var(--eb-space-4)', overflow: 'hidden',
    }}>
      {/* Bulk-action bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          {picked.size > 0
            ? <><strong style={{ color: 'var(--eb-text-primary)' }}>{picked.size}</strong> of {items.length} selected</>
            : <>{items.length} learned fact{items.length === 1 ? '' : 's'}</>}
        </span>
        <InfoTip size={12} title="One row per learned fact" text="A plain-language overview of everything this team’s agents have learned. Tick rows to retire / un-retire them, or to combine several related lessons into one skill. The summary is a readable rewrite; expand a row to see the exact text agents use." />
        <div style={{ flex: 1 }} />
        <button onClick={doCombine} disabled={toCombine.length < 1} title={toCombine.length < 1 ? 'Select one or more active lessons to combine' : 'Open the review dialog with the selected lessons'} style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: toCombine.length < 1 ? 0.5 : 1, cursor: toCombine.length < 1 ? 'default' : 'pointer' }}>
          <Combine size={12} /> Combine{toCombine.length ? ` (${toCombine.length})` : ''}
        </button>
        <button onClick={doUnretire} disabled={toUnretire.length < 1} title={toUnretire.length < 1 ? 'Select one or more retired lessons to un-retire' : 'Bring the selected retired lessons back into the KB'} style={{ ...miniBtn, opacity: toUnretire.length < 1 ? 0.5 : 1, cursor: toUnretire.length < 1 ? 'default' : 'pointer' }}>
          Un-retire{toUnretire.length ? ` (${toUnretire.length})` : ''}
        </button>
        <button onClick={doRetire} disabled={toRetire.length < 1} title={toRetire.length < 1 ? 'Select one or more active lessons to retire' : 'Retire the selected lessons (kept in git for audit)'} style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: toRetire.length < 1 ? 0.5 : 1, cursor: toRetire.length < 1 ? 'default' : 'pointer', color: toRetire.length < 1 ? undefined : 'var(--eb-status-warning)', borderColor: toRetire.length < 1 ? undefined : 'var(--eb-status-warning)' }}>
          <Archive size={11} /> Retire{toRetire.length ? ` (${toRetire.length})` : ''}
        </button>
      </div>

      {items.length === 0 ? (
        <div style={{ padding: 'var(--eb-space-4)' }}>
          <EmptyKnowledge autonomy={data?.gates ? data.gates.autonomy : 1} counts={graph?.counts || { items: 0 }} filtered={!!(filters.q || filters.kind !== 'all' || filters.convergedOnly || filters.today)} />
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 28 }}>
                  <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all rows in view" style={{ margin: 0, cursor: 'pointer', accentColor: 'var(--eb-accent-primary)' }} />
                </th>
                <th style={th}>Kind</th>
                <th style={{ ...th, width: '55%' }}>Summary</th>
                <th style={th}>Learned by</th>
                <th style={th}>Created</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }} title="How many agents learned this independently">Converged</th>
              </tr>
            </thead>
            <tbody>
              {items.map(n => {
                const isOpen = expanded.has(n.id);
                const isPicked = picked.has(n.id);
                const summary = n.displaySummary || n.summary || n.text || '—';
                return (
                  <React.Fragment key={n.id}>
                    <tr
                      className={pulseId === n.id ? 'kf-node-pulse' : undefined}
                      style={{ background: isPicked ? 'var(--eb-accent-muted)' : (selectedId === n.id ? 'var(--eb-bg-elevated)' : 'transparent'), opacity: n.archived ? 0.6 : 1 }}>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <input type="checkbox" checked={isPicked} onChange={() => togglePick(n.id)} title="Select this lesson" style={{ margin: 0, cursor: 'pointer', accentColor: 'var(--eb-accent-primary)' }} />
                      </td>
                      <td style={td}>
                        <span title={KIND_EXPLAIN[n.entryKind]} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'help', whiteSpace: 'nowrap' }}>
                          <span style={{ width: 7, height: 7, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[n.entryKind] || 'var(--eb-accent-primary)' }} />
                          <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--eb-text-muted)' }}>{n.entryKind}</span>
                        </span>
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span
                            onClick={() => onOpenItem(n.id, team.id)}
                            title={n.text || ''}
                            style={{ lineHeight: 1.4, wordBreak: 'break-word', cursor: 'pointer', flex: 1, minWidth: 0 }}>
                            {summary}
                          </span>
                          <button
                            onClick={() => toggleExpand(n.id)}
                            title={isOpen ? 'Hide the exact text agents use' : 'Show the exact text agents use'}
                            style={{ ...linkBtn, flexShrink: 0 }}>
                            {isOpen ? 'Hide text' : 'Text'}
                          </button>
                        </div>
                        {isOpen && (
                          <div style={{ marginTop: 6, padding: 'var(--eb-space-2)', borderLeft: '2px solid var(--eb-border-default)', background: 'var(--eb-bg-app)', borderRadius: 'var(--eb-radius-sm)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.45, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                            {n.text || '—'}
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <span style={{ color: 'var(--eb-text-secondary)' }}>{n.provenance?.originAgent || (n.convergence || [])[0] || '—'}</span>
                        {n.convergenceCount > 1 ? <span style={{ color: 'var(--eb-text-muted)' }}> +{n.convergenceCount - 1}</span> : ''}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>{fmtWhen(n.createdAt) || '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {n.archived ? (
                          <span title="Retired from the active KB — kept in git for audit" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', border: '1px solid var(--eb-border-default)', padding: '0 6px', borderRadius: 'var(--eb-radius-full)' }}>retired</span>
                        ) : (
                          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)' }}>active</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {n.converged
                          ? <span title={`${n.convergenceCount} agents learned this independently`} style={{ fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-accent-primary)' }}>{n.convergenceCount}×</span>
                          : <span style={{ color: 'var(--eb-text-muted)' }}>{n.convergenceCount || 1}</span>}
                      </td>
                    </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ColHeader({ label, hint, tip, trailing }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--eb-space-2)', minHeight: 24 }}>
      <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-secondary)' }}>{label}</span>
      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{hint}</span>
      {tip && <InfoTip size={12} title={tip.title} text={tip.text} />}
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
  if (filtered) msg = 'Nothing matches the current filters — clear them above to see everything again.';
  else if (autonomy === 0) msg = 'Sharing is switched off for this team (Autonomy 0). Set it to “1 Share” above and the agents will pool the lessons they learn here.';
  else if (counts.items === 0) msg = 'Nothing here yet. Agents write down what they learned at the end of each work session — as soon as the first one finishes, its lessons show up here.';
  else msg = 'No entries.';
  return (
    <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-3) 0' }}>{msg}</div>
  );
}

function ItemCard({ item, pulsing, selected, picked, anyPicked, onPick, onClick, onHover, onRetire, onUnarchive }) {
  const canRetire = !item.archived && item.status !== 'promoted';
  const pickable = !item.archived && item.status !== 'promoted' && !!onPick;
  return (
    <div
      className={`kf-item${pulsing ? ' kf-node-pulse' : ''}`}
      onClick={onClick}
      onMouseEnter={() => onHover && onHover(true)}
      onMouseLeave={() => onHover && onHover(false)}
      style={{
        position: 'relative', border: `1px solid ${selected || picked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        boxShadow: selected ? '0 0 0 2px var(--eb-accent-muted)' : 'none',
        borderRadius: 'var(--eb-radius-md)', background: picked ? 'var(--eb-accent-muted)' : 'var(--eb-bg-app)',
        padding: 'var(--eb-space-2) var(--eb-space-3)', marginBottom: 'var(--eb-space-2)',
        cursor: 'pointer', opacity: item.archived ? 0.55 : 1,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        {pickable && (
          <input
            type="checkbox"
            className={anyPicked || picked ? undefined : 'kf-pick'}
            checked={!!picked}
            onChange={onPick}
            onClick={(e) => e.stopPropagation()}
            title="Select this lesson to combine it with others into one skill"
            style={{ margin: 0, cursor: 'pointer', accentColor: 'var(--eb-accent-primary)', flexShrink: 0 }}
          />
        )}
        <span style={{ width: 7, height: 7, borderRadius: 'var(--eb-radius-full)', background: KIND_COLORS[item.entryKind] || 'var(--eb-accent-primary)', flexShrink: 0 }} />
        <span title={KIND_EXPLAIN[item.entryKind]} style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--eb-text-muted)', cursor: 'help' }}>{item.entryKind}</span>
        {item.archived && (
          <span title="Retired from the active knowledge base — kept in git for audit" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', border: '1px solid var(--eb-border-default)', padding: '0 5px', borderRadius: 'var(--eb-radius-full)' }}>retired</span>
        )}
        {item.converged && (
          <span
            title={`${item.convergenceCount} agents learned this independently of each other — a strong signal it’s true and important. Converged knowledge is what gets suggested as a skill.`}
            style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-accent-primary)', background: 'var(--eb-accent-muted)', padding: '0 6px', borderRadius: 'var(--eb-radius-full)', cursor: 'help' }}>
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

/* ── Skill card with activation state (team scope) ──────────────────────────── */

// Plain-language chip per member state — what the badge expands into.
const MEMBER_STATE_CHIPS = {
  active: { label: '✓ active', color: 'var(--eb-status-success)', tip: 'This member has the skill in its workspace and loads it when it works.' },
  pending: { label: 'pending', color: 'var(--eb-status-warning)', tip: 'The skill is in the team’s active set but hasn’t reached this member’s workspace yet.' },
  'excluded-override': { label: 'excluded — own skill list', color: 'var(--eb-text-muted)', tip: 'This member manages its own skill list, so team activations don’t apply automatically.' },
  stub: { label: 'not materialized', color: 'var(--eb-text-muted)', tip: 'This member has no workspace yet — it gets the skill when it’s materialized.' },
  inactive: { label: 'inactive', color: 'var(--eb-text-muted)', tip: 'This member doesn’t have the skill in its workspace.' },
};

// Per-copy drift chip (#629). `outdated` is the only auto-resyncable state — it
// gets an Update button; `diverged`/`conflict`/`orphaned`/`unknown` are surfaced
// but never auto-overwritten (they point to the manual path). `in-sync` shows
// nothing (the default healthy state).
const DRIFT_CHIPS = {
  outdated: { label: 'outdated', color: 'var(--eb-status-warning)', tip: 'The source skill moved on since this copy was seeded. Click Update to resync it.' },
  diverged: { label: 'edited locally', color: 'var(--eb-status-warning)', tip: 'This copy was edited locally while the source stayed put — resync won’t overwrite it. Re-import or discard the local edit manually.' },
  conflict: { label: 'conflict', color: 'var(--eb-status-error, #d33)', tip: 'Both this copy and the source changed — resync won’t overwrite it. Resolve manually (re-import or discard the local edit).' },
  orphaned: { label: 'source deleted', color: 'var(--eb-status-error, #d33)', tip: 'The source skill was deleted. Restore it from the archive or detach this copy.' },
  unknown: { label: 'no origin', color: 'var(--eb-text-muted)', tip: 'This copy predates skill manifests, so its origin is unknown — it is surfaced but never auto-synced. Re-import to establish an anchor.' },
};

function SkillCard({ skill, teamId, onShare, onReload }) {
  const auto = skill.promotedBy === 'curator';
  const act = skill.activation || null;
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(null); // 'activate' | 'deactivate' | <agentId>
  const [flash, setFlash] = useState(null); // { kind: 'ok' | 'error', text }
  const flashTimer = useRef(null);

  const feedback = (kind, text) => {
    setFlash({ kind, text });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), kind === 'error' ? 8000 : 4000);
  };

  const activate = (busyKey, includeMembers) => {
    setBusy(busyKey);
    fetch('/api/knowledge/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, skillName: skill.label, ...(includeMembers ? { includeMembers } : {}) }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        const ms = Array.isArray(d.members) ? d.members : [];
        const ok = ms.filter(m => !/error|fail|excluded|stub|skip/i.test(String(m.status || ''))).length;
        feedback('ok', ms.length ? `active for ${ok}/${ms.length} member${ms.length === 1 ? '' : 's'}` : 'activated');
        onReload && onReload();
      })
      .catch(e => feedback('error', `Action failed: ${e.message}`))
      .finally(() => setBusy(null));
  };

  const deactivate = () => {
    if (!window.confirm(`Remove "${skill.label}" from the team's active skills? The skill file stays in the pool and can be reactivated.`)) return;
    setBusy('deactivate');
    fetch('/api/knowledge/deactivate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, skillName: skill.label }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        onReload && onReload();
      })
      .catch(e => feedback('error', `Action failed: ${e.message}`))
      .finally(() => setBusy(null));
  };

  // Drift resync (#629 AC3/AC4). `scope` is { teamId } for the bulk "Sync all
  // outdated" or { agentId } for a single copy's Update. The backend only
  // overwrites `outdated` copies; diverged/conflict/orphaned/unknown come back
  // refused, which we report so the operator knows to resolve them manually.
  const resync = (scope, busyKey) => {
    setBusy(busyKey);
    fetch('/api/skills/resync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: skill.label, scope }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        const parts = [];
        if (d.resynced) parts.push(`${d.resynced} updated`);
        if (d.refused) parts.push(`${d.refused} need manual resolution`);
        feedback(d.refused ? 'error' : 'ok', parts.length ? parts.join(' · ') : 'already up to date');
        onReload && onReload();
      })
      .catch(e => feedback('error', `Resync failed: ${e.message}`))
      .finally(() => setBusy(null));
  };

  // Guarded team-skill deletion (#627, AC4) — the Knowledge page is the
  // Team-Admin-accessible surface, so a Team Admin can delete their own team's
  // skill here without the System-Admin Skills Registry. The backend guards the
  // DELETE (409 + blocking constructs) and gates permission per tier; global
  // deletion stays on the Skills Registry. An in-use skill 409s, so we offer the
  // one-click cascade (deactivate the grants, then delete) the same way the
  // Registry does. A restorable snapshot is archived either way.
  const runDelete = (cascade) => {
    setBusy('delete');
    const params = new URLSearchParams({ source: 'team', teamId });
    if (cascade) params.set('cascade', 'true');
    fetch(`/api/skills/${encodeURIComponent(skill.label)}?${params}`, { method: 'DELETE' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (r.status === 409 && Array.isArray(d.agents) && !cascade) {
            if (window.confirm(`"${skill.label}" is still active for: ${d.agents.join(', ')}.\nDeactivate those grants and delete anyway? A restorable snapshot is archived first.`)) {
              runDelete(true); // keeps busy = 'delete' through the cascade
            } else {
              setBusy(null);
            }
            return;
          }
          throw new Error(d.error || `HTTP ${r.status}`);
        }
        feedback('ok', 'deleted');
        setBusy(null);
        onReload && onReload();
      })
      .catch(e => { feedback('error', `Delete failed: ${e.message}`); setBusy(null); });
  };

  const deleteSkill = () => {
    if (!window.confirm(`Delete team skill "${skill.label}"? A restorable snapshot is archived, then the skill is removed from the team pool.`)) return;
    runDelete(false);
  };

  const members = act ? (act.members || []) : [];
  const activeCount = members.filter(m => m.state === 'active').length;
  // Node-level drift rollup (#629 AC2): { worst, outdated, resyncable, total, counts }.
  const drift = skill.drift || null;
  const driftWorst = drift && drift.worst && drift.worst !== 'in-sync' ? drift.worst : null;
  const badge = !act ? null : !act.active
    ? { text: 'promoted · not activated', color: 'var(--eb-text-muted)', border: 'var(--eb-border-default)',
        tip: 'This skill is promoted and lives in the team’s pool, but it is not in the team’s active set — no member loads it yet. Click Activate to sync it into members.' }
    : { text: `active · ${activeCount}/${members.length}`,
        color: activeCount === members.length ? 'var(--eb-status-success)' : 'var(--eb-status-warning)',
        border: activeCount === members.length ? 'var(--eb-status-success)' : 'var(--eb-status-warning)',
        tip: 'This skill is in the team’s active set. The count shows how many members actually have it in their workspace.' };

  return (
    <div style={{
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-elevated)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', marginBottom: 'var(--eb-space-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <GitBranch size={13} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{skill.label}</div>
          <div
            style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', cursor: 'help' }}
            title={`${skill.tier === 'global' ? 'Global skill — agents in every team load it' : 'Team skill — only this team’s agents load it'}${skill.alsoGlobal ? '. Also promoted to the global pool — the team keeps its own copy.' : ''}${auto ? '. Promoted automatically by the team’s curator (autonomy 3).' : ''}${skill.adopted ? '. Adopted from the global pool into this team’s active set.' : ''}`}>
            {skill.tier} skill{skill.alsoGlobal ? ' · also global' : ''}{auto ? ' · auto-promoted' : ''}{skill.adopted ? ' · adopted' : ''}
          </div>
        </div>
        {badge && (
          <span
            onClick={() => members.length > 0 && setExpanded(x => !x)}
            title={badge.tip}
            style={{
              flexShrink: 0, fontSize: 10, fontWeight: 600, padding: '1px 7px',
              borderRadius: 'var(--eb-radius-full)', border: `1px solid ${badge.border}`,
              color: badge.color, cursor: members.length > 0 ? 'pointer' : 'help', whiteSpace: 'nowrap',
            }}>
            {badge.text}
          </span>
        )}
        {act && act.active && (
          <span
            title="Deactivate — remove this skill from the team's active set (the file stays in the pool)"
            onClick={deactivate}
            style={{ display: 'inline-flex', flexShrink: 0, cursor: 'pointer', color: 'var(--eb-text-muted)' }}>
            <X size={13} />
          </span>
        )}
        <span
          title="Share this skill into another team"
          onClick={onShare}
          style={{ display: 'inline-flex', flexShrink: 0, cursor: 'pointer', color: 'var(--eb-text-muted)' }}>
          <Share2 size={13} />
        </span>
        {skill.tier === 'team' && (
          <span
            title="Delete this team skill — archives a restorable snapshot, then removes it from the team pool (Team Admin)"
            onClick={() => { if (!busy) deleteSkill(); }}
            style={{ display: 'inline-flex', flexShrink: 0, cursor: busy ? 'default' : 'pointer', color: 'var(--eb-status-error, #d33)', opacity: busy ? 0.5 : 1 }}>
            <Trash2 size={13} />
          </span>
        )}
      </div>

      {act && !act.active && (
        <div style={{ marginTop: 6 }}>
          <button
            disabled={busy === 'activate'}
            onClick={() => activate('activate')}
            title="Add this skill to the team's active set and sync it into every member's workspace"
            style={{ ...primaryBtn, padding: '2px 10px', fontSize: 'var(--eb-text-xs)' }}>
            {busy === 'activate' ? 'Activating…' : 'Activate'}
          </button>
        </div>
      )}

      {driftWorst && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            title={(DRIFT_CHIPS[driftWorst] || {}).tip || 'Some copies of this skill have drifted from the source.'}
            style={{
              fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 'var(--eb-radius-full)',
              border: `1px solid ${(DRIFT_CHIPS[driftWorst] || {}).color || 'var(--eb-status-warning)'}`,
              color: (DRIFT_CHIPS[driftWorst] || {}).color || 'var(--eb-status-warning)', cursor: 'help', whiteSpace: 'nowrap',
            }}>
            {drift.outdated > 0 ? `${drift.outdated} outdated` : (DRIFT_CHIPS[driftWorst] || {}).label || driftWorst}
          </span>
          {drift.resyncable > 0 && (
            <button
              disabled={!!busy}
              onClick={() => resync({ teamId }, 'resync')}
              title="Sync all outdated copies of this skill to the current source content (edited/conflicted copies are left untouched)"
              style={{ ...primaryBtn, padding: '2px 10px', fontSize: 'var(--eb-text-xs)' }}>
              {busy === 'resync' ? 'Syncing…' : `Sync all outdated (${drift.resyncable})`}
            </button>
          )}
        </div>
      )}

      {expanded && members.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '1px dashed var(--eb-border-default)', paddingTop: 6 }}>
          {members.map(m => {
            const chip = MEMBER_STATE_CHIPS[m.state] || { label: m.state, color: 'var(--eb-text-muted)', tip: '' };
            return (
              <div key={m.agentId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.displayName || m.agentId}
                </span>
                <span
                  title={chip.tip}
                  style={{
                    flexShrink: 0, fontSize: 10, fontWeight: 600, padding: '0 6px',
                    borderRadius: 'var(--eb-radius-full)', border: `1px solid ${chip.color}`,
                    color: chip.color, cursor: 'help', whiteSpace: 'nowrap',
                  }}>
                  {chip.label}
                </span>
                {m.drift && m.drift !== 'in-sync' && DRIFT_CHIPS[m.drift] && (
                  <span
                    title={DRIFT_CHIPS[m.drift].tip}
                    style={{
                      flexShrink: 0, fontSize: 10, fontWeight: 600, padding: '0 6px',
                      borderRadius: 'var(--eb-radius-full)', border: `1px solid ${DRIFT_CHIPS[m.drift].color}`,
                      color: DRIFT_CHIPS[m.drift].color, cursor: 'help', whiteSpace: 'nowrap',
                    }}>
                    {DRIFT_CHIPS[m.drift].label}
                  </span>
                )}
                {m.drift === 'outdated' && (
                  <button
                    disabled={!!busy}
                    onClick={() => resync({ agentId: m.agentId }, m.agentId)}
                    title="Resync this copy to the current source content"
                    style={linkBtn}>
                    {busy === m.agentId ? 'Updating…' : 'Update'}
                  </button>
                )}
                {m.state === 'excluded-override' && (
                  <button
                    disabled={!!busy}
                    onClick={() => activate(m.agentId, [m.agentId])}
                    title="This member manages its own skill list — opt it into this skill anyway"
                    style={linkBtn}>
                    {busy === m.agentId ? 'Adding…' : 'Add for this member'}
                  </button>
                )}
                {m.state === 'pending' && (
                  <button
                    disabled={!!busy}
                    onClick={() => activate(m.agentId)}
                    title="Re-run the workspace sync so this member gets the skill now"
                    style={linkBtn}>
                    {busy === m.agentId ? 'Syncing…' : 'Sync now'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {flash && (
        <div style={{
          marginTop: 4, fontSize: 'var(--eb-text-xs)', fontWeight: 600,
          color: flash.kind === 'ok' ? 'var(--eb-status-success)' : 'var(--eb-status-error, #d33)',
        }}>
          {flash.kind === 'ok' ? '✓ ' : '⚠ '}{flash.text}
        </div>
      )}
    </div>
  );
}

/* ── "Add global skill…" — activate a pool skill for this team ───────────────── */

function GlobalSkillPicker({ teamId, activeNames, onReload }) {
  const [open, setOpen] = useState(false);
  const [pool, setPool] = useState(null); // null = loading, [] = loaded
  const [busy, setBusy] = useState(null); // skill name being activated
  const [flash, setFlash] = useState(null); // { kind: 'ok' | 'error', text }
  const flashTimer = useRef(null);

  const feedback = (kind, text) => {
    setFlash({ kind, text });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), kind === 'error' ? 8000 : 4000);
  };

  const toggle = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setPool(null);
    fetch('/api/skills')
      .then(r => (r.ok ? r.json() : []))
      .then(list => setPool((Array.isArray(list) ? list : [])
        .filter(s => s.source === 'pool')
        .map(s => s.name)))
      .catch(() => setPool([]));
  };

  const activate = (name) => {
    setBusy(name);
    fetch('/api/knowledge/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, skillName: name }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        const ms = Array.isArray(d.members) ? d.members : [];
        const ok = ms.filter(m => !/error|fail|excluded|stub|skip/i.test(String(m.status || ''))).length;
        feedback('ok', ms.length ? `${name}: active for ${ok}/${ms.length} member${ms.length === 1 ? '' : 's'}` : `${name} activated`);
        onReload && onReload();
      })
      .catch(e => feedback('error', `Action failed: ${e.message}`))
      .finally(() => setBusy(null));
  };

  const candidates = pool === null ? null : pool.filter(nm => !activeNames.has(nm));

  return (
    <div style={{ marginTop: 'var(--eb-space-3)' }}>
      <button
        onClick={toggle}
        title="Activate a skill from the global pool for this team — it gets synced into every member's workspace"
        style={{ ...miniBtn, borderStyle: 'dashed' }}>
        {open ? '− Add global skill…' : '+ Add global skill…'}
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {candidates === null ? (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Loading…</div>
          ) : candidates.length === 0 ? (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>No further global skills available.</div>
          ) : (
            candidates.map(nm => (
              <div key={nm} style={{
                display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-app)',
                padding: '4px var(--eb-space-3)', marginBottom: 4,
              }}>
                <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {nm}
                </span>
                <button
                  disabled={!!busy}
                  onClick={() => activate(nm)}
                  title="Add this global skill to the team's active set"
                  style={miniBtn}>
                  {busy === nm ? 'Activating…' : 'Activate'}
                </button>
              </div>
            ))
          )}
          {flash && (
            <div style={{
              marginTop: 2, fontSize: 'var(--eb-text-xs)', fontWeight: 600,
              color: flash.kind === 'ok' ? 'var(--eb-status-success)' : 'var(--eb-status-error, #d33)',
            }}>
              {flash.kind === 'ok' ? '✓ ' : '⚠ '}{flash.text}
            </div>
          )}
        </div>
      )}
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
  const related = suggestion.source === 'related';
  return (
    <div style={{ ...amberCard, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {related
          ? <Combine size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
          : <Sparkles size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />}
        <span
          title={related
            ? 'Several distinct but related lessons about one topic — review to combine them into a single reusable skill.'
            : 'This knowledge looks important enough to become a reusable skill. Review it to promote — or dismiss it.'}
          style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-warning)', cursor: 'help' }}>
          {related ? 'Related lessons — suggested skill' : 'Suggested skill'}
        </span>
        <span
          style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', cursor: 'help' }}
          title={related
            ? `${suggestion.lessonCount} related lessons from ${suggestion.convergenceCount} agent(s) — they belong to one topic`
            : suggestion.source === 'agent-nominated'
              ? 'An agent itself nominated this as worth promoting'
              : `${suggestion.convergenceCount} agents learned this independently`}>
          {related
            ? `${suggestion.lessonCount} lessons · ${suggestion.convergenceCount} agent${suggestion.convergenceCount === 1 ? '' : 's'}`
            : `${suggestion.convergenceCount}× learned${suggestion.source === 'agent-nominated' ? ' · nominated' : ''}`}
        </span>
      </div>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', wordBreak: 'break-word' }}>
        {suggestion.text}
        {related && suggestion.lessonCount > 1 && (
          <span style={{ color: 'var(--eb-text-muted)' }}> + {suggestion.lessonCount - 1} related lesson{suggestion.lessonCount === 2 ? '' : 's'}</span>
        )}
      </div>
      <button onClick={onReview} title="Open the review dialog — nothing is promoted until you confirm" style={{ ...primaryBtn, alignSelf: 'flex-end' }}>Review & promote</button>
    </div>
  );
}

function PrivateSkillsBlock({ teamId, skills, onLifted }) {
  const [state, setState] = useState({}); // name -> 'lifting' | 'activating' | 'done' | 'done-noact' | 'exists' | 'error'
  const lift = (sk) => {
    setState(s => ({ ...s, [sk.name]: 'lifting' }));
    fetch('/api/knowledge/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'agent', to: 'team', teamId, agentId: sk.agentId, name: sk.name }),
    })
      .then(r => {
        if (r.status === 201) {
          // Lift succeeded — activation is the point of lifting, so it runs
          // without a checkbox. A failure never rolls the lift back.
          setState(s => ({ ...s, [sk.name]: 'activating' }));
          return activateSkill(teamId, sk.name)
            .then(() => setState(s => ({ ...s, [sk.name]: 'done' })))
            .catch(() => setState(s => ({ ...s, [sk.name]: 'done-noact' })))
            .finally(() => { onLifted && onLifted(); });
        }
        setState(s => ({ ...s, [sk.name]: r.status === 409 ? 'exists' : 'error' }));
      })
      .catch(() => setState(s => ({ ...s, [sk.name]: 'error' })));
  };
  return (
    <div style={{ marginTop: 'var(--eb-space-3)' }}>
      <ColHeader
        label="Private skills"
        hint="one agent only"
        tip={{
          title: 'Skills a single agent made for itself',
          text: 'These exist only in one agent’s workspace — teammates can’t use them. “Lift to team” copies a skill into the team pool so every agent on the team loads it.',
        }}
      />
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
            <button
              onClick={() => lift(sk)}
              disabled={st === 'lifting' || st === 'activating' || st === 'done' || st === 'done-noact'}
              title="Copy this skill into the team pool and activate it so every agent on the team loads it"
              style={miniBtn}>
              {st === 'lifting' ? 'Lifting…'
                : st === 'activating' ? 'Activating…'
                : st === 'done' ? 'Lifted & active ✓'
                : st === 'done-noact' ? 'Lifted ✓ (activation failed — use the skill card)'
                : st === 'exists' ? 'Name taken'
                : 'Lift to team'}
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
      <div style={{ padding: '5px var(--eb-space-3)', borderBottom: '1px solid var(--eb-status-warning)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ShieldCheck size={13} style={{ color: 'var(--eb-status-warning)' }} />
          <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-warning)' }}>Awaiting your review</span>
          <span style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{items.length}</span>
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 2 }}>
          Review is on for this team: new lessons enter the shared knowledge only after you approve them.
        </div>
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

/* ── Learning controls: read-only summary + a slide-out configuration panel ── */

// Well-known protected branches — mirrors orchestrator knowledge-sync
// PROTECTED_BRANCHES. Advisory only: the UI warns, it never blocks (#558 AC-3).
const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'trunk'];
function isProtectedBranchName(branch) {
  return PROTECTED_BRANCHES.includes(String(branch || '').trim().toLowerCase());
}
const KB_DEFAULT_BRANCH = 'agent-knowledge';
const KB_DEFAULT_PATH = 'docs/agent-knowledge/';

/* ── Read-only configuration summary + slide-out configuration panel ─────────── */

// A single labelled value in the collapsed summary strip.
function SummaryPill({ label, value, title }) {
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-muted)' }}>{label}</span>
      <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 600, color: 'var(--eb-text-secondary)' }}>{value}</span>
    </span>
  );
}

// The collapsed strip: a read-only summary of the live configuration plus a
// single action that opens the slide-out panel (#566). Nothing is edited here.
function ControlStrip({ teamId, gates, onChanged }) {
  const [panelOpen, setPanelOpen] = useState(false);

  const autonomy = gates.autonomy;
  const review = !!gates.review;
  const g = gates.gates || {};
  const current = AUTONOMY_LEVELS.find(l => l.level === autonomy) || AUTONOMY_LEVELS[1];
  const store = gates.store || {};
  const storeBranch = store.branch || KB_DEFAULT_BRANCH;

  return (
    <div style={{ borderBottom: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-app)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-2) var(--eb-space-4)', flexWrap: 'wrap' }}>
        <ShieldCheck size={13} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
        <span style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-muted)', flexShrink: 0 }}>
          Knowledge configuration
        </span>

        {/* Read-only summary of the live saved values */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', flexWrap: 'wrap', minWidth: 0 }}>
          <SummaryPill label="Autonomy" value={`${autonomy} · ${current.label}`} title={current.tip} />
          <SummaryPill label="Review" value={review ? 'on' : 'off'}
            title={autonomy < 1 ? 'Review needs autonomy 1 or higher — at 0, nothing is shared in the first place.' : (review ? 'New lessons wait for your approval before they are shared.' : 'New lessons are shared immediately.')} />
          {GATE_ORDER.map(tr => (
            <SummaryPill key={tr} label={GATE_LABELS[tr]}
              value={tr === 'team>global' ? 'always reviewed' : ((g[tr] || 'review') === 'auto' ? 'automatic' : 'needs review')}
              title={GATE_TIPS[tr]} />
          ))}
          <SummaryPill
            label="Storage"
            title="Where this team’s shared knowledge is stored."
            value={(
              <>
                {store.mode === 'own-repo' ? 'separate repo' : 'in team repo'} · {storeBranch}
                {isProtectedBranchName(storeBranch) && (
                  <span title="This is a protected branch — pushes may be rejected." style={{ color: 'var(--eb-status-warning)', marginLeft: 3 }}>⚠</span>
                )}
              </>
            )}
          />
        </div>

        <button
          onClick={() => setPanelOpen(true)}
          title="Open the knowledge configuration panel"
          style={{ ...miniBtn, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <Wand2 size={12} /> Configure knowledge
        </button>
      </div>

      {panelOpen && (
        <ConfigurePanel
          teamId={teamId}
          gates={gates}
          onClose={() => setPanelOpen(false)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

/* ── Configuration panel: all controls, one slide-out surface (#566) ─────────── */

// The roomy right-side slide-out (built on the shared SidePanel) that holds
// every knowledge setting — Autonomy, Review, Promotion gates and Storage —
// each in its own explained section. Writes go through the same endpoints the
// inline strip used; a successful save refreshes the summary via onChanged.
// The former standalone StorageDialog (#558) is now the Storage section here.
function ConfigurePanel({ teamId, gates, onClose, onChanged }) {
  const [busy, setBusy] = useState(null); // which control is writing
  const [flash, setFlash] = useState(null); // { kind: 'ok' | 'error', text }
  const flashTimer = useRef(null);

  const feedback = (kind, text) => {
    setFlash({ kind, text });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), kind === 'error' ? 8000 : 3500);
  };
  useEffect(() => () => clearTimeout(flashTimer.current), []);

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

  /* ── Storage section state (consolidated from the former StorageDialog) ── */
  const initial = gates.store || {};
  const repositories = Array.isArray(gates.repositories) ? gates.repositories : [];
  const [mode, setMode] = useState(initial.mode === 'own-repo' ? 'own-repo' : 'in-repo');
  const [branch, setBranch] = useState(initial.branch || KB_DEFAULT_BRANCH);
  const [kbPath, setKbPath] = useState(initial.path || KB_DEFAULT_PATH);
  const [inRepoUrl, setInRepoUrl] = useState(
    (initial.repoRef && initial.repoRef.url) || (repositories[0] && repositories[0].url) || '',
  );
  const [ownUrl, setOwnUrl] = useState(initial.mode === 'own-repo' && initial.repoRef ? initial.repoRef.url : '');
  const [sshKeyId, setSshKeyId] = useState((initial.repoRef && initial.repoRef.sshKeyId) || '');
  const [githubTokenId, setGithubTokenId] = useState((initial.repoRef && initial.repoRef.githubTokenId) || '');
  const [sshKeys, setSshKeys] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [storeBusy, setStoreBusy] = useState(false);
  const [storeError, setStoreError] = useState('');
  const [ack, setAck] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/ssh-keys').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/github-tokens').then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([keys, toks]) => {
      if (!alive) return;
      setSshKeys(Array.isArray(keys) ? keys : []);
      setTokens(Array.isArray(toks) ? toks : []);
    });
    return () => { alive = false; };
  }, []);

  // Did the effective location actually change? (drives the AC-5 confirmation.)
  const origBranch = initial.branch || KB_DEFAULT_BRANCH;
  const origPath = initial.path || KB_DEFAULT_PATH;
  const normPath = (p) => { let v = String(p || '').trim(); if (v && !v.endsWith('/')) v += '/'; return v; };
  const targetUrl = mode === 'own-repo' ? ownUrl.trim() : inRepoUrl.trim();
  const origUrl = (initial.repoRef && initial.repoRef.url) || '';
  const locationChanged =
    mode !== (initial.mode === 'own-repo' ? 'own-repo' : 'in-repo') ||
    branch.trim() !== origBranch ||
    normPath(kbPath) !== normPath(origPath) ||
    (mode === 'own-repo' && targetUrl !== origUrl) ||
    (mode === 'in-repo' && repositories.length > 1 && targetUrl !== origUrl);

  const canSaveStore = !storeBusy
    && (mode === 'in-repo' || ownUrl.trim() !== '')
    && branch.trim() !== ''
    && (!locationChanged || ack);

  const saveStore = () => {
    setStoreBusy(true); setStoreError('');
    const repoRef = mode === 'own-repo'
      ? { url: ownUrl.trim(), sshKeyId: sshKeyId || '', githubTokenId: githubTokenId || '' }
      : { url: repositories.length > 1 ? inRepoUrl.trim() : '', sshKeyId: '', githubTokenId: '' };
    const body = { teamId, store: { mode, branch: branch.trim(), path: normPath(kbPath), repoRef } };
    fetch('/api/knowledge/store', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setAck(false);
        feedback('ok', 'Storage location saved. Existing knowledge stays where it was.');
        onChanged && onChanged();
      })
      .catch(e => setStoreError(e.message))
      .finally(() => setStoreBusy(false));
  };

  return (
    <SidePanel open onClose={onClose} title="Team knowledge configuration" loading={busy != null || storeBusy}>
      <p style={{ margin: '0 0 var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
        Control how this team turns what its agents learn into shared knowledge and reusable skills, and where that
        knowledge is kept. Changes save immediately; running agents pick them up at their next rebuild.
      </p>

      {/* Autonomy / Review / Promotion gates — shared with the wizard (#566/#567) */}
      <KnowledgeLearningSections
        autonomy={autonomy}
        review={review}
        gates={g}
        busy={busy}
        onAutonomy={(level) => call('autonomy', '/api/knowledge/autonomy', { teamId, level })}
        onReview={(enabled) => call('review', '/api/knowledge/review-mode', { teamId, enabled })}
        onGate={(transition, mode) => call(transition, '/api/knowledge/gates', { teamId, transition, mode })}
      />

      {/* Storage */}
      <PanelSection
        title="Storage"
        blurb="Where this team’s shared knowledge base is kept — the agents, the digest and every push all follow this setting. Keep it in the repository this team already uses (on a dedicated branch) or point it at a separate knowledge repository. Changing the location does not move knowledge already stored at the old one; the team starts building fresh at the new location.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <label style={lbl}>Where</label>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <Chip active={mode === 'in-repo'} title="Keep knowledge in the repository this team already uses" onClick={() => setMode('in-repo')}>In the team’s repo</Chip>
            <Chip active={mode === 'own-repo'} title="Keep knowledge in a separate, dedicated repository" onClick={() => setMode('own-repo')}>Separate knowledge repo</Chip>
          </div>

          {mode === 'in-repo' ? (
            repositories.length === 0 ? (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-warning)' }}>
                This team’s environment has no repository — pick “Separate knowledge repo”, or add a repository to the environment first.
              </div>
            ) : repositories.length > 1 ? (
              <>
                <label style={lbl}>Repository</label>
                <select value={inRepoUrl} onChange={e => setInRepoUrl(e.target.value)} style={inp}>
                  {repositories.map(r => <option key={r.url} value={r.url}>{r.url}</option>)}
                </select>
              </>
            ) : (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                Uses <code>{repositories[0].url}</code> — the repository this team already clones.
              </div>
            )
          ) : (
            <>
              <label style={lbl}>Knowledge repository URL</label>
              <input value={ownUrl} onChange={e => setOwnUrl(e.target.value)} placeholder="git@github.com:org/knowledge.git" style={inp} />
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>SSH key</label>
                  <select value={sshKeyId} onChange={e => setSshKeyId(e.target.value)} style={inp}>
                    <option value="">None</option>
                    {sshKeys.map(k => <option key={k.id} value={k.id}>{k.name || k.id}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>GitHub token</label>
                  <select value={githubTokenId} onChange={e => setGithubTokenId(e.target.value)} style={inp}>
                    <option value="">None</option>
                    {tokens.map(t => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}

          <label style={lbl}>Branch</label>
          <input value={branch} onChange={e => setBranch(e.target.value)} placeholder={KB_DEFAULT_BRANCH} style={inp} />
          {isProtectedBranchName(branch) && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', lineHeight: 1.4 }}>
              ⚠ <strong>{branch.trim()}</strong> is a protected branch. Agents push knowledge directly and often, so a
              protected branch may reject those pushes. You can still choose it — just make sure pushes are allowed.
            </div>
          )}

          <label style={lbl}>Path within the repo</label>
          <input value={kbPath} onChange={e => setKbPath(e.target.value)} placeholder={KB_DEFAULT_PATH} style={inp} />

          {locationChanged && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ marginTop: 2 }} />
              <span>I understand that knowledge already stored at the current location <strong>stays there</strong> — changing this setting does not move or copy it. The team starts building knowledge fresh at the new location.</span>
            </label>
          )}

          {storeError && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error, #d33)', fontWeight: 600 }}>⚠ Not saved: {storeError}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={saveStore} disabled={!canSaveStore} style={{ ...primaryBtn, opacity: canSaveStore ? 1 : 0.5, cursor: canSaveStore ? 'pointer' : 'not-allowed' }}>
              <GitBranch size={13} />
              {storeBusy ? 'Checking & saving…' : 'Save storage location'}
            </button>
          </div>
        </div>
      </PanelSection>

      {flash && (
        <div style={{
          position: 'sticky', bottom: 0, marginTop: 'var(--eb-space-4)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
          background: 'var(--eb-bg-surface)', border: `1px solid ${flash.kind === 'ok' ? 'var(--eb-status-success)' : 'var(--eb-status-error, #d33)'}`,
          fontSize: 'var(--eb-text-xs)', fontWeight: 600,
          color: flash.kind === 'ok' ? 'var(--eb-status-success)' : 'var(--eb-status-error, #d33)',
        }}>
          {flash.kind === 'ok' ? '✓ ' : '⚠ '}{flash.text}
        </div>
      )}
    </SidePanel>
  );
}

/* ── Provenance drill-down (right rail) ─────────────────────────────────────── */

function Provenance({ detail, onClose, onOpenAgent, onArchive }) {
  const { entry, links } = detail;
  const archived = entry.status === 'archived';
  const promoted = entry.status === 'promoted';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: 'var(--eb-space-3)', borderBottom: '1px solid var(--eb-border-default)' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>Provenance</span>
          <button onClick={onClose} style={{ ...btn, marginLeft: 'auto', padding: 4 }}><X size={14} /></button>
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 2 }}>
          Where this knowledge came from: the agent that learned it, the session it happened in, and any linked PR or issue.
        </div>
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
        <Lineage label="Independently learned by">
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}
            title="Agents that learned this on their own, without seeing each other’s notes — the more, the stronger the signal">
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

/* ── Activation as the default last step (Phase 3) ─────────────────────────────
 * Every flow that puts a skill into a pool (promote / share / lift) offers to
 * activate it right away. Activation failures NEVER roll back or fail the
 * primary action — callers surface them as a warning with a pointer to the
 * Activate button on the skill card. */

function activateSkill(teamId, skillName) {
  return fetch('/api/knowledge/activate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, skillName }),
  }).then(async r => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  });
}

// "active for k/n members" (k = seeded), or plain "activated" for standalone.
function activationSummary(d) {
  const ms = Array.isArray(d?.members) ? d.members : [];
  if (!ms.length) return 'activated';
  const k = ms.filter(m => m.status === 'seeded').length;
  return `active for ${k}/${ms.length} member${ms.length === 1 ? '' : 's'}`;
}

// A promotion-dialog option toggle. Shared look/placement for the "activate now"
// (#463) and "remove source knowledge" (#559) checkboxes so they read as siblings.
// #559: fold the server's best-effort source-cleanup outcome into the dialog's
// result notice. A cleanup failure is a warning (the skill still promoted, the
// source entries were left intact — AC7), a removal is confirmed with its count.
function cleanupResult(d, baseText) {
  const c = d && d.cleanup;
  if (c && c.warning) {
    return { kind: 'warn', text: `${baseText} The source knowledge was NOT removed: ${c.warning} — the entries remain in the team KB.` };
  }
  if (c && c.removed > 0) {
    return { kind: 'ok', text: `${baseText} Removed ${c.removed} source ${c.removed === 1 ? 'entry' : 'entries'} from the team KB.` };
  }
  return { kind: 'ok', text: baseText };
}

function ActivateNowCheckbox({ id, checked, onChange, label, description }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <input type="checkbox" id={id} checked={checked} onChange={e => onChange(e.target.checked)} style={{ marginTop: 3, flexShrink: 0 }} />
      <div>
        <label htmlFor={id} style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', cursor: 'pointer' }}>{label}</label>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 2, lineHeight: 1.5 }}>
          {description || (
            <>Copies the skill into every member's workspace and adds it to the team's active skills.
              Members with their own skill list are excluded — add them afterwards from the skill card.</>
          )}
        </div>
      </div>
    </div>
  );
}

const resultNotice = (result) => (
  <div style={{
    fontSize: 'var(--eb-text-sm)', fontWeight: 600,
    color: result.kind === 'ok' ? 'var(--eb-status-success)' : 'var(--eb-status-warning)',
  }}>
    {result.kind === 'ok' ? '✓ ' : '⚠ '}{result.text}
  </div>
);

/* ── Promotion dialog (unchanged mechanics: draft → confirm → promote) ────────── */

function PromotionDialog({ suggestion, teamId, teamSkills, onClose, onDone }) {
  const [name, setName] = useState(suggestion.draft?.name || '');
  const [skillMd, setSkillMd] = useState(suggestion.draft?.skillMd || '');
  const [tier, setTier] = useState('team');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [activateNow, setActivateNow] = useState(true);
  // #559: pre-ticked "remove the source knowledge, now captured in this skill".
  // Default = remove, so the KB stays lean; the operator can untick to keep it.
  const [removeSource, setRemoveSource] = useState(true);
  const [result, setResult] = useState(null); // combined promote+activate outcome
  // Create a NEW skill (default) vs extend an EXISTING one (issue #553). When the
  // converged cluster auto-matches a skill (AC4) we open straight in extend mode
  // with that skill pre-selected — the operator can always switch back.
  const [mode, setMode] = useState(suggestion.matchedSkill ? 'extend' : 'create');
  const [targetName, setTargetName] = useState(suggestion.matchedSkill?.name || '');
  const [skills, setSkills] = useState([]); // all eligible skills (every source/tier)

  // manual = operator multi-select (no stored suggestion); aggregated = the
  // lessons are distinct and the skill is their synthesis (manual OR the
  // collector's related-theme card).
  const manual = !suggestion.id;
  const aggregated = manual || suggestion.source === 'related';
  const memberTexts = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const m of suggestion.members || []) {
      const t = (m && typeof m.text === 'string' ? m.text.trim() : '');
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
    return out;
  }, [suggestion.members]);
  const lessonN = suggestion.lessonCount || memberTexts.length;
  // A single ad-hoc lesson (issue #619): the "combine" copy would read wrong
  // ("Combine 1 lessons"), so the title/body/button switch to singular phrasing.
  const single = aggregated && lessonN <= 1;

  // The Skills column's own nodes (issue #620, AC5): the ONE definition of "this
  // team's skills" shared with the graph builder + activation overlay. Deduped by
  // name, they include team-owned skills AND global skills the team has adopted or
  // promoted — the very skills the old `source==='team'` filter dropped (AC3).
  const columnSkills = Array.isArray(teamSkills) ? teamSkills : [];

  // Skills eligible as an extend target. Team-tier (AC3): every skill the column
  // shows — each carrying its INTRINSIC scope (a global-pool file is 'global'
  // even when the team merely adopted/promoted it). Global-tier (AC6, unchanged):
  // the full global pool, so any global skill stays extendable. Falls back to the
  // fetched team list if the column nodes weren't threaded in (defensive).
  const eligible = useMemo(() => {
    if (tier === 'team') {
      const fromColumn = columnSkills.map(n => ({
        name: n.label,
        scope: n.tier === 'global' ? 'global' : 'team',
      }));
      if (fromColumn.length) return fromColumn;
      return skills
        .filter(s => s.source === 'team' && s.teamId === teamId)
        .map(s => ({ name: s.name, scope: 'team' }));
    }
    return skills.filter(s => s.source === 'pool').map(s => ({ name: s.name, scope: 'global' }));
  }, [skills, tier, teamId, columnSkills]);
  const canExtend = eligible.length > 0;

  // The selected target's INTRINSIC scope drives the effective promotion scope: a
  // team-tier extend of a global/adopted skill still writes the global pool file
  // (validateExtension allows team→global). Create stays governed by the tier
  // chip. This is the `to`/`tier` sent to extend-draft + promote.
  const selectedTarget = eligible.find(s => s.name === targetName) || null;
  const effectiveTo = mode === 'extend'
    ? (tier === 'team' ? (selectedTarget?.scope || 'team') : 'global')
    : tier;
  // AC4: extending a global/adopted skill from the "team only" chip affects every
  // team — surface it explicitly so the operator can't do it unaware.
  const globalScopeWarning = mode === 'extend' && tier === 'team' && selectedTarget?.scope === 'global';

  // Load the tier-scoped skill catalogue once so the picker + AC8 fallback know
  // whether any extend target exists.
  useEffect(() => {
    fetch(`/api/skills?teamId=${encodeURIComponent(teamId)}`)
      .then(r => (r.ok ? r.json() : []))
      .then(list => setSkills(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [teamId]);

  // AC8: extend is only offered when a target exists for the tier — fall back to
  // create cleanly if the current tier has none (e.g. after switching tiers).
  useEffect(() => {
    if (mode === 'extend' && !canExtend) setMode('create');
  }, [mode, canExtend]);
  // A tier switch can invalidate the selected target — drop it if it no longer fits.
  useEffect(() => {
    setTargetName(t => (eligible.some(s => s.name === t) ? t : ''));
  }, [eligible]);

  // Re-synthesise the chosen existing skill + the new knowledge into an editable
  // preview (AC5). Heuristic by default (instant); `useLLM` runs the LLM merge.
  const loadExtendDraft = (useLLM) => {
    if (!targetName) return;
    setBusy('draft'); setError('');
    fetch('/api/knowledge/extend-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team: teamId, tier: effectiveTo, targetName,
        ...(suggestion.id ? { suggestionId: suggestion.id } : { entryIds: suggestion.entryIds }),
        ...(useLLM ? {} : { heuristicOnly: true }),
      }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.draft?.skillMd) setSkillMd(d.draft.skillMd); })
      .catch(() => setError('Draft failed'))
      .finally(() => setBusy(''));
  };

  // Manual combine opens without a draft — prefill instantly with the cheap
  // heuristic one so the operator never faces an empty SKILL.md (create mode only).
  useEffect(() => {
    if (!manual || mode !== 'create') return;
    setBusy('draft');
    fetch('/api/knowledge/draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: teamId, entryIds: suggestion.entryIds, heuristicOnly: true }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.draft) {
          setSkillMd(md => md || d.draft.skillMd || '');
          setName(n => n || d.draft.name || '');
        }
      })
      .catch(() => {})
      .finally(() => setBusy(''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When extending, (re)load the merged preview as the target or tier changes.
  useEffect(() => {
    if (mode === 'extend' && targetName) loadExtendDraft(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetName, tier]);

  const draftWithAI = () => {
    if (mode === 'extend') { loadExtendDraft(true); return; }
    setBusy('draft'); setError('');
    const req = manual
      ? fetch('/api/knowledge/draft', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ team: teamId, entryIds: suggestion.entryIds }),
        })
      : fetch(`/api/knowledge/promotion-suggestions/${encodeURIComponent(suggestion.id)}/draft`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ team: teamId }),
        });
    req
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.draft?.skillMd) { setSkillMd(d.draft.skillMd); if (d.draft.name) setName(d.draft.name); } })
      .catch(() => setError('Draft failed'))
      .finally(() => setBusy(''));
  };

  const promote = () => {
    setBusy('promote'); setError('');
    // Extend an existing skill: the backend re-synthesises provenance (union) and
    // auto-syncs the refreshed content to agents that already have it (AC10), so
    // there is no separate activation step here.
    if (mode === 'extend') {
      fetch('/api/knowledge/promote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'extend', from: 'team', to: effectiveTo, teamId, targetName, skillMd,
          entryIds: suggestion.entryIds, removeSourceKnowledge: removeSource,
          ...(suggestion.id ? { suggestionId: suggestion.id } : {}),
        }),
      })
        .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); })
        .then(d => setResult(cleanupResult(d, `Extended “${targetName}” — active agents pick up the update automatically.`)))
        .catch(e => setError(e.message))
        .finally(() => setBusy(''));
      return;
    }
    fetch('/api/knowledge/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'team', to: tier, teamId, name, skillMd,
        entryIds: suggestion.entryIds, removeSourceKnowledge: removeSource,
        ...(suggestion.id ? { suggestionId: suggestion.id } : {}),
      }),
    })
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); })
      .then(d => {
        // Promotion succeeded — never rolled back or reported failed from here on.
        const cleanup = d && d.cleanup;
        if (!activateNow) {
          // Legacy behaviour when there is nothing extra to report: close + reload.
          if (cleanup) { setResult(cleanupResult({ cleanup }, 'Promoted.')); setBusy(''); }
          else { onDone(); }
          return;
        }
        return activateSkill(teamId, name.trim())
          .then(a => setResult(cleanupResult(cleanup ? { cleanup } : null, `Promoted and ${activationSummary(a)}.`)))
          .catch(e => setResult({ kind: 'warn', text: `Promoted — but activation failed: ${e.message}. Use the Activate button on the skill card.` }))
          .finally(() => setBusy(''));
      })
      .catch(e => { setError(e.message); setBusy(''); });
  };

  const dismiss = () => {
    setBusy('dismiss');
    fetch(`/api/knowledge/promotion-suggestions/${encodeURIComponent(suggestion.id)}/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: teamId }),
    }).catch(() => {}).finally(() => onDone());
  };

  // After a successful promote (result set) any close path must run onDone so
  // the parent reloads — the promotion happened even if the dialog is dismissed.
  const close = result ? onDone : onClose;

  return (
    <div onClick={close} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={{ ...dialog, width: 640, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          {aggregated && !single
            ? <Combine size={18} style={{ color: 'var(--eb-status-warning)' }} />
            : <Sparkles size={18} style={{ color: 'var(--eb-status-warning)' }} />}
          <h2 style={{ margin: 0, fontSize: 'var(--eb-text-lg)', color: 'var(--eb-text-primary)' }}>
            {single
              ? 'Turn this lesson into a skill'
              : aggregated
                ? `Combine ${lessonN} lessons into a skill`
                : 'Turn this knowledge into a skill'}
          </h2>
          <button onClick={close} style={{ ...btn, marginLeft: 'auto' }}><X size={14} /></button>
        </div>

        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
          A skill is a reusable instruction file (SKILL.md) that agents load automatically at the
          start of their work. {aggregated && !single
            ? 'The selected lessons are synthesised into one coherent instruction — “Draft with AI” organises and generalises them for you.'
            : 'Give it a name, check the instructions — “Draft with AI” writes them from the learned knowledge — and choose who should get it.'}
        </div>

        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}
          title={single ? 'The agent whose lesson this is' : aggregated ? 'The agents whose lessons are being combined' : 'Which agents learned this, independently of each other'}>
          {single
            ? <>From {(suggestion.convergence || []).join(', ') || 'unknown'}</>
            : aggregated
              ? <>Combining {lessonN} lessons · from {(suggestion.convergence || []).join(', ') || 'unknown'}</>
              : <>Learned {suggestion.convergenceCount}× independently · by {(suggestion.convergence || []).join(', ')}</>}
        </div>
        <div style={{
          fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', background: 'var(--eb-bg-app)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
          maxHeight: 180, overflowY: 'auto',
        }}>
          {aggregated && memberTexts.length > 1 ? (
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {memberTexts.map((t, i) => <li key={i} style={{ wordBreak: 'break-word' }}>{t}</li>)}
            </ul>
          ) : (
            suggestion.text
          )}
        </div>

        <label style={lbl}>Add this knowledge to</label>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <Chip active={mode === 'create'} title="Create a brand-new skill from this knowledge" onClick={() => setMode('create')}>Create a new skill</Chip>
          {canExtend && (
            <Chip active={mode === 'extend'} title="Fold this knowledge into a skill that already exists" onClick={() => setMode('extend')}>Add to an existing skill</Chip>
          )}
        </div>

        <label style={lbl}>Who gets this skill?</label>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <Chip active={tier === 'team'} title="Only this team’s agents load it" onClick={() => setTier('team')}>Team skill — this team only</Chip>
          <Chip active={tier === 'global'} title="Agents in every team load it" onClick={() => setTier('global')}>Global skill — all teams</Chip>
        </div>

        {mode === 'create' ? (
          <>
            <label style={lbl}>Skill name</label>
            <input value={name} onChange={e => setName(e.target.value)} style={inp} />
          </>
        ) : (
          <>
            <label style={lbl}>Existing skill to extend</label>
            <select value={targetName} onChange={e => setTargetName(e.target.value)} style={inp}>
              <option value="">Select a skill…</option>
              {eligible.map(s => (
                <option key={s.name} value={s.name}>
                  {s.name}{s.scope === 'global' ? ' — global (all teams)' : ''}{suggestion.matchedSkill?.name === s.name ? ' — suggested' : ''}
                </option>
              ))}
            </select>
            {globalScopeWarning && (
              <div style={{
                fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', lineHeight: 1.5,
                background: 'var(--eb-bg-app)', border: '1px solid var(--eb-status-warning)',
                borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
              }}>
                <strong>“{targetName}” is a global skill</strong> — shared with every team. Extending it here
                updates it for <strong>all teams</strong>, not just this one.
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <label style={lbl}>Skill instructions (SKILL.md)</label>
          <button onClick={draftWithAI} disabled={!!busy} title="Let AI write the instructions from the learned knowledge — you can edit the result" style={{ ...btn, marginLeft: 'auto' }}>
            <Wand2 size={13} /> {busy === 'draft' ? 'Drafting…' : 'Draft with AI'}
          </button>
        </div>
        <textarea value={skillMd} onChange={e => setSkillMd(e.target.value)} rows={12}
          style={{ ...inp, fontFamily: 'var(--eb-font-mono, monospace)', fontSize: 'var(--eb-text-xs)', resize: 'vertical' }} />

        {/* Activation is the default last step of a CREATE promotion. An extend
            re-synthesises an already-pooled skill; its refreshed content is
            auto-synced to every agent that currently has it active (AC10), so
            there is no activation choice to make. */}
        {mode === 'create' && (tier === 'team' || tier === 'global') && !result && (
          <ActivateNowCheckbox
            id="kf-promote-activate"
            checked={activateNow}
            onChange={setActivateNow}
            label="Activate for the team immediately"
          />
        )}
        {mode === 'extend' && !result && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
            The refreshed skill is synced automatically to agents that already have “{targetName || 'this skill'}” active.
          </div>
        )}

        {/* #559: pre-ticked cleanup — remove the source knowledge from the team KB
            once the skill is written. Shown for BOTH create and extend (AC2). The
            removal is reversible (the entries are archived, not deleted), so the
            skill→knowledge trace is preserved. */}
        {!result && (
          <ActivateNowCheckbox
            id="kf-promote-remove-source"
            checked={removeSource}
            onChange={setRemoveSource}
            label="Remove the source knowledge from the team KB (now captured in this skill)"
            description="Keeps the knowledge base lean — the source entries are archived (recoverable, not deleted) and drop out of the live feed, search and digest. This skill keeps its link to them. Untick to keep the entries in the KB."
          />
        )}

        {error && <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-xs)' }}>{error}</div>}
        {result && resultNotice(result)}

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end' }}>
          {result ? (
            <button onClick={onDone} style={primaryBtn}>Close</button>
          ) : (
            <>
              {!manual && (
                <button onClick={dismiss} disabled={!!busy} title="Don’t promote — the suggestion goes away, the knowledge itself stays in the team KB" style={btn}>Dismiss</button>
              )}
              {manual && (
                <button onClick={onClose} disabled={!!busy} style={btn}>Cancel</button>
              )}
              <button
                onClick={promote}
                disabled={!!busy || !skillMd.trim() || (mode === 'extend' ? !targetName : !name.trim())}
                style={primaryBtn}
              >
                <Check size={14} /> {
                  busy === 'promote'
                    ? (mode === 'extend' ? 'Adding…' : 'Promoting…')
                    : mode === 'extend'
                      ? `Add to ${targetName || 'skill'}`
                      : (aggregated && !single) ? `Create combined ${tier} skill` : `Promote to ${tier}`
                }
              </button>
            </>
          )}
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
  const [activateNow, setActivateNow] = useState(true);
  const [result, setResult] = useState(null); // combined share+activate outcome

  const share = () => {
    setBusy(true); setErr('');
    fetch('/api/knowledge/share-to-team', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sourceIsTeam ? 'team' : 'global', name, sourceTeamId, targetTeamId: target }),
    })
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'share failed'); return d; })
      .then(() => {
        // Share succeeded — never rolled back or reported failed from here on.
        if (!activateNow) { onDone(); return; }
        return activateSkill(target, name)
          .then(d => setResult({ kind: 'ok', text: `Shared and ${activationSummary(d)}.` }))
          .catch(e => setResult({ kind: 'warn', text: `Shared — but activation failed: ${e.message}. Use the Activate button on the skill card.` }))
          .finally(() => setBusy(false));
      })
      .catch(e => { setErr(e.message); setBusy(false); });
  };

  // After a successful share, any close path must run onDone so the parent reloads.
  const close = result ? onDone : onClose;

  return (
    <div onClick={close} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...dialog, width: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--eb-space-3)' }}>
          <Share2 size={16} style={{ color: 'var(--eb-accent-primary)' }} />
          <span style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>Share skill to a team</span>
          <button onClick={close} style={{ marginLeft: 'auto', ...btn, padding: 4 }}><X size={14} /></button>
        </div>
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-3)' }}>
          Copy <strong>{name}</strong> ({node.tier} skill) into another team’s pool. Provenance is preserved and the share is stamped.
        </div>
        <label style={lbl}>Target team</label>
        <select value={target} onChange={e => setTarget(e.target.value)} disabled={!!result} style={{ ...inp, marginTop: 4 }}>
          {options.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {!result && (
          <div style={{ marginTop: 'var(--eb-space-3)' }}>
            <ActivateNowCheckbox
              id="kf-share-activate"
              checked={activateNow}
              onChange={setActivateNow}
              label="Activate for the target team immediately"
            />
          </div>
        )}
        {err && <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-xs)', marginTop: 'var(--eb-space-2)' }}>{err}</div>}
        {result && <div style={{ marginTop: 'var(--eb-space-2)' }}>{resultNotice(result)}</div>}
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end', marginTop: 'var(--eb-space-3)' }}>
          {result ? (
            <button onClick={onDone} style={primaryBtn}>Close</button>
          ) : (
            <>
              <button onClick={onClose} disabled={busy} style={btn}>Cancel</button>
              <button onClick={share} disabled={busy || !target} style={primaryBtn}>
                <Share2 size={13} /> {busy ? 'Sharing…' : 'Share'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────────────── */

function Chip({ active, onClick, title, children }) {
  return (
    <button onClick={onClick} title={title} style={{
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

const linkBtn = {
  flexShrink: 0, background: 'none', border: 'none', padding: 0,
  color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-xs)',
  cursor: 'pointer', whiteSpace: 'nowrap',
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
