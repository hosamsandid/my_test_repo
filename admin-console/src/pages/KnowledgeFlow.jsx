import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import {
  Brain, RefreshCw, X, ExternalLink, GitBranch, Sparkles, Check, Wand2,
  Archive, Share2, ShieldCheck, Ban, MessageSquare, Search, ArrowRight, Users,
  Combine, Trash2, MoreHorizontal, FileText,
  Inbox, Filter, RotateCcw, CheckCircle2, Circle, Play, SkipForward, Layers,
  Pencil, Loader2,
} from 'lucide-react';
import InfoTip from '../components/InfoTip';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import SkillMarkdown from '../components/SkillMarkdown';
import PublishSkillAction from '../components/PublishSkillAction';
import KnowledgeLearningSections, {
  AUTONOMY_LEVELS, GATE_ORDER, GATE_LABELS, GATE_TIPS, PanelSection,
} from '../components/KnowledgeLearningConfig';
import useSSE from '../hooks/useSSE';
import { useHelpSubject } from '../context/HelperChatContext';
import { OVERLAY_KNOWLEDGE_CONFIG, OVERLAY_KNOWLEDGE_SKILL } from '../context/page-help-view.js';
import { KNOWLEDGE_HELP_SECTIONS } from './knowledge-help-sections.js';
import { assistFetch } from '../context/assist-transport.js';
import { parseTeamParam, resolveSelectedTeam, teamTotals, streamScopeUrl } from './knowledge-scope';
import { summarizeActivation } from './knowledge-activation-view';
import { rolloutStatus } from './skill-rollout-view';
import {
  partitionSkills, tabCounts, buildInbox, skillMatchesQuery, hasNewEvidence,
  INBOX_CAP, SUGGESTION_SOURCES,
} from './skill-inbox-view';
import {
  PHASE_LABELS, nextPendingDomain, migrationProgress,
  isResumable, mergeForDomain, planDomainRows, planFoldTotals,
  consolidationStartGate,
} from './consolidation-view';
import { hasFrontmatterMeta, syncFrontmatterName, suggestFreeName } from './promotion-frontmatter';
import { lastUsedLabel, compareLastUsed } from './knowledge-retrieval-view';
import { createFeedReloadThrottle } from './knowledge-reload-throttle.js';

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

// Combine several promotion SUGGESTIONS into one ad-hoc candidate for the merge
// basket (#776 §2). Like manualSuggestionFrom but the inputs are candidates, not
// raw KB items: union their entryIds / members / convergence so the promotion
// dialog seeds from every lesson, and carry `suggestionIds` so the promote path
// marks ALL merged cards promoted server-side (they all leave the inbox).
function mergeSuggestionsInto(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  if (arr.length === 0) return null;
  const entryIds = [...new Set(arr.flatMap(s => Array.isArray(s.entryIds) ? s.entryIds : []))];
  const members = [];
  const seen = new Set();
  for (const s of arr) {
    for (const m of (Array.isArray(s.members) ? s.members : [])) {
      const key = m && m.id ? m.id : JSON.stringify(m);
      if (seen.has(key)) continue;
      seen.add(key);
      members.push(m);
    }
  }
  const convergence = [...new Set(arr.flatMap(s => Array.isArray(s.convergence) ? s.convergence : []))].sort();
  return {
    id: null, // ad-hoc: server rebuilds provenance from the union of entry ids
    source: 'related',
    text: arr.map(s => s.text).filter(Boolean).join(' • '),
    entryIds,
    members,
    convergence,
    convergenceCount: convergence.length,
    lessonCount: members.length || entryIds.length,
    suggestionIds: arr.map(s => s.id).filter(Boolean),
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
  // #842: incremented on each `consolidation` feed event so ConsolidationPanel re-reads.
  const [consolidationSignal, setConsolidationSignal] = useState(0);
  const [promoting, setPromoting] = useState(null); // { suggestion, teamId }
  const [sharing, setSharing] = useState(null); // { node, teamId }
  const [retiring, setRetiring] = useState(null); // { item, teamId } — retire-learning confirm
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
      // #780: the team's skill domains + soft skill-budget state.
      fetch(`/api/knowledge/domains?team=${enc}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
    ];
    return Promise.all(gets).then(async ([graph, gates, sugg, review, domains]) => {
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
          domains: domains && domains.doc ? domains.doc.domains : [],
          skillBudget: domains ? domains.budget : null,
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
    setSelected(null); setDetail(null); setPromoting(null); setSharing(null); setRetiring(null);
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
  // #571: throttled to one graph reload per team per ~8 s while events stream
  // (always with a trailing reload), none while the tab is hidden and one
  // catch-up when it is visible again (knowledge-reload-throttle.js). Reloads
  // after the user's own mutations call loadTeamData directly and stay immediate.
  const feedReloadRef = useRef(null);
  feedReloadRef.current = (teamId) => {
    const t = (teams || []).find(x => x.id === teamId);
    loadTeamData(teamId, t ? t.members : [], { withPrivate: false });
  };
  const feedThrottleRef = useRef(null);
  useEffect(() => {
    const throttle = createFeedReloadThrottle({
      reload: (teamId) => feedReloadRef.current(teamId),
      isHidden: () => document.hidden === true,
    });
    feedThrottleRef.current = throttle;
    let prevHidden = document.hidden === true;
    const onVisibility = () => {
      const nextHidden = document.hidden === true;
      throttle.visibilityChanged(prevHidden, nextHidden);
      prevHidden = nextHidden;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      throttle.dispose();
      feedThrottleRef.current = null;
    };
  }, []);
  const scheduleTeamReload = useCallback((teamId) => {
    if (!teamId || !feedThrottleRef.current) return;
    feedThrottleRef.current.request(teamId);
  }, []);

  const onFeedEvent = useCallback((ev) => {
    if (!ev || !ev.teamId) return;
    // The stream is already scoped to the selected team, but ignore anything
    // that isn't the team currently in view as belt-and-braces.
    if (ev.teamId !== selectedTeam) return;
    if (ev.type === 'harvest' && ev.entry?.id) {
      setPulseId(ev.entry.id);
      setTimeout(() => setPulseId(p => (p === ev.entry.id ? null : p)), 1000);
    }
    // #842: a consolidation-migration step — bump the signal so the panel re-reads
    // its progress state, and reload team data so the collapse shows live (AC3/AC4).
    if (ev.type === 'consolidation') setConsolidationSignal(s => s + 1);
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

  // #916: set/clear an entry's validity window ("this stops being true on X" —
  // distinct from Retire). Reload posture mirrors archiveItem.
  const setItemValidity = useCallback((id, teamId, validTo) => {
    return fetch(`/api/knowledge/item/${encodeURIComponent(id)}/validity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, validTo }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(() => {
        setSelected(null); setDetail(null);
        const t = (teams || []).find(x => x.id === teamId);
        return loadTeamData(teamId, t ? t.members : [], { withPrivate: false });
      })
      .catch(() => {});
  }, [teams, loadTeamData]);

  // #917: persist an entry's auto-load triggers; reload posture mirrors
  // setItemValidity, but keeps the detail rail open (re-fetches the item).
  const setItemTriggers = useCallback((id, teamId, loadTriggers) => {
    return fetch(`/api/knowledge/item/${encodeURIComponent(id)}/triggers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, loadTriggers }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(() => {
        const t = (teams || []).find(x => x.id === teamId);
        loadTeamData(teamId, t ? t.members : [], { withPrivate: false });
        return openItem(id, teamId);
      })
      .catch(() => {});
  }, [teams, loadTeamData, openItem]);

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
        const r = await assistFetch('/api/knowledge/summaries/backfill', {
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
        {/* The page's shared "?" — chapter 1 of the topic, which is the
            Memory/Knowledge/Skills distinction the whole page is built around.
            The Shell supplies the <h1>, so this sits with the header row's own
            icon rather than next to a title (#1985; the affordance itself was
            lost in the #1847 header merge). */}
        <PageHelpButton label="Help for Knowledge" section={KNOWLEDGE_HELP_SECTIONS.page} />
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
          onClick={onRefresh}
          title={selectedTeam ? 'Reload this team’s knowledge' : 'Reload the team list'}
          style={{ ...btn, marginLeft: 'auto' }}>
          <RefreshCw size={14} className={loading ? 'kf-spin' : undefined} /> Refresh
        </button>
      </div>
      <div style={{ padding: '2px 0 var(--eb-space-2)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
        Your agents write down what they learn while working. Watch those lessons become shared team knowledge — and decide what turns into reusable skills.
      </div>

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
          onClick={() => setFilters(f => ({ ...f, showArchived: !f.showArchived }))}>Show retired &amp; expired</Chip>
      </div>
      )}

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, borderTop: '1px solid var(--eb-border-default)' }}>
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--eb-bg-app)', padding: 'var(--eb-space-4) 0' }}>
          {teams === null ? (
            <div aria-busy="true" style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--eb-text-muted)' }}>
              <Loader2 size={14} className="kf-spin" aria-hidden="true" /> Loading…
            </div>
          ) : teams.length === 0 ? (
            <div style={{ color: 'var(--eb-text-muted)' }}>No agents yet — create a team and its agents will start learning.</div>
          ) : !selectedTeamObj ? (
            <ChooseTeam />
          ) : loading ? (
            <TeamKnowledgeSkeleton />
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
              consolidationSignal={consolidationSignal}
              selectedId={selected?.teamId === selectedTeamObj.id ? selected.id : null}
              onOpenItem={openItem}
              onRetireItem={(item) => setRetiring({ item, teamId: selectedTeamObj.id })}
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
              onValidity={(id, teamId, validTo) => setItemValidity(id, teamId ?? selected.teamId, validTo)}
              onTriggers={(id, teamId, loadTriggers) => setItemTriggers(id, teamId ?? selected.teamId, loadTriggers)}
              onOpenItem={(id, teamId) => openItem(id, teamId ?? selected.teamId)}
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
      <ConfirmDialog
        open={!!retiring}
        title="Retire learning"
        variant="warning"
        confirmLabel="Retire"
        message={retiring ? (
          <>
            Retire this learning from the shared knowledge base?
            <blockquote style={{ margin: 'var(--eb-space-2) 0 0', paddingLeft: 'var(--eb-space-3)', borderLeft: '2px solid var(--eb-border-default)', color: 'var(--eb-text-primary)', fontStyle: 'italic' }}>
              “{retiring.item.text}”
            </blockquote>
            <span style={{ display: 'block', marginTop: 'var(--eb-space-2)' }}>It stays in git for audit and can be un-retired at any time.</span>
          </>
        ) : ''}
        onConfirm={() => { archiveItem(retiring.item.id, retiring.teamId, true); setRetiring(null); }}
        onCancel={() => setRetiring(null)}
      />
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

/* ── Loading skeleton shown while the selected team's knowledge is fetching ──── */
// Follows the canonical pattern of adjacent pages (McpServers.jsx, TokenUsage.jsx):
// a fixed-height elevated block carrying aria-busy so screen readers announce the
// wait. Shown on first team select and on every team switch until the fetch settles.

function TeamKnowledgeSkeleton() {
  return (
    <div
      aria-busy="true"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)',
        height: 240, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)',
        color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
      }}>
      <Loader2 size={16} className="kf-spin" aria-hidden="true" /> Loading team knowledge…
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
  team, data, filters, pulseId, selectedId, consolidationSignal,
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
  const domains = data?.domains || [];
  const skillBudget = data?.skillBudget || null;
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
        <CurationHealthStrip teamId={team.id} />
      </div>

      {/* Learning controls — visible, on the team they govern, with feedback */}
      {gates && <ControlStrip teamId={team.id} gates={gates} onChanged={onControlsChanged} />}

      {/* The flow: three columns joined by arrows */}
      {/* Column ratio (#727): the middle "Team knowledge" column is capped so it
          no longer grows unbounded on wide screens, and the Skills column takes a
          flexible share (min 300px, well past the old hard 260px cap) so skill
          names stay readable at typical/wide viewports. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) 20px minmax(0, 720px) 20px minmax(300px, 1fr)', gap: 0, padding: 'var(--eb-space-3) var(--eb-space-4) var(--eb-space-4)' }}>
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
            trailing={(
              <>
                {agentFilter && (
                  <Chip active title="Clear this filter" onClick={() => setAgentFilter(null)}>only {agentFilter} ✕</Chip>
                )}
                {/* The list is where the `digest` badges show up, so its "?" opens
                    the chapter that explains what being in the digest buys — and
                    that everything outside it is still searchable. Outside the
                    agentFilter branch above: the question is asked about the
                    unfiltered list at least as often (#1985). */}
                <PageHelpButton
                  label="How the digest picks what is always in context"
                  size={13}
                  section={KNOWLEDGE_HELP_SECTIONS.digest}
                />
              </>
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
                retrievalOn={!!graph?.retrievalStats}
              />
            ))
          )}
        </div>

        <FlowArrow />

        {/* Skills — lifecycle tabs + suggestion inbox (#775) */}
        <div>
          <ColHeader
            label="Skills"
            hint="proven & reusable"
            tip={{
              title: 'Promoted knowledge',
              text: 'Knowledge that proved important, packaged as a reusable instruction file agents load automatically when they work. Team skills serve this team; a skill can also be shared with other teams.',
            }}
          />
          <SkillsColumn
            team={team}
            skills={skills}
            suggestions={suggestions}
            pending={pending}
            autonomy={autonomy}
            domains={domains}
            skillBudget={skillBudget}
            onReviewSuggestion={onReviewSuggestion}
            onShareSkill={onShareSkill}
            onControlsChanged={onControlsChanged}
            lessons={allItems.map(i => i.text).filter(Boolean)}
            consolidationSignal={consolidationSignal}
          />
          {privateSkills.length > 0 && (
            <PrivateSkillsBlock teamId={team.id} skills={privateSkills} onLifted={onLifted} />
          )}
          <GlobalSkillPicker teamId={team.id} activeNames={activeSkillNames} onReload={onControlsChanged} />
        </div>
      </div>
    </section>
  );
});

/* ── Skills column: lifecycle tabs + suggestion inbox (#775) ────────────────── */

const SKILL_TABS = [
  ['inuse', 'In use', 'Skills active on this team — agents load them when they work.'],
  ['ready', 'Ready', 'Promoted into the team library but not activated yet.'],
  ['suggested', 'Suggested', 'Knowledge the collector thinks is worth turning into a skill.'],
];

/* ── Skill domains + budget (#780/#841, skill-aggregation Phase 2) ───────────── */

const DOMAIN_SCOPES = ['team', 'role', 'cross-role'];
const parseRolesInput = (s) => Array.from(new Set(
  String(s || '').split(',').map(r => r.trim()).filter(Boolean),
));

// Shared layout for a domain row's name cell and its trailing controls (#856).
// The name truncates with an ellipsis instead of wrapping character-by-character
// (`minWidth: 0` lets it shrink inside the flex row; `nowrap`+`overflow:hidden`
// stops the one-letter-per-line stack the old `overflowWrap: 'anywhere'` produced
// once the column was crushed). The controls group never shrinks and wraps onto a
// second line when the rail is too narrow, so tags/scope/actions stay reachable
// without crushing the name. Full name is preserved in the element `title`.
const domainNameCell = {
  flex: '1 1 10rem', minWidth: '7rem',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const domainRowControls = {
  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
  flexWrap: 'wrap', flex: '0 0 auto', maxWidth: '100%',
};

// Render a domain's audience roles as small pills (mirrors the skill cards' "for:"
// tags — the same roles[] drives both via the server-side augmentSkillRoles overlay).
function DomainRoleTags({ roles }) {
  if (!Array.isArray(roles) || roles.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {roles.map(r => (
        <span key={r} style={{
          fontSize: 10, padding: '0 6px', borderRadius: 'var(--eb-radius-full)',
          border: '1px solid var(--eb-border-default)', color: 'var(--eb-text-secondary)',
        }}>{r}</span>
      ))}
    </span>
  );
}

// A compact panel over the team's persistent skill domains — the routing targets
// converged clusters are classified against — plus the soft skill-budget bar
// (§3.5, AC5). Operator ops post to /api/knowledge/domains (domain changes are always
// a human decision): seed, LLM bootstrap (proposed → confirm), add, edit scope/roles,
// merge (≥2 → 1), split (1 → ≥2), remove. Collapsible; hidden when a team carries no
// domains yet and the operator hasn't expanded it.
function DomainsPanel({ teamId, domains, budget, lessons, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState(null);   // { id, name, scope, roles(csv) }
  const [proposal, setProposal] = useState(null);  // { proposed:[...], fallback:bool }
  const [selected, setSelected] = useState(() => new Set()); // ids picked for merge
  const [merging, setMerging] = useState(null);    // { name, scope }
  const [splitting, setSplitting] = useState(null); // { id, name, parts:[{name,scope}] }
  const [overBudgetAsk, setOverBudgetAsk] = useState(null); // { budget, added, resolve }
  const list = Array.isArray(domains) ? domains : [];

  // Post an op. `reload:false` (bootstrap) skips onChanged since nothing is persisted.
  // Returns the parsed response so callers can read `proposed`/`fallback`.
  // `assistFetch` injects the header-selected assist model (#1214: the `bootstrap`
  // op runs an LLM synthesis in the orchestrator, so it must carry the selection;
  // the other ops are deterministic and ignore the header server-side).
  // #2592 (AC10): every domain grows into one skill, so adding domains at or over
  // the soft skill budget answers 409 `over-budget` — ask, and only on an explicit
  // yes re-send with `overBudgetConfirmed`. Declining leaves the taxonomy untouched.
  const post = useCallback((body, { reload = true } = {}) => {
    setBusy(true); setErr('');
    const send = (extra) => assistFetch('/api/knowledge/domains', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, ...body, ...extra }),
    }).then(r => r.json().catch(() => ({})));
    return send({}).then((out) => {
      if (!out || out.error !== 'over-budget') return out;
      return new Promise((resolve) => {
        setOverBudgetAsk({ budget: out.budget || {}, added: out.added || 1, resolve });
      }).then((ok) => {
        if (!ok) throw new Error('Not added — over the skill budget');
        return send({ overBudgetConfirmed: true });
      });
    }).then((out) => {
      if (!out || out.ok !== true) throw new Error((out && out.error) || 'failed');
      if (reload && onChanged) onChanged();
      return out;
    }).catch((e) => { setErr(e.message || 'failed'); throw e; }).finally(() => setBusy(false));
  }, [teamId, onChanged]);

  const over = budget && budget.over;
  const pct = budget && budget.cap ? Math.min(100, Math.round((budget.used / budget.cap) * 100)) : 0;

  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Persist a scope/roles/name edit. There is no per-field backend op (rename only
  // touches the name), so the edit goes through `confirm` with the full domain list —
  // the taxonomy's canonical "set the domains to this" op — with the one row patched.
  const saveEdit = () => {
    const name = editing.name.trim();
    if (!name) { setErr('name-required'); return; }
    const next = list.map(d => (d.id === editing.id
      ? { ...d, name, scope: editing.scope, roles: parseRolesInput(editing.roles) }
      : d));
    post({ op: 'confirm', domains: next }).then(() => setEditing(null)).catch(() => {});
  };

  const runBootstrap = () => {
    post({ op: 'bootstrap', lessons: Array.isArray(lessons) ? lessons : [] }, { reload: false })
      .then((out) => setProposal({ proposed: out.proposed || [], fallback: out.fallback === true }))
      .catch(() => {});
  };
  const confirmProposal = () => {
    post({ op: 'confirm', domains: proposal.proposed }).then(() => setProposal(null)).catch(() => {});
  };

  const runMerge = () => {
    post({
      op: 'merge', ids: Array.from(selected),
      name: merging.name.trim() || undefined, scope: merging.scope || undefined,
    }).then(() => { setMerging(null); setSelected(new Set()); }).catch(() => {});
  };

  const runSplit = () => {
    const parts = splitting.parts.filter(p => p.name.trim())
      .map(p => ({ name: p.name.trim(), scope: p.scope }));
    post({ op: 'split', id: splitting.id, parts }).then(() => setSplitting(null)).catch(() => {});
  };
  const splitReady = splitting && splitting.parts.filter(p => p.name.trim()).length >= 2;

  return (
    <div style={{
      marginBottom: 'var(--eb-space-3)', border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)', background: 'var(--eb-bg-surface)', padding: 'var(--eb-space-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}>
        <strong style={{ fontSize: 'var(--eb-text-base)', color: 'var(--eb-text-primary)' }}>Domains</strong>
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>{list.length}</span>
        {budget && (
          <span title={`${budget.used} of ${budget.cap} skills used${over ? ' — at budget; new domains need a merge or override' : ''}`}
            style={{
              marginLeft: 'auto', fontSize: 'var(--eb-text-xs)',
              color: over ? 'var(--eb-status-error)' : 'var(--eb-text-muted)',
            }}>
            budget {budget.used}/{budget.cap}
          </span>
        )}
        <span aria-hidden style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{open ? '▾' : '▸'}</span>
      </div>
      {budget && (
        <div style={{
          height: 4, borderRadius: 'var(--eb-radius-full)', background: 'var(--eb-border-default)',
          marginTop: 'var(--eb-space-1)', overflow: 'hidden',
        }}>
          <div style={{ width: `${pct}%`, height: '100%', background: over ? 'var(--eb-status-error)' : 'var(--eb-accent-primary)' }} />
        </div>
      )}
      {open && (
        <div style={{ marginTop: 'var(--eb-space-2)' }}>
          {/* One-line primer so a first-time operator knows what a "domain" is (#1146) */}
          <div style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.55,
            marginBottom: 'var(--eb-space-2)',
          }}>
            A <strong style={{ color: 'var(--eb-text-secondary)' }}>domain</strong> is a theme this team’s
            lessons cluster into — e.g. “JCL conversion”. Each domain grows into exactly one team skill:
            converged lessons are routed to their domain and extend its skill (the first version once enough
            lessons agree). Lessons that fit no domain stay in the digest only. Renaming a domain keeps its
            skill; removing one re-routes its waiting lessons. Changing domains is always a human decision.
            <PageHelpButton
              label="What domains are for"
              size={12}
              style={{ padding: 0, marginLeft: 4, verticalAlign: '-2px' }}
              section={KNOWLEDGE_HELP_SECTIONS.powerTools}
            />
          </div>
          {/* Toolbar: LLM bootstrap + merge action */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap', marginBottom: 'var(--eb-space-2)' }}>
            <button disabled={busy} onClick={runBootstrap}
              title="Let the model propose domains over this team’s lessons — you review before anything is saved"
              style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: busy ? 0.5 : 1 }}>
              <Sparkles size={12} /> Propose with AI
            </button>
            {selected.size >= 2 && (
              <button disabled={busy} onClick={() => setMerging({ name: '', scope: '' })}
                style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: busy ? 0.5 : 1 }}>
                <Combine size={12} /> Merge {selected.size}
              </button>
            )}
            {selected.size > 0 && (
              <button style={linkBtn} onClick={() => setSelected(new Set())}>Clear selection</button>
            )}
          </div>

          {/* Bootstrap proposal review — un-persisted until confirmed */}
          {proposal && (
            <div style={{
              border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
              padding: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)', background: 'var(--eb-bg-app)',
            }}>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', marginBottom: 'var(--eb-space-1)' }}>
                Proposed domains ({proposal.proposed.length}) — review, then confirm to replace the taxonomy.
              </div>
              {proposal.fallback && (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginBottom: 'var(--eb-space-1)' }}>
                  ⚠ The AI target was unavailable — these are the deterministic role-seed defaults.
                </div>
              )}
              {proposal.proposed.map(d => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap', padding: '2px 0', fontSize: 'var(--eb-text-sm)' }}>
                  <span title={d.name} style={domainNameCell}>{d.name}</span>
                  <div style={domainRowControls}>
                    <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{d.scope}</span>
                    <DomainRoleTags roles={d.roles} />
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)' }}>
                <button disabled={busy || proposal.proposed.length === 0} onClick={confirmProposal}
                  style={{ ...primaryBtn, opacity: (busy || proposal.proposed.length === 0) ? 0.5 : 1 }}>Confirm</button>
                <button disabled={busy} onClick={() => setProposal(null)}
                  style={{ ...miniBtn, opacity: busy ? 0.5 : 1 }}>Discard</button>
              </div>
            </div>
          )}

          {list.length === 0 && !proposal && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap',
              fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)',
            }}>
              <span>No domains yet. Seed the defaults from the team’s roles, or propose with AI, then edit them.</span>
              <button disabled={busy} onClick={() => post({ op: 'seed' })}
                style={{ ...miniBtn, opacity: busy ? 0.5 : 1 }}>Seed defaults</button>
            </div>
          )}

          {list.map(d => (
            <div key={d.id} style={{
              padding: 'var(--eb-space-1) 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
              borderBottom: '1px solid var(--eb-border-default)',
            }}>
              {editing && editing.id === d.id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
                  <input value={editing.name} autoFocus placeholder="Domain name"
                    onChange={e => setEditing({ ...editing, name: e.target.value })} style={inp} />
                  <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                    <select value={editing.scope} onChange={e => setEditing({ ...editing, scope: e.target.value })}
                      style={{ ...inp, flex: '0 0 auto', width: 'auto' }}>
                      {DOMAIN_SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input value={editing.roles} placeholder="roles, comma-separated (e.g. developer, reworker)"
                      onChange={e => setEditing({ ...editing, roles: e.target.value })} style={{ ...inp, flex: 1 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
                    <button disabled={busy || !editing.name.trim()} onClick={saveEdit}
                      style={{ ...primaryBtn, opacity: (busy || !editing.name.trim()) ? 0.5 : 1 }}>Save</button>
                    <button disabled={busy} onClick={() => setEditing(null)}
                      style={{ ...miniBtn, opacity: busy ? 0.5 : 1 }}>Cancel</button>
                  </div>
                </div>
              ) : splitting && splitting.id === d.id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Split “{d.name}” into:</div>
                  {splitting.parts.map((p, i) => (
                    <div key={i} style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                      <input value={p.name} placeholder={`Part ${i + 1} name`}
                        onChange={e => setSplitting({
                          ...splitting,
                          parts: splitting.parts.map((q, j) => (j === i ? { ...q, name: e.target.value } : q)),
                        })} style={{ ...inp, flex: 1 }} />
                      <select value={p.scope} onChange={e => setSplitting({
                        ...splitting,
                        parts: splitting.parts.map((q, j) => (j === i ? { ...q, scope: e.target.value } : q)),
                      })} style={{ ...inp, flex: '0 0 auto', width: 'auto' }}>
                        {DOMAIN_SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                    <button style={linkBtn} onClick={() => setSplitting({ ...splitting, parts: [...splitting.parts, { name: '', scope: d.scope || 'team' }] })}>+ add part</button>
                    <span style={{ flex: 1 }} />
                    <button disabled={busy || !splitReady} onClick={runSplit}
                      style={{ ...primaryBtn, opacity: (busy || !splitReady) ? 0.5 : 1 }}>Split</button>
                    <button disabled={busy} onClick={() => setSplitting(null)}
                      style={{ ...miniBtn, opacity: busy ? 0.5 : 1 }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)}
                    title="Select to merge" style={{ cursor: 'pointer', flex: '0 0 auto' }} />
                  <span title={d.name} style={domainNameCell}>{d.name}</span>
                  <div style={domainRowControls}>
                    <DomainRoleTags roles={d.roles} />
                    {d.scope && d.scope !== 'team' && (
                      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{d.scope}</span>
                    )}
                    <IconButton icon={Pencil} label="Edit scope & roles" disabled={busy}
                      onClick={() => { setSplitting(null); setEditing({ id: d.id, name: d.name, scope: d.scope || 'team', roles: (d.roles || []).join(', ') }); }} />
                    <IconButton icon={Layers} label="Split" disabled={busy}
                      onClick={() => { setEditing(null); setSplitting({ id: d.id, parts: [{ name: '', scope: d.scope || 'team' }, { name: '', scope: d.scope || 'team' }] }); }} />
                    <IconButton icon={Trash2} label="Remove" danger disabled={busy}
                      onClick={() => post({ op: 'remove', id: d.id }).catch(() => {})} />
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Merge form */}
          {merging && (
            <div style={{
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
              padding: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)', display: 'flex',
              flexDirection: 'column', gap: 'var(--eb-space-1)',
            }}>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Merge {selected.size} domains into one:</div>
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                <input value={merging.name} placeholder="Result name (optional — keeps the first)"
                  onChange={e => setMerging({ ...merging, name: e.target.value })} style={{ ...inp, flex: 1 }} />
                <select value={merging.scope} onChange={e => setMerging({ ...merging, scope: e.target.value })}
                  style={{ ...inp, flex: '0 0 auto', width: 'auto' }}>
                  <option value="">scope (keep)</option>
                  {DOMAIN_SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <button disabled={busy} onClick={runMerge}
                  style={{ ...primaryBtn, opacity: busy ? 0.5 : 1 }}>Merge</button>
                <button disabled={busy} onClick={() => setMerging(null)}
                  style={{ ...miniBtn, opacity: busy ? 0.5 : 1 }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Over-budget nudge: steer new domains into merge/override (AC2) */}
          {over && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 'var(--eb-space-2)' }}>
              At the skill budget ({budget.used}/{budget.cap}). Prefer merging existing domains over adding new ones.
            </div>
          )}

          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)' }}>
            <input value={adding} placeholder={over ? 'New domain (over budget — consider merging)…' : 'New domain name…'}
              onChange={e => setAdding(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && adding.trim()) post({ op: 'add', domain: { name: adding.trim() } }).then(() => setAdding('')).catch(() => {}); }}
              style={{ ...inp, flex: 1 }} />
            <button disabled={busy || !adding.trim()}
              onClick={() => post({ op: 'add', domain: { name: adding.trim() } }).then(() => setAdding('')).catch(() => {})}
              style={{ ...primaryBtn, opacity: (busy || !adding.trim()) ? 0.5 : 1 }}>Add</button>
          </div>

          {err && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 'var(--eb-space-2)' }}>{err}</div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!overBudgetAsk}
        title="Over the skill budget"
        variant="warning"
        confirmLabel="Add anyway"
        message={overBudgetAsk ? (
          `This team is at its skill budget (${overBudgetAsk.budget.used ?? '?'} of ${overBudgetAsk.budget.cap ?? '?'} skills). `
          + `Every domain grows into its own skill, so adding ${overBudgetAsk.added === 1 ? 'this domain' : `${overBudgetAsk.added} domains`} `
          + 'will exceed it. Add anyway? (Merging into an existing domain keeps the team within budget.)'
        ) : ''}
        onConfirm={() => { overBudgetAsk.resolve(true); setOverBudgetAsk(null); }}
        onCancel={() => { if (overBudgetAsk) overBudgetAsk.resolve(false); setOverBudgetAsk(null); }}
      />
    </div>
  );
}

/* ── Consolidation migration (#842, skill-aggregation Phase 3) ───────────────── */
// The operator surface for the one-time-per-team consolidation migration (§4):
// collapse a team's accumulated micro-skills + open candidates into a few domain
// playbooks. Drives POST /api/knowledge/consolidation (read | plan | start |
// advance | route-remaining); the per-domain synthesis + archive + atomic grant
// swap runs through the EXISTING POST /api/skills/merge-draft (preview) +
// /api/skills/merge (apply) fed the plan's `merge` inputs — reusing the promotion
// review surface. Resumable (AC2): on open it reads the persisted state and
// continues from the first pending domain rather than restarting.
function ConsolidationPanel({ teamId, domains, onChanged, signal }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [state, setState] = useState(null);       // migration doc | null
  const [planData, setPlanData] = useState(null);  // { plan, merges } | null
  const [loaded, setLoaded] = useState(false);
  const [review, setReview] = useState(null);      // { domainId, name, skill, merge, loading, error, draft, source }
  const hasDomains = Array.isArray(domains) && domains.length > 0;

  const call = useCallback((body) => (
    fetch('/api/knowledge/consolidation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, ...body }),
    }).then(r => r.json().catch(() => ({}))).then((out) => {
      if (!out || out.ok !== true) throw new Error((out && out.error) || 'failed');
      return out;
    })
  ), [teamId]);

  // Read the persisted migration state + a FRESH plan. The plan's `merges` reflect
  // the current corpus, so a resumed run always folds the right sources for the
  // domain it's on. Fail-soft — an error just surfaces in the panel.
  const refresh = useCallback(() => {
    setBusy(true); setErr('');
    return Promise.all([call({ op: 'read' }), call({ op: 'plan' })])
      .then(([r, p]) => { setState(r.state || null); setPlanData({ plan: p.plan || null, merges: p.merges || [] }); })
      .catch((e) => setErr(e.message || 'failed'))
      .finally(() => { setBusy(false); setLoaded(true); });
  }, [call]);

  // Load once when first expanded; re-read whenever a consolidation feed event
  // arrives while open (AC4 — the live feed drives the panel).
  useEffect(() => { if (open && !loaded) refresh(); }, [open, loaded, refresh]);
  useEffect(() => { if (open && loaded) refresh(); }, [signal]); // eslint-disable-line react-hooks/exhaustive-deps
  // Reset when the team changes underneath us.
  useEffect(() => { setState(null); setPlanData(null); setLoaded(false); setReview(null); setOpen(false); }, [teamId]);

  const progress = migrationProgress(state);
  const pending = nextPendingDomain(state);
  const running = !!state && !progress.complete;
  const allDecided = running && progress.pending === 0;
  const fold = planData ? planFoldTotals(planData.plan) : null;
  const planRows = planData ? planDomainRows(planData.plan, planData.merges) : [];
  // Startable whenever any skill or candidate maps to a confirmed domain — a
  // ≥2-skill domain is not required (#871). `busy` still disables (in-flight).
  const startGate = consolidationStartGate(fold, { busy });

  // Run a consolidation op then refresh; `reload` also refetches team data so the
  // collapse (archived skills / cleared suggestions, AC3) shows immediately.
  const run = useCallback((fn, reload = false) => {
    setBusy(true); setErr('');
    return fn()
      .then(() => refresh())
      .then(() => { if (reload && onChanged) onChanged(); })
      .catch((e) => setErr(e.message || 'failed'))
      .finally(() => setBusy(false));
  }, [refresh, onChanged]);

  const start = () => run(() => call({ op: 'start' }));
  const skip = (domainId) => run(() => call({ op: 'advance', domainId, status: 'skipped' }));
  const routeRemaining = () => run(() => call({ op: 'route-remaining' }), true);

  // Open the per-domain review. A ≥2-member domain (or a one-member fold into the
  // domain skill, #2592) synthesises a draft via /api/skills/merge-draft (persists
  // nothing); a domain with no skill to move only records the decision — the
  // orchestrator then queues its pending lessons for the domain skill.
  const openReview = (dom) => {
    const merge = mergeForDomain(planData && planData.merges, dom.domainId);
    if (!merge) { setReview({ domainId: dom.domainId, name: dom.name, skill: dom.skill, merge: null, draft: '' }); return; }
    setReview({ domainId: dom.domainId, name: dom.name, skill: dom.skill, merge, loading: true, draft: '' });
    assistFetch('/api/skills/merge-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(merge),
    }).then(r => r.json().catch(() => ({}))).then((out) => {
      if (!out || !out.draft) throw new Error((out && out.error) || 'draft failed');
      setReview(rv => (rv && rv.domainId === dom.domainId ? { ...rv, loading: false, draft: out.draft.skillMd || '', source: out.source } : rv));
    }).catch((e) => setReview(rv => (rv && rv.domainId === dom.domainId ? { ...rv, loading: false, error: e.message } : rv)));
  };

  const canAccept = review && !review.loading && !review.error && (!review.merge || (review.draft && review.draft.trim()));

  // Accept: for a ≥2-member domain, POST /api/skills/merge with the reviewed draft
  // (synthesise + archive sources with lineage + atomic grant swap), then record the
  // decision via advance. A record-only domain just advances.
  const accept = () => {
    const rv = review;
    if (!rv) return;
    setBusy(true); setErr('');
    const applyMerge = rv.merge
      ? fetch('/api/skills/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rv.merge, draft: rv.draft }),
      }).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `merge failed (${r.status})`); return d; })
      : Promise.resolve(null);
    applyMerge
      .then(() => call({ op: 'advance', domainId: rv.domainId, status: 'accepted' }))
      .then(() => { setReview(null); return refresh(); })
      .then(() => { if (onChanged) onChanged(); })
      .catch((e) => setReview(rv2 => (rv2 ? { ...rv2, error: e.message } : rv2)))
      .finally(() => setBusy(false));
  };

  const statusIcon = (st) => {
    if (st === 'accepted') return <CheckCircle2 size={14} style={{ color: 'var(--eb-status-success, #16a34a)', flexShrink: 0 }} />;
    if (st === 'skipped') return <SkipForward size={14} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />;
    return <Circle size={14} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />;
  };

  return (
    <div style={{
      marginBottom: 'var(--eb-space-3)', border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)', background: 'var(--eb-bg-surface)', padding: 'var(--eb-space-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}>
        <Layers size={15} style={{ color: 'var(--eb-accent-primary)' }} />
        <strong style={{ fontSize: 'var(--eb-text-base)', color: 'var(--eb-text-primary)' }}>Consolidation</strong>
        {running && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {progress.decided}/{progress.total} domains
          </span>
        )}
        {state && (
          <span style={{
            marginLeft: 'auto', fontSize: 'var(--eb-text-xs)',
            color: progress.complete ? 'var(--eb-status-success, #16a34a)' : 'var(--eb-accent-primary)',
          }}>{PHASE_LABELS[progress.status] || progress.status}</span>
        )}
        <span aria-hidden style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginLeft: state ? 0 : 'auto' }}>{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 'var(--eb-space-2)' }}>
          {/* One-line primer: what consolidation produces and why (#1146) */}
          <div style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.55,
            marginBottom: 'var(--eb-space-2)',
          }}>
            Consolidation collapses the many small skills that belong to one <strong style={{ color: 'var(--eb-text-secondary)' }}>domain</strong> into
            a single <strong style={{ color: 'var(--eb-text-secondary)' }}>playbook</strong> — one well-structured skill
            replacing a scattered set. You review every playbook before it is applied; nothing is merged automatically.
            <PageHelpButton
              label="How consolidation relates to domains and distill"
              size={12}
              style={{ padding: 0, marginLeft: 4, verticalAlign: '-2px' }}
              section={KNOWLEDGE_HELP_SECTIONS.powerTools}
            />
          </div>
          {!hasDomains ? (
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
              Confirm this team’s domains first (Domains panel above). Consolidation folds the existing
              micro-skills + open candidates into those domain playbooks.
            </div>
          ) : !loaded ? (
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>Loading…</div>
          ) : progress.complete ? (
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--eb-space-1)' }}>
                <CheckCircle2 size={15} style={{ color: 'var(--eb-status-success, #16a34a)' }} />
                <strong>Migration complete.</strong>
              </div>
              <div style={{ color: 'var(--eb-text-muted)' }}>
                {progress.accepted} playbook{progress.accepted === 1 ? '' : 's'} synthesised, {progress.skipped} skipped, remainder routed.
              </div>
            </div>
          ) : !running ? (
            /* ── Preview + start (no migration yet) ── */
            <div>
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)' }}>
                {fold && (fold.skills + fold.candidates) > 0
                  ? <>Collapse <strong style={{ color: 'var(--eb-text-primary)' }}>{fold.skills}</strong> skill{fold.skills === 1 ? '' : 's'} + <strong style={{ color: 'var(--eb-text-primary)' }}>{fold.candidates}</strong> candidate{fold.candidates === 1 ? '' : 's'} across <strong style={{ color: 'var(--eb-text-primary)' }}>{fold.domains}</strong> domain{fold.domains === 1 ? '' : 's'} into domain playbooks. Review each playbook before it is applied.</>
                  : <>Nothing to consolidate yet — no existing skills or candidates map to the confirmed domains.</>}
              </div>
              {planRows.length > 0 && (
                <div style={{ marginBottom: 'var(--eb-space-2)' }}>
                  {planRows.map(r => (
                    <div key={r.domainId} style={{
                      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: '3px 0',
                      fontSize: 'var(--eb-text-sm)', borderBottom: '1px solid var(--eb-border-default)',
                    }}>
                      <span style={{ flex: 1, overflowWrap: 'anywhere', color: 'var(--eb-text-primary)' }}>{r.name}</span>
                      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                        {r.memberCount} skill{r.memberCount === 1 ? '' : 's'} · {r.candidateCount} cand.
                      </span>
                      {r.mergeable
                        ? (r.fold
                          ? <span title="One skill — it is folded into the domain skill" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)' }}>→ domain skill</span>
                          : <span title="Two or more skills — a playbook will be synthesised" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)' }}>→ playbook</span>)
                        : <span title={r.candidateCount > 0 ? 'No skill to merge — its pending lessons go to the domain skill on accept' : 'Nothing to merge'} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>—</span>}
                    </div>
                  ))}
                  {fold && (fold.unassignedSkills + fold.unassignedCandidates) > 0 && (
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
                      {fold.unassignedSkills} skill{fold.unassignedSkills === 1 ? '' : 's'} + {fold.unassignedCandidates} candidate{fold.unassignedCandidates === 1 ? '' : 's'} match no domain — routed in the final step.
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                <button disabled={!startGate.enabled} onClick={start}
                  title={startGate.enabled ? 'Begin the migration — you review each playbook before it is applied' : startGate.reason}
                  style={{ ...primaryBtn, opacity: startGate.enabled ? 1 : 0.5 }}>
                  <Play size={13} /> Start migration
                </button>
                <button disabled={busy} onClick={refresh} style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: busy ? 0.5 : 1 }}>
                  <RotateCcw size={12} /> Refresh plan
                </button>
              </div>
              {!startGate.enabled && startGate.reason && (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
                  {startGate.reason}
                </div>
              )}
            </div>
          ) : (
            /* ── In-progress: step through domains, then route remainder ── */
            <div>
              {isResumable(state) && progress.decided > 0 && (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)' }}>
                  Resumed — {progress.decided} of {progress.total} domains already decided.
                </div>
              )}
              {state.domains.map(d => {
                const isNext = pending && d.domainId === pending.domainId && d.status === 'pending';
                return (
                  <div key={d.domainId} style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: '4px 0',
                    fontSize: 'var(--eb-text-sm)', borderBottom: '1px solid var(--eb-border-default)',
                  }}>
                    {statusIcon(d.status)}
                    <span style={{ flex: 1, overflowWrap: 'anywhere', color: 'var(--eb-text-primary)' }}>{d.name}</span>
                    <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                      {(d.memberSkills || []).length} skill{(d.memberSkills || []).length === 1 ? '' : 's'}
                    </span>
                    {isNext && (
                      <>
                        <button disabled={busy} onClick={() => openReview(d)}
                          style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 4, borderColor: 'var(--eb-accent-primary)', color: 'var(--eb-accent-primary)', opacity: busy ? 0.5 : 1 }}>
                          <Sparkles size={12} /> Review playbook
                        </button>
                        <button disabled={busy} onClick={() => skip(d.domainId)} style={{ ...linkBtn, opacity: busy ? 0.5 : 1 }}>Skip</button>
                      </>
                    )}
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', marginTop: 'var(--eb-space-2)' }}>
                {allDecided ? (
                  <button disabled={busy} onClick={routeRemaining}
                    title="Route the leftover candidates (digest-only / amendments) and finish the migration"
                    style={{ ...primaryBtn, opacity: busy ? 0.5 : 1 }}>
                    <ArrowRight size={13} /> Route the remainder & finish
                  </button>
                ) : (
                  <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                    Review or skip each domain, then route the remainder.
                  </span>
                )}
              </div>
            </div>
          )}

          {err && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', marginTop: 'var(--eb-space-2)' }}>{err}</div>
          )}
        </div>
      )}

      {/* ── Per-domain playbook review (reuses the promotion editable-draft surface) ── */}
      {review && (
        <div onClick={() => !busy && setReview(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', boxShadow: 'var(--eb-shadow-lg)', maxWidth: 820, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Combine size={15} style={{ color: 'var(--eb-accent-primary)' }} />
              <strong style={{ fontSize: 'var(--eb-text-sm)' }}>Review playbook — {review.name}</strong>
            </div>
            <div style={{ padding: 'var(--eb-space-4)', overflow: 'auto', flex: 1 }}>
              {review.merge ? (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)' }}>
                  Folding {review.merge.sources.length} skill{review.merge.sources.length === 1 ? '' : 's'} into <code>{review.skill}</code>:{' '}
                  {review.merge.sources.map(s => s.name).join(', ')}. The source skills are archived with lineage
                  (reversible) and grants swap atomically on accept.
                </div>
              ) : (
                <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
                  This domain has no other skill to fold into <code>{review.skill}</code>. Accepting records it as reviewed
                  and hands the domain's pending lessons to its one domain skill (created or extended by the next pass, or
                  raised as the domain's card when the team&gt;team gate is not auto).
                </div>
              )}
              {review.loading && <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Synthesising the playbook…</div>}
              {review.error && <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-sm)' }}>{review.error}</div>}
              {review.merge && !review.loading && !review.error && (
                <>
                  <div style={{ ...lbl, marginBottom: 4 }}>Synthesised playbook — review &amp; edit</div>
                  <textarea value={review.draft} onChange={(e) => setReview(rv => ({ ...rv, draft: e.target.value }))}
                    spellCheck={false}
                    style={{ ...inp, minHeight: 320, fontFamily: 'var(--eb-font-mono, monospace)', fontSize: 'var(--eb-text-xs)', whiteSpace: 'pre', overflowWrap: 'normal' }} />
                  {review.source && (
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 4 }}>
                      Draft: {review.source === 'llm' ? 'AI-synthesised' : 'heuristic (AI unavailable)'} — edit before accepting.
                    </div>
                  )}
                </>
              )}
            </div>
            <div style={{ padding: 'var(--eb-space-3) var(--eb-space-4)', borderTop: '1px solid var(--eb-border-default)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setReview(null)} disabled={busy} style={btn}>Cancel</button>
              <button onClick={accept} disabled={busy || !canAccept}
                style={{ ...primaryBtn, opacity: (busy || !canAccept) ? 0.5 : 1 }}>
                <Check size={13} /> {review.merge ? (busy ? 'Applying…' : 'Accept & merge') : 'Accept'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SkillsColumn({ team, skills, suggestions, pending, autonomy, domains, skillBudget, onReviewSuggestion, onShareSkill, onControlsChanged, lessons, consolidationSignal }) {
  const teamId = team.id;
  const tabKey = `kf.skillTab.${teamId}`;
  const seenKey = `kf.suggestSeen.${teamId}`;

  const [tab, setTab] = useState(() => {
    try { const v = localStorage.getItem(tabKey); return SKILL_TABS.some(t => t[0] === v) ? v : 'inuse'; }
    catch { return 'inuse'; }
  });
  const [q, setQ] = useState('');
  const [sortMode, setSortMode] = useState('evidence');
  const [selected, setSelected] = useState(() => new Set());
  const [triageOpen, setTriageOpen] = useState(false);
  const [dismissing, setDismissing] = useState(null); // a single suggestion pending reason
  // #776 §2: the merge basket collects candidates to promote into ONE skill.
  const [basket, setBasket] = useState(() => new Map()); // id -> suggestion
  // #776 §1: guided one-at-a-time review flow over the ranked suggestion list.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [flash, setFlash] = useState(null); // { kind, text }
  const flashTimer = useRef(null);
  const feedback = useCallback((kind, text) => {
    setFlash({ kind, text });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), kind === 'ok' ? 4000 : 9000);
  }, []);

  const counts = tabCounts(skills, suggestions);
  const { inuse, ready } = useMemo(() => partitionSkills(skills), [skills]);

  // "New evidence" dot on Suggested since the operator's last visit to the tab.
  const [newDot, setNewDot] = useState(false);
  useEffect(() => {
    try { setNewDot(hasNewEvidence(suggestions, localStorage.getItem(seenKey))); }
    catch { setNewDot(hasNewEvidence(suggestions, null)); }
  }, [suggestions, seenKey]);

  const chooseTab = useCallback((t) => {
    setTab(t);
    setSelected(new Set());
    try { localStorage.setItem(tabKey, t); } catch { /* ignore */ }
    if (t === 'suggested') {
      try { localStorage.setItem(seenKey, new Date().toISOString()); } catch { /* ignore */ }
      setNewDot(false);
    }
  }, [tabKey, seenKey]);

  // Selection resets when the team changes underneath us.
  useEffect(() => { setSelected(new Set()); }, [teamId]);

  const toggleSel = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const inuseF = useMemo(() => inuse.filter(sk => skillMatchesQuery(sk, q)), [inuse, q]);
  const readyF = useMemo(() => ready.filter(sk => skillMatchesQuery(sk, q)), [ready, q]);
  const inbox = useMemo(
    () => buildInbox(suggestions, { mode: sortMode, now: Date.now(), cap: INBOX_CAP, query: q }),
    [suggestions, sortMode, q],
  );
  // #776 §1: review mode walks the FULL ranked/filtered list (not the top-10 cap).
  const reviewList = useMemo(
    () => buildInbox(suggestions, { mode: sortMode, now: Date.now(), cap: null, query: q }).shown,
    [suggestions, sortMode, q],
  );

  const reload = useCallback(() => { onControlsChanged && onControlsChanged(); }, [onControlsChanged]);

  // Bulk runner shared by the three tabs. `verb`/`noun` name the action + items
  // for the per-item tally (#775 AC4 — partial failure lists what failed).
  const runBulkAction = useCallback((items, fn, verb, noun) => {
    if (items.length === 0) return;
    runBulk(items, fn).then(results => {
      const ok = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok);
      if (failed.length === 0) {
        feedback('ok', `${verb} ${ok} ${noun}${ok === 1 ? '' : 's'}.`);
      } else {
        feedback('error', `${verb} ${ok}/${results.length}. Failed: ${failed.map(f => f.label).join(', ')}.`);
      }
      setSelected(new Set());
      reload();
    });
  }, [feedback, reload]);

  const doDismiss = useCallback((id, reason) => {
    dismissSuggestion(teamId, id, reason)
      .then(() => { feedback('ok', 'Dismissed — it won’t be proposed again.'); reload(); })
      .catch(e => feedback('error', `Dismiss failed: ${e.message}`));
  }, [teamId, feedback, reload]);

  // #919: confirm a decay card — archive the lesson via the SAME non-destructive
  // path as the manual Retire button, then resolve the card (dismiss, reason
  // 'retired' — stamped, never offered in the manual dismiss dialog).
  const doRetireDecay = useCallback((s) => {
    fetch(`/api/knowledge/item/${encodeURIComponent(s.canonicalId)}/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, archived: true }),
    })
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); })
      .then(() => dismissSuggestion(teamId, s.id, 'retired'))
      .then(() => { feedback('ok', 'Lesson retired — find it under “Show retired & expired”; un-retirable any time.'); reload(); })
      .catch(e => feedback('error', `Retire failed: ${e.message}`));
  }, [teamId, feedback, reload]);

  // Basket resets when the team changes underneath us.
  useEffect(() => { setBasket(new Map()); setReviewOpen(false); }, [teamId]);

  // Keep the basket consistent with the live open suggestions: once a candidate
  // is promoted (merge succeeded) or dismissed it leaves `suggestions`, so drop
  // it from the basket too — no stale phantom entries after a reload.
  useEffect(() => {
    setBasket(prev => {
      if (prev.size === 0) return prev;
      const ids = new Set(suggestions.map(s => s.id));
      let changed = false;
      const next = new Map();
      for (const [id, s] of prev) { if (ids.has(id)) next.set(id, s); else changed = true; }
      return changed ? next : prev;
    });
  }, [suggestions]);

  const addToMerge = useCallback((s) => {
    if (!s || !s.id) return;
    setBasket(prev => {
      const next = new Map(prev);
      next.set(s.id, s);
      return next;
    });
    feedback('ok', 'Added to the merge basket.');
  }, [feedback]);

  const removeFromMerge = useCallback((id) => {
    setBasket(prev => { const next = new Map(prev); next.delete(id); return next; });
  }, []);

  // Promote the whole basket (or an ad-hoc selection) as ONE skill: open the
  // PromotionDialog seeded with the union of every candidate's lessons.
  const promoteMerge = useCallback((suggestions) => {
    const combined = mergeSuggestionsInto(suggestions);
    if (!combined) return;
    onReviewSuggestion(combined, skills);
  }, [onReviewSuggestion, skills]);

  // The item set the bulk bar operates on for the current tab + selection.
  const tabItems = tab === 'inuse' ? inuseF : tab === 'ready' ? readyF : inbox.shown;
  const selItems = tabItems.filter(it => selected.has(it.id));

  const suggestedEmpty = suggestions.length === 0;

  return (
    <div>
      {/* #780/#841: the team's skill domains + soft skill-budget state + operator ops */}
      <DomainsPanel teamId={teamId} domains={domains} budget={skillBudget}
        lessons={lessons} onChanged={reload} />
      {/* #842: one-time consolidation migration — fold micro-skills into domain playbooks */}
      <ConsolidationPanel teamId={teamId} domains={domains} onChanged={reload} signal={consolidationSignal} />
      {/* Lifecycle tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        {SKILL_TABS.map(([key, label, tip]) => {
          const n = counts[key];
          const activeTab = tab === key;
          return (
            <button
              key={key}
              onClick={() => chooseTab(key)}
              title={tip}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                border: `1px solid ${activeTab ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                borderRadius: 'var(--eb-radius-full)', cursor: 'pointer',
                background: activeTab ? 'var(--eb-accent-muted)' : 'transparent',
                color: activeTab ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
                fontSize: 'var(--eb-text-xs)', fontWeight: activeTab ? 'var(--eb-font-semibold)' : 'var(--eb-font-normal)',
              }}>
              {label}
              <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.85 }}>{n}</span>
              {key === 'suggested' && newDot && (
                <span title="New evidence since your last visit" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--eb-status-warning)' }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Search across all three tabs */}
      <div style={{ position: 'relative', marginBottom: 'var(--eb-space-2)' }}>
        <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--eb-text-muted)' }} />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search skills & suggestions…"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '5px 8px 5px 26px',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-xs)',
          }} />
      </div>

      {flash && (
        <div style={{
          fontSize: 'var(--eb-text-xs)', marginBottom: 'var(--eb-space-2)', padding: '4px 8px',
          borderRadius: 'var(--eb-radius-md)',
          color: flash.kind === 'ok' ? 'var(--eb-status-success)' : 'var(--eb-status-error, #d33)',
          background: 'var(--eb-bg-app)', border: '1px solid var(--eb-border-default)',
        }}>{flash.text}</div>
      )}

      {/* Bulk action bar (per tab) */}
      {selItems.length > 0 && (
        <BulkActionBar
          tab={tab}
          items={selItems}
          onClear={() => setSelected(new Set())}
          onActivate={() => runBulkAction(selItems, sk => activateSkill(teamId, sk.label), 'Activated', 'skill')}
          onDeactivate={() => runBulkAction(selItems, sk => deactivateSkill(teamId, sk.label), 'Deactivated', 'skill')}
          onDismiss={() => runBulkAction(selItems, s => dismissSuggestion(teamId, s.id), 'Dismissed', 'suggestion')}
          onMerge={() => { promoteMerge(selItems); setSelected(new Set()); }}
        />
      )}

      {/* Tab content */}
      {tab === 'inuse' && (
        inuseF.length === 0
          ? <ColEmpty text={q ? 'No active skills match your search.' : 'No skills in use yet.'} />
          : inuseF.map(sk => (
            <SelectableRow key={sk.id} selected={selected.has(sk.id)} onToggle={() => toggleSel(sk.id)}>
              <SkillCard skill={sk} teamId={teamId} onShare={() => onShareSkill(sk)} onReload={reload} />
            </SelectableRow>
          ))
      )}

      {tab === 'ready' && (
        readyF.length === 0
          ? <ColEmpty text={q ? 'No ready skills match your search.' : 'Nothing waiting to be activated.'} />
          : readyF.map(sk => (
            <SelectableRow key={sk.id} selected={selected.has(sk.id)} onToggle={() => toggleSel(sk.id)}>
              <SkillCard skill={sk} teamId={teamId} onShare={() => onShareSkill(sk)} onReload={reload} />
            </SelectableRow>
          ))
      )}

      {tab === 'suggested' && (
        <>
          {/* Gate-stopped promotions still surface here (not part of the ranked inbox). */}
          {pending.map(p => {
            const s = suggestions.find(x => x.id === p.suggestionId);
            return s ? null : (
              <div key={p.id} style={amberCard} title="This promotion stopped at a gate that requires your review — it won’t proceed on its own.">
                <Sparkles size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{p.label}</span>
                <span style={{ fontSize: 10, color: 'var(--eb-status-warning)', marginLeft: 'auto', flexShrink: 0 }}>waiting for your review</span>
              </div>
            );
          })}

          {suggestedEmpty ? (
            <ColEmpty text={autonomy >= 2
              ? 'When several agents learn the same thing, a suggestion appears here to turn it into a reusable skill.'
              : 'Set Autonomy to “2 Suggest” and you’ll get a suggestion here whenever several agents learn the same thing.'} />
          ) : inbox.total === 0 ? (
            <ColEmpty text="No suggestions match your search." />
          ) : (
            <>
              {/* Sort control + guided review entry (#776 §1) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--eb-space-2)' }}>
                <span style={{ fontSize: 10, color: 'var(--eb-text-muted)' }}>Sort</span>
                <select
                  value={sortMode}
                  onChange={e => setSortMode(e.target.value)}
                  style={{ fontSize: 'var(--eb-text-xs)', padding: '2px 6px', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)' }}>
                  <option value="evidence">by evidence</option>
                  <option value="newest">newest</option>
                  <option value="oldest">oldest</option>
                </select>
                {reviewList.length > 0 && (
                  <button
                    onClick={() => setReviewOpen(true)}
                    title="Work through these suggestions one at a time with keyboard shortcuts"
                    style={{ ...miniBtn, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Play size={11} /> Start review
                  </button>
                )}
              </div>

              {/* Merge basket (#776 §2) */}
              {basket.size > 0 && (
                <MergeBasketBar
                  items={[...basket.values()]}
                  onRemove={removeFromMerge}
                  onClear={() => setBasket(new Map())}
                  onPromote={() => promoteMerge([...basket.values()])} />
              )}

              {inbox.themed.length > 0 && (
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--eb-text-muted)', margin: '2px 0 4px' }}>Theme groups</div>
              )}
              {inbox.themed.map(s => (
                <SuggestionCard
                  key={s.id} suggestion={s}
                  selectable selected={selected.has(s.id)} onToggleSelect={() => toggleSel(s.id)}
                  onReview={() => onReviewSuggestion(s, skills)}
                  onAddMerge={() => addToMerge(s)} inBasket={basket.has(s.id)}
                  onRetire={s.source === 'decay' ? () => doRetireDecay(s) : undefined}
                  onDismiss={() => setDismissing(s)} />
              ))}

              {inbox.singles.length > 0 && inbox.themed.length > 0 && (
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--eb-text-muted)', margin: '6px 0 4px' }}>Single suggestions</div>
              )}
              {inbox.singles.map(s => (
                <SuggestionCard
                  key={s.id} suggestion={s}
                  selectable selected={selected.has(s.id)} onToggleSelect={() => toggleSel(s.id)}
                  onReview={() => onReviewSuggestion(s, skills)}
                  onAddMerge={() => addToMerge(s)} inBasket={basket.has(s.id)}
                  onRetire={s.source === 'decay' ? () => doRetireDecay(s) : undefined}
                  onDismiss={() => setDismissing(s)} />
              ))}

              {inbox.hiddenCount > 0 && (
                <button
                  onClick={() => setTriageOpen(true)}
                  style={{ ...miniBtn, display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}
                  title="Open the full triage view">
                  <Inbox size={12} /> View all {inbox.total} <ArrowRight size={11} />
                </button>
              )}
            </>
          )}
        </>
      )}

      {dismissing && (
        <DismissDialog
          suggestion={dismissing}
          onCancel={() => setDismissing(null)}
          onConfirm={(reason) => { doDismiss(dismissing.id, reason); setDismissing(null); }} />
      )}

      {triageOpen && (
        <TriageModal
          teamId={teamId}
          openSuggestions={suggestions}
          skills={skills}
          onReview={onReviewSuggestion}
          onDismiss={(id, reason) => doDismiss(id, reason)}
          onUndismiss={(id) => undismissSuggestion(teamId, id).then(() => { feedback('ok', 'Restored to the inbox.'); reload(); }).catch(e => feedback('error', `Un-dismiss failed: ${e.message}`))}
          onClose={() => setTriageOpen(false)} />
      )}

      {reviewOpen && (
        <ReviewMode
          items={reviewList}
          basket={basket}
          onPromote={(s) => { setReviewOpen(false); onReviewSuggestion(s, skills); }}
          onAddMerge={addToMerge}
          onDismiss={(id, reason) => doDismiss(id, reason)}
          onClose={() => setReviewOpen(false)} />
      )}
    </div>
  );
}

// Guided one-at-a-time triage over the ranked suggestion list (#776 §1). Keyboard:
// P promote · M add-to-merge · D dismiss · → / Enter skip. Every decision reuses
// the same handlers as the list actions, so they emit the same feed events.
function ReviewMode({ items, basket, onPromote, onAddMerge, onDismiss, onClose }) {
  const [i, setI] = useState(0);
  const [dismissing, setDismissing] = useState(null);
  const list = Array.isArray(items) ? items : [];
  const current = list[i] || null;
  const done = i >= list.length;

  const next = useCallback(() => setI(n => n + 1), []);
  const inBasket = current && basket instanceof Map && basket.has(current.id);

  const act = useCallback((kind) => {
    if (!current) return;
    if (kind === 'promote') { onPromote(current); return; }
    if (kind === 'merge') { if (!inBasket) onAddMerge(current); next(); return; }
    if (kind === 'dismiss') { setDismissing(current); return; }
    if (kind === 'skip') { next(); return; }
  }, [current, inBasket, onPromote, onAddMerge, next]);

  useEffect(() => {
    if (done || dismissing) return undefined;
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'p') { e.preventDefault(); act('promote'); }
      else if (k === 'm') { e.preventDefault(); act('merge'); }
      else if (k === 'd') { e.preventDefault(); act('dismiss'); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); act('skip'); }
      else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, done, dismissing, onClose]);

  const memberTexts = (current?.members || []).map(m => m && m.text).filter(Boolean);

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={{ ...dialog, width: 620, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Inbox size={16} style={{ color: 'var(--eb-accent-primary)' }} />
          <h2 style={{ margin: 0, fontSize: 'var(--eb-text-md)', color: 'var(--eb-text-primary)' }}>Review suggestions</h2>
          <span style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {done ? `${list.length} of ${list.length}` : `${i + 1} of ${list.length}`}
          </span>
          <button onClick={onClose} style={{ ...btn }}><X size={14} /></button>
        </div>

        {done ? (
          <div style={{ padding: 'var(--eb-space-4) 0', textAlign: 'center', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
            <Check size={20} style={{ color: 'var(--eb-status-success)' }} /><br />
            You’ve worked through every suggestion.{basket && basket.size > 0 ? ` ${basket.size} in the merge basket.` : ''}
            <div style={{ marginTop: 'var(--eb-space-3)' }}><button onClick={onClose} style={primaryBtn}>Close</button></div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
              {current.source === 'related' || current.source === 'manual'
                ? <>Combining {current.lessonCount || memberTexts.length} lessons · from {(current.convergence || []).join(', ') || 'unknown'}</>
                : <>Learned {current.convergenceCount}× independently · by {(current.convergence || []).join(', ') || 'unknown'}</>}
            </div>
            <div style={{
              fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', background: 'var(--eb-bg-app)',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
              maxHeight: 220, overflowY: 'auto',
            }}>
              {memberTexts.length > 1 ? (
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {memberTexts.map((t, k) => <li key={k} style={{ wordBreak: 'break-word' }}>{t}</li>)}
                </ul>
              ) : (current.text || memberTexts[0] || '')}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)' }}>
              <button onClick={() => act('promote')} style={{ ...primaryBtn, display: 'flex', alignItems: 'center', gap: 5 }}><Sparkles size={13} /> Promote… <kbd style={kbdStyle}>P</kbd></button>
              <button onClick={() => act('merge')} disabled={inBasket} style={{ ...miniBtn, display: 'flex', alignItems: 'center', gap: 5 }}><Combine size={12} /> {inBasket ? 'In basket' : 'Add to merge'} <kbd style={kbdStyle}>M</kbd></button>
              <button onClick={() => act('dismiss')} style={{ ...miniBtn, display: 'flex', alignItems: 'center', gap: 5 }}><Ban size={12} /> Dismiss <kbd style={kbdStyle}>D</kbd></button>
              <button onClick={() => act('skip')} style={{ ...miniBtn, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>Skip <SkipForward size={12} /> <kbd style={kbdStyle}>→</kbd></button>
            </div>
          </>
        )}
      </div>

      {dismissing && (
        <DismissDialog
          suggestion={dismissing}
          onCancel={() => setDismissing(null)}
          onConfirm={(reason) => { onDismiss(dismissing.id, reason); setDismissing(null); next(); }} />
      )}
    </div>
  );
}

// The merge-basket bar shown above the inbox once ≥1 candidate is collected.
function MergeBasketBar({ items, onRemove, onClear, onPromote }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 'var(--eb-space-2)',
      border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
      background: 'var(--eb-bg-app)', padding: 'var(--eb-space-2) var(--eb-space-3)',
    }}>
      <Layers size={13} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)' }}>{items.length} in merge basket</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: '1 1 100%' }}>
        {items.map(s => (
          <span key={s.id} title={s.text} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)', color: 'var(--eb-text-secondary)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            {(s.text || s.id).slice(0, 28)}
            <button onClick={() => onRemove(s.id)} title="Remove from basket" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--eb-text-muted)', display: 'inline-flex' }}><X size={10} /></button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
        <button onClick={onPromote} disabled={items.length < 1} style={{ ...primaryBtn, padding: '2px 10px', display: 'flex', alignItems: 'center', gap: 4 }}><Combine size={11} /> Merge into one skill</button>
        <button onClick={onClear} style={miniBtn}>Clear</button>
      </div>
    </div>
  );
}

function ColEmpty({ text }) {
  return (
    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2) 0' }}>{text}</div>
  );
}

// A skill card with a leading select toggle for the bulk action bar.
function SelectableRow({ selected, onToggle, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 'var(--eb-space-2)' }}>
      <button
        onClick={onToggle}
        title={selected ? 'Deselect' : 'Select for a bulk action'}
        style={{ background: 'none', border: 'none', padding: '2px 0 0', cursor: 'pointer', flexShrink: 0 }}>
        {selected
          ? <CheckCircle2 size={15} style={{ color: 'var(--eb-accent-primary)' }} />
          : <Circle size={15} style={{ color: 'var(--eb-text-muted)' }} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function BulkActionBar({ tab, items, onClear, onActivate, onDeactivate, onDismiss, onMerge }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--eb-space-2)',
      border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
      background: 'var(--eb-accent-muted)', padding: 'var(--eb-space-2) var(--eb-space-3)',
    }}>
      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)' }}>
        {items.length} selected
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        {tab === 'ready' && (
          <button onClick={onActivate} style={{ ...primaryBtn, padding: '2px 10px' }}>Activate</button>
        )}
        {tab === 'inuse' && (
          <button onClick={onDeactivate} style={{ ...miniBtn }}>Deactivate</button>
        )}
        {tab === 'suggested' && items.length >= 2 && onMerge && (
          <button onClick={onMerge} title="Combine the selected suggestions into one skill" style={{ ...primaryBtn, padding: '2px 10px', display: 'flex', alignItems: 'center', gap: 4 }}><Combine size={11} /> Merge into one skill</button>
        )}
        {tab === 'suggested' && (
          <button onClick={onDismiss} style={{ ...miniBtn, display: 'flex', alignItems: 'center', gap: 4 }}><Ban size={11} /> Dismiss</button>
        )}
        <button onClick={onClear} style={miniBtn}>Clear</button>
      </div>
    </div>
  );
}

// Full-height triage view over ALL suggestions (open + optionally dismissed),
// with search and a source filter (#775 §3). Dismissed candidates are fetched
// lazily via ?status=dismissed and can be un-dismissed.
function TriageModal({ teamId, openSuggestions, skills, onReview, onDismiss, onUndismiss, onClose }) {
  const [q, setQ] = useState('');
  const [source, setSource] = useState(null); // null = all
  // Lifecycle view: 'open' (default) · 'dismissed' · 'stale' (#776 §4). The
  // non-open views are lazily fetched by status and cached.
  const [lifecycle, setLifecycle] = useState('open');
  const [rows, setRows] = useState({ dismissed: null, stale: null }); // null = not loaded
  const [dismissing, setDismissing] = useState(null);

  useEffect(() => {
    if (lifecycle === 'open' || rows[lifecycle] !== null) return undefined;
    let cancelled = false;
    fetch(`/api/knowledge/promotion-suggestions?team=${encodeURIComponent(teamId)}&status=${lifecycle}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setRows(prev => ({ ...prev, [lifecycle]: Array.isArray(d?.suggestions) ? d.suggestions : [] })); })
      .catch(() => { if (!cancelled) setRows(prev => ({ ...prev, [lifecycle]: [] })); });
    return () => { cancelled = true; };
  }, [lifecycle, rows, teamId]);

  const base = lifecycle === 'open' ? openSuggestions : (rows[lifecycle] || []);
  const view = useMemo(
    () => buildInbox(base, { mode: 'evidence', now: Date.now(), cap: null, query: q, sourceFilter: source }),
    [base, q, source],
  );
  const dropFromView = (id) => setRows(prev => ({ ...prev, [lifecycle]: (prev[lifecycle] || []).filter(r => r.id !== id) }));

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'stretch', padding: 'var(--eb-space-4)' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)', width: 'min(720px, 96vw)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)' }}>
          <Inbox size={15} style={{ color: 'var(--eb-accent-primary)' }} />
          <span style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
            Suggestion triage — {teamId}
          </span>
          <button onClick={onClose} style={{ ...miniBtn, marginLeft: 'auto', display: 'flex', alignItems: 'center' }}><X size={13} /></button>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)' }}>
          <div style={{ position: 'relative', flex: '1 1 200px' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--eb-text-muted)' }} />
            <input
              value={q} onChange={e => setQ(e.target.value)} placeholder="Search…"
              style={{ width: '100%', boxSizing: 'border-box', padding: '5px 8px 5px 26px', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-xs)' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Filter size={12} style={{ color: 'var(--eb-text-muted)' }} />
            <Chip active={source === null} onClick={() => setSource(null)}>all</Chip>
            {SUGGESTION_SOURCES.map(s => (
              <Chip key={s} active={source === s} onClick={() => setSource(source === s ? null : s)}>{s}</Chip>
            ))}
          </div>
          <Chip active={lifecycle === 'dismissed'} onClick={() => setLifecycle(v => (v === 'dismissed' ? 'open' : 'dismissed'))} title="Show suggestions you dismissed earlier">dismissed</Chip>
          <Chip active={lifecycle === 'stale'} onClick={() => setLifecycle(v => (v === 'stale' ? 'open' : 'stale'))} title="Show suggestions auto-archived after weeks with no new evidence">stale</Chip>
        </div>

        {/* List */}
        <div style={{ overflowY: 'auto', padding: 'var(--eb-space-3) var(--eb-space-4)', maxHeight: '70vh' }}>
          {lifecycle !== 'open' && rows[lifecycle] === null ? (
            <ColEmpty text={`Loading ${lifecycle} suggestions…`} />
          ) : view.total === 0 ? (
            <ColEmpty text={lifecycle === 'dismissed' ? 'No dismissed suggestions.' : lifecycle === 'stale' ? 'No stale suggestions.' : 'Nothing matches these filters.'} />
          ) : (
            view.shown.map(s => (
              <SuggestionCard
                key={s.id} suggestion={s}
                onReview={() => { onReview(s, skills); onClose(); }}
                onDismiss={lifecycle === 'open' ? () => setDismissing(s) : undefined}
                onUndismiss={lifecycle !== 'open' ? () => { onUndismiss(s.id); dropFromView(s.id); } : undefined} />
            ))
          )}
        </div>
      </div>

      {dismissing && (
        <DismissDialog
          suggestion={dismissing}
          onCancel={() => setDismissing(null)}
          onConfirm={(reason) => { onDismiss(dismissing.id, reason); setDismissing(null); }} />
      )}
    </div>
  );
}

/* ── Overview table — human-readable, one row per learned fact (#635) ───────── */

function OverviewTable({ team, data, filters, pulseId, selectedId, onOpenItem, onBulkArchive, onCombineItems }) {
  const graph = data?.graph;
  const skills = useMemo(() => (graph?.nodes || []).filter(n => n.kind === 'skill'), [graph]);

  // #915: the Last-used column is sortable — null keeps the default
  // newest-created order; 'desc' = most recently used first (never-used last);
  // 'asc' = the least recently used first (the retire candidates).
  const [usageSort, setUsageSort] = useState(null);
  const items = useMemo(() => {
    const list = (graph?.nodes || []).filter(n => n.kind === 'item');
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    const q = filters.q.trim().toLowerCase();
    const out = list
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
    if (usageSort) out.sort((a, b) => (usageSort === 'asc' ? -compareLastUsed(a, b) : compareLastUsed(a, b)));
    return out;
  }, [graph, filters, usageSort]);

  const [picked, setPicked] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(null); // { kind: 'retire' | 'unretire', ids, n }

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
    setConfirmBulk({ kind: 'retire', ids: toRetire.map(i => i.id), n });
  }, [toRetire]);

  const doUnretire = useCallback(() => {
    const n = toUnretire.length;
    if (n === 0) return;
    setConfirmBulk({ kind: 'unretire', ids: toUnretire.map(i => i.id), n });
  }, [toUnretire]);

  const runBulk = useCallback(() => {
    if (!confirmBulk) return;
    const { kind, ids } = confirmBulk;
    Promise.resolve(onBulkArchive(ids, kind === 'retire')).finally(() => setPicked(new Set()));
    setConfirmBulk(null);
  }, [confirmBulk, onBulkArchive]);

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
                <th
                  onClick={() => setUsageSort(s => (s === null ? 'desc' : s === 'desc' ? 'asc' : null))}
                  title="When agents last retrieved this lesson (search or digest). Click to sort — least-recently-used first is the retire-candidate view."
                  style={{ ...th, cursor: 'pointer', userSelect: 'none' }}>
                  Last used{usageSort === 'desc' ? ' ↓' : usageSort === 'asc' ? ' ↑' : ''}
                </th>
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
                      <td
                        title={n.lastUsedAt
                          ? 'Last returned by a knowledge search or inlined into a digest build'
                          : 'No agent has retrieved this lesson yet'}
                        style={{ ...td, whiteSpace: 'nowrap', fontSize: 'var(--eb-text-xs)', color: n.lastUsedAt ? 'var(--eb-text-muted)' : 'var(--eb-status-warning)' }}>
                        {lastUsedLabel(n, Date.now(), !!graph?.retrievalStats) || '—'}
                      </td>
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
      <ConfirmDialog
        open={!!confirmBulk}
        title={confirmBulk?.kind === 'unretire' ? 'Un-retire learnings' : 'Retire learnings'}
        variant={confirmBulk?.kind === 'unretire' ? 'info' : 'warning'}
        confirmLabel={confirmBulk?.kind === 'unretire' ? 'Un-retire' : 'Retire'}
        message={confirmBulk ? (
          confirmBulk.kind === 'unretire'
            ? `Un-retire ${confirmBulk.n === 1 ? 'this learning' : `these ${confirmBulk.n} learnings`} back into the shared knowledge base?`
            : `Retire ${confirmBulk.n === 1 ? 'this learning' : `these ${confirmBulk.n} learnings`} from the shared knowledge base? They stay in git for audit and can be un-retired.`
        ) : ''}
        onConfirm={runBulk}
        onCancel={() => setConfirmBulk(null)}
      />
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
      <ArrowRight size={14} style={{ color: 'var(--eb-border-default)' }} />
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

function ItemCard({ item, pulsing, selected, picked, anyPicked, onPick, onClick, onHover, onRetire, onUnarchive, retrievalOn }) {
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
        {item.expired && !item.archived && (
          <span title={`No longer valid since ${(item.validTo || '').slice(0, 10)} — dropped from the digest, search and active graph; kept in git`} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', border: '1px solid var(--eb-status-warning)', padding: '0 5px', borderRadius: 'var(--eb-radius-full)' }}>expired</span>
        )}
        {(item.loadTriggers || []).length > 0 && (
          <span
            title={`Auto-loads into the agent's context when a task matches: ${item.loadTriggers.map(t => `${t.type}:${t.pattern}`).join(', ')}`}
            style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)', border: '1px solid var(--eb-accent-primary)', padding: '0 5px', borderRadius: 'var(--eb-radius-full)', cursor: 'help' }}>
            auto-load
          </span>
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
        {(item.lastUsedAt || retrievalOn) && (
          <span
            title={item.lastUsedAt
              ? 'When this lesson was last returned by an agent’s knowledge search or inlined into a digest (#915 read-side telemetry)'
              : 'No agent has retrieved this lesson yet — neither via knowledge search nor a digest build'}
            style={{ fontSize: 'var(--eb-text-xs)', color: item.lastUsedAt ? 'var(--eb-text-muted)' : 'var(--eb-status-warning)', whiteSpace: 'nowrap' }}>
            · {lastUsedLabel(item, Date.now(), retrievalOn)}
          </span>
        )}
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
  pending: { label: 'syncing…', color: 'var(--eb-status-warning)', tip: 'The skill is in the team’s active set and the orchestrator is copying it into this member’s workspace — this heals itself, no action needed.' },
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

// Health tone → colour token, shared by the status pill and the health sentence
// (#774). Mirrors the `tone` values skill-rollout-view.js returns.
const TONE_COLOR = {
  success: 'var(--eb-status-success)',
  warning: 'var(--eb-status-warning)',
  error: 'var(--eb-status-error, #d33)',
  muted: 'var(--eb-text-muted)',
};

function SkillCard({ skill, teamId, onShare, onReload }) {
  const auto = skill.promotedBy === 'curator';
  const act = skill.activation || null;
  const [open, setOpen] = useState(false); // skill inspector drawer (#774)
  const [busy, setBusy] = useState(null); // 'activate' | 'deactivate' | <agentId>
  const [flash, setFlash] = useState(null); // { kind: 'ok' | 'error', text }
  const [cascadeConfirm, setCascadeConfirm] = useState(null); // { agents } — 409 "delete anyway?" confirm
  const flashTimer = useRef(null);

  const feedback = (kind, text) => {
    setFlash({ kind, text });
    clearTimeout(flashTimer.current);
    // 'ok' flashes are transient; 'warn'/'error' stay long enough to read the reason.
    flashTimer.current = setTimeout(() => setFlash(null), kind === 'ok' ? 4000 : 8000);
  };

  // `activate` handles both the team-wide Activate button and the member-scoped
  // "Sync now"/"Add for this member" links. `opts.includeMembers` opts override
  // members in; `opts.onlyMembers` scopes the file sync to a subset (Sync now),
  // and `opts.scoped` switches the verdict wording to that single member (#739).
  // The result is interpreted honestly via summarizeActivation: a run that
  // synced nobody is never shown in the success colour (AC1/AC2/AC3).
  const activate = (busyKey, { includeMembers, onlyMembers, scoped = false } = {}) => {
    setBusy(busyKey);
    fetch('/api/knowledge/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId, skillName: skill.label,
        ...(includeMembers ? { includeMembers } : {}),
        ...(onlyMembers ? { onlyMembers } : {}),
      }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        const verdict = summarizeActivation(d.members, { scoped });
        feedback(verdict.kind, verdict.text);
        onReload && onReload();
      })
      .catch(e => feedback('error', `Action failed: ${e.message}`))
      .finally(() => setBusy(null));
  };

  // Unified deactivate (#774 AC3): the single labeled action behind the
  // inspector's "Deactivate…" confirm sheet. Reversible — the skill file stays
  // in the team library and Activate undoes it — so the confirm sheet only
  // explains the consequence; it does not warn like a destructive action. The
  // same action also resolves the sourceMissing recovery case (an undeliverable
  // skill: removing it from the active set clears the stuck state).
  const deactivate = () => {
    setBusy('deactivate');
    fetch('/api/knowledge/deactivate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, skillName: skill.label }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        feedback('ok', 'Deactivated — the skill stays in the team library and can be activated again.');
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
            // Skill still in use — surface the styled cascade confirm instead of a
            // native prompt. Confirming re-runs the delete with cascade=true.
            setBusy(null);
            setCascadeConfirm({ agents: d.agents });
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

  const status = rolloutStatus(act);
  const installedCount = status ? status.counts.installed : 0;
  // Node-level drift rollup (#629 AC2): { worst, outdated, resyncable, total, counts }.
  const drift = skill.drift || null;
  const driftWorst = drift && drift.worst && drift.worst !== 'in-sync' ? drift.worst : null;
  const tierMeta = `${skill.tier} skill${skill.alsoGlobal ? ' · also global' : ''}${auto ? ' · auto-promoted' : ''}${skill.adopted ? ' · adopted' : ''}`;
  const tierTip = `${skill.tier === 'global' ? 'Global skill — agents in every team load it' : 'Team skill — only this team’s agents load it'}${skill.alsoGlobal ? '. Also promoted to the global pool — the team keeps its own copy.' : ''}${auto ? '. Promoted automatically by the team’s curator (autonomy 3).' : ''}${skill.adopted ? '. Adopted from the global pool into this team’s active set.' : ''}`;

  return (
    <>
      {/* Compact clickable row (#774): the whole card opens the read-only skill
          inspector. The only inline action is the Ready → Activate one-click;
          deactivate, rollout, delete, share, open-in-editor and resync all move
          into the inspector, so no icon strip competes on the row. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
        title="Open the skill inspector"
        style={{
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-elevated)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', marginBottom: 'var(--eb-space-2)',
          cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6,
        }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <GitBranch size={13} style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{skill.label}</div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }} title={tierTip}>{tierMeta}</div>
            {Array.isArray(skill.roles) && skill.roles.length > 0 && (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }} title="Domain audience roles (#781)">
                for: {skill.roles.join(', ')}
              </div>
            )}
          </div>
          {act && !act.active && (
            <button
              disabled={busy === 'activate'}
              onClick={(e) => { e.stopPropagation(); activate('activate'); }}
              title="Add this skill to the team's active set and sync it into every member's workspace"
              style={{ ...primaryBtn, padding: '2px 10px', fontSize: 'var(--eb-text-xs)', flexShrink: 0 }}>
              {busy === 'activate' ? 'Activating…' : 'Activate'}
            </button>
          )}
        </div>

        {status && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 8px',
              borderRadius: 'var(--eb-radius-full)', border: `1px solid ${TONE_COLOR[status.tone]}`,
              color: TONE_COLOR[status.tone], whiteSpace: 'nowrap',
            }}>
              {status.pill}
            </span>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: TONE_COLOR[status.tone] }}>{status.sentence}</span>
          </div>
        )}

        {driftWorst && (
          <span
            title={(DRIFT_CHIPS[driftWorst] || {}).tip || 'Some copies of this skill have drifted from the source.'}
            style={{
              alignSelf: 'flex-start', fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 'var(--eb-radius-full)',
              border: `1px solid ${(DRIFT_CHIPS[driftWorst] || {}).color || 'var(--eb-status-warning)'}`,
              color: (DRIFT_CHIPS[driftWorst] || {}).color || 'var(--eb-status-warning)', whiteSpace: 'nowrap',
            }}>
            {drift.outdated > 0 ? `${drift.outdated} outdated` : (DRIFT_CHIPS[driftWorst] || {}).label || driftWorst}
          </span>
        )}

        {flash && (
          <div style={{
            fontSize: 'var(--eb-text-xs)', fontWeight: 600,
            color: flash.kind === 'ok' ? 'var(--eb-status-success)'
              : flash.kind === 'warn' ? 'var(--eb-status-warning)'
              : 'var(--eb-status-error, #d33)',
          }}>
            {flash.kind === 'ok' ? '✓ ' : '⚠ '}{flash.text}
          </div>
        )}
      </div>

      <SkillInspector
        open={open}
        onClose={() => setOpen(false)}
        skill={skill}
        teamId={teamId}
        status={status}
        busy={busy}
        installedCount={installedCount}
        onShare={onShare}
        onActivate={activate}
        onDeactivate={deactivate}
        onResync={resync}
        onDelete={runDelete}
      />
      <ConfirmDialog
        open={!!cascadeConfirm}
        title="Skill still in use"
        variant="danger"
        confirmLabel="Deactivate & delete"
        message={cascadeConfirm ? (
          <>
            <strong>“{skill.label}”</strong> is still active for: {cascadeConfirm.agents.join(', ')}.
            <span style={{ display: 'block', marginTop: 'var(--eb-space-2)' }}>Deactivate those grants and delete anyway? A restorable snapshot is archived first.</span>
          </>
        ) : ''}
        onConfirm={() => { setCascadeConfirm(null); runDelete(true); }}
        onCancel={() => setCascadeConfirm(null)}
      />
    </>
  );
}

/* ── Skill inspector drawer (#774) ────────────────────────────────────────────
 *
 * One read-only slide-over for every skill-shaped item on the Knowledge page.
 * Content / Origin / Rollout tabs use the existing skill endpoints (no new
 * backend); the action footer carries the one named Deactivate… (with a
 * consequence confirm sheet), Share…, a working "Open in Skill Editor" deep
 * link, and an overflow ⋯ menu with the destructive Delete… (team tier only).
 * The mutating handlers live on the parent SkillCard and are passed in, so the
 * drawer stays a view over the same busy/flash state. */
function SkillInspector({ open, onClose, skill, teamId, status, busy, installedCount, onShare, onActivate, onDeactivate, onResync, onDelete }) {
  const act = skill.activation || null;
  const src = skill.tier === 'team' ? 'team' : 'pool';
  const members = act ? (act.members || []) : [];
  const drift = skill.drift || null;
  const sourceMissing = !!(act && act.active && act.sourceMissing);

  const [tab, setTab] = useState('content');
  const [content, setContent] = useState(null);
  const [contentErr, setContentErr] = useState(null);
  const [files, setFiles] = useState(null);
  const [selectedFile, setSelectedFile] = useState('SKILL.md');
  const [fileData, setFileData] = useState(null);
  const [fileErr, setFileErr] = useState(null);
  const [lineage, setLineage] = useState(null);
  const [lineageErr, setLineageErr] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // #781 distillation: preview a whole-skill re-synthesis (old vs. new), then apply.
  const [distill, setDistill] = useState(null); // null | {loading} | {old,new,changed,reason} | {error}

  // This inspector is a SidePanel (z-index 60/61) and it hosts a "?"; without
  // publishing the overlay the help panel (z-index 50) would open BEHIND it.
  // Claims no topic of its own — resolution falls through to /knowledge, which is
  // where its chapters live (#1985).
  useHelpSubject({ overlay: OVERLAY_KNOWLEDGE_SKILL, active: !!open });
  const [distillBusy, setDistillBusy] = useState(false);

  const qs = (extra = {}) => {
    const q = new URLSearchParams({ source: src, ...extra });
    if (src === 'team') q.set('teamId', teamId);
    return q.toString();
  };
  const encName = encodeURIComponent(skill.label);

  // Content (rendered SKILL.md) + file list, loaded when the drawer opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setContent(null); setContentErr(null); setSelectedFile('SKILL.md'); setFileData(null);
    fetch(`/api/skills/${encName}/content?${qs()}`)
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setContent(d.content || ''); })
      .catch(e => { if (!cancelled) setContentErr(e.message); });
    setFiles(null);
    fetch(`/api/skills/${encName}/files?${qs()}`)
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setFiles(Array.isArray(d.files) ? d.files : []); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [open, skill.label, src, teamId]);

  // Selected non-SKILL.md file content (SKILL.md is rendered from `content`).
  useEffect(() => {
    if (!open || selectedFile === 'SKILL.md' || !selectedFile) { setFileData(null); setFileErr(null); return; }
    let cancelled = false;
    setFileData(null); setFileErr(null);
    fetch(`/api/skills/${encName}/file?${qs({ file: selectedFile })}`)
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setFileData(d); })
      .catch(e => { if (!cancelled) setFileErr(e.message); });
    return () => { cancelled = true; };
  }, [open, selectedFile, skill.label, src, teamId]);

  // Origin/lineage, loaded lazily the first time the Origin tab is shown.
  useEffect(() => {
    if (!open || tab !== 'origin' || lineage || lineageErr) return;
    let cancelled = false;
    fetch(`/api/skills/${encName}/lineage?${qs()}`)
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setLineage(d); })
      .catch(e => { if (!cancelled) setLineageErr(e.message); });
    return () => { cancelled = true; };
  }, [open, tab, skill.label, src, teamId]);

  // #781 §3.4: preview a distillation (re-synthesise the whole skill) — old vs. new.
  const previewDistill = async () => {
    setDistillBusy(true);
    setDistill({ loading: true });
    try {
      const r = await fetch('/api/knowledge/distill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, skill: skill.label, apply: false }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setDistill({ old: d.old || '', new: d.new || '', changed: !!d.changed, reason: d.reason });
    } catch (e) {
      setDistill({ error: e.message });
    } finally {
      setDistillBusy(false);
    }
  };
  // Apply the distillation. LLM failure leaves the skill byte-identical (AC2) — the
  // backend enforces that; the UI just reports the outcome and refreshes the content.
  const applyDistill = async () => {
    setDistillBusy(true);
    try {
      const r = await fetch('/api/knowledge/distill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, skill: skill.label, apply: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (d.changed && typeof d.new === 'string') setContent(d.new);
      setDistill(null);
    } catch (e) {
      setDistill({ error: e.message });
    } finally {
      setDistillBusy(false);
    }
  };

  if (!open) return null;

  const editorHref = `/skills?skill=${encName}&tier=${src}${src === 'team' ? `&team=${encodeURIComponent(teamId)}` : ''}`;
  const resyncable = drift && drift.resyncable ? drift.resyncable : 0;

  const tabBtn = (id, label) => (
    <button
      onClick={() => setTab(id)}
      style={{
        background: 'none', border: 'none', borderBottom: `2px solid ${tab === id ? 'var(--eb-accent-primary)' : 'transparent'}`,
        color: tab === id ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-sm)', fontWeight: tab === id ? 600 : 500,
        padding: '6px 10px', cursor: 'pointer',
      }}>
      {label}
    </button>
  );

  const footerBtn = { ...primaryBtn, padding: '4px 12px', fontSize: 'var(--eb-text-sm)' };
  const ghostBtn = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px',
    borderRadius: 'var(--eb-radius-md)', border: '1px solid var(--eb-border-default)',
    background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-primary)',
    fontSize: 'var(--eb-text-sm)', cursor: 'pointer', textDecoration: 'none',
  };

  return (
    <SidePanel open={open} onClose={onClose} title={skill.label} width="560px">
      {/* Header: status pill + health sentence + provenance metatext */}
      {status && (
        <div style={{ marginBottom: 'var(--eb-space-3)' }}>
          <span style={{
            display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 10px',
            borderRadius: 'var(--eb-radius-full)', border: `1px solid ${TONE_COLOR[status.tone]}`,
            color: TONE_COLOR[status.tone],
          }}>
            {status.pill}
          </span>
          <div style={{ marginTop: 4, fontSize: 'var(--eb-text-sm)', color: TONE_COLOR[status.tone] }}>{status.sentence}</div>
          <div style={{ marginTop: 2, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {skill.tier} skill{skill.alsoGlobal ? ' · also global' : ''}{skill.promotedBy === 'curator' ? ' · auto-promoted' : ''}{skill.adopted ? ' · adopted' : ''}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--eb-border-default)', marginBottom: 'var(--eb-space-3)' }}>
        {tabBtn('content', 'Content')}
        {tabBtn('origin', 'Origin')}
        {tabBtn('rollout', `Rollout${members.length ? ` (${members.length})` : ''}`)}
      </div>

      {/* ── Content tab ── */}
      {tab === 'content' && (
        <div>
          {files && files.length > 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 'var(--eb-space-3)' }}>
              {files.map(f => (
                <button
                  key={f.path}
                  onClick={() => setSelectedFile(f.path)}
                  title={f.path}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
                    borderRadius: 'var(--eb-radius-full)', fontSize: 'var(--eb-text-xs)', cursor: 'pointer',
                    border: `1px solid ${selectedFile === f.path ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                    background: selectedFile === f.path ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
                    color: selectedFile === f.path ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)',
                  }}>
                  <FileText size={11} />{f.path}
                </button>
              ))}
            </div>
          )}
          {contentErr && <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-sm)' }}>Couldn’t load content: {contentErr}</div>}
          {selectedFile === 'SKILL.md'
            ? (content == null && !contentErr
                ? <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading…</div>
                : content != null && <SkillMarkdown content={content} />)
            : (fileErr
                ? <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-sm)' }}>Couldn’t load file: {fileErr}</div>
                : fileData == null
                  ? <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading…</div>
                  : fileData.binary
                    ? <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Binary file ({fileData.size} bytes) — not previewable.</div>
                    : <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-3)', margin: 0 }}>{fileData.content}{fileData.truncated ? '\n… (truncated)' : ''}</pre>)}
        </div>
      )}

      {/* ── Origin tab ── */}
      {tab === 'origin' && (
        <div style={{ fontSize: 'var(--eb-text-sm)' }}>
          {lineageErr && <div style={{ color: 'var(--eb-status-error, #d33)' }}>Couldn’t load lineage: {lineageErr}</div>}
          {!lineage && !lineageErr && <div style={{ color: 'var(--eb-text-muted)' }}>Loading…</div>}
          {lineage && (
            <>
              <div style={{ marginBottom: 'var(--eb-space-3)' }}>
                <div style={{ ...lbl, marginBottom: 2 }}>Version</div>
                {lineage.versions && lineage.versions.current && lineage.versions.current.version != null
                  ? <div>v{lineage.versions.current.version}{lineage.versions.current.contentHash ? ` · ${String(lineage.versions.current.contentHash).slice(0, 7)}` : ''}{lineage.versions.current.updatedAt ? ` · updated ${lineage.versions.current.updatedAt}` : ''}</div>
                  : <div style={{ color: 'var(--eb-text-muted)' }}>No version manifest (predates skill manifests).</div>}
              </div>
              <div>
                <div style={{ ...lbl, marginBottom: 2 }}>All known copies ({(lineage.copies || []).length})</div>
                {(lineage.copies || []).length === 0 && <div style={{ color: 'var(--eb-text-muted)' }}>Only this copy is known.</div>}
                {(lineage.copies || []).map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {c.tier}{c.teamId ? ` · ${c.teamId}` : ''}{c.agentId ? ` · ${c.agentId}` : ''}{c.viewed ? ' (this copy)' : ''}
                    </span>
                    {c.drift && c.drift !== 'in-sync' && DRIFT_CHIPS[c.drift] && (
                      <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: DRIFT_CHIPS[c.drift].color }}>{DRIFT_CHIPS[c.drift].label}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Rollout tab ── */}
      {tab === 'rollout' && (
        <div style={{ fontSize: 'var(--eb-text-sm)' }}>
          {sourceMissing && (
            <div style={{ marginBottom: 'var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error, #d33)' }}>
              ⚠ This skill’s files are no longer available, so no agent can receive it. Use “Deactivate…” below to clear the stuck state — the skill leaves the active set but any archived snapshot is kept.
            </div>
          )}
          {members.length === 0 && <div style={{ color: 'var(--eb-text-muted)' }}>No members to roll out to yet.</div>}
          {members.map(m => {
            const chip = MEMBER_STATE_CHIPS[m.state] || { label: m.state, color: 'var(--eb-text-muted)', tip: '' };
            return (
              <div key={m.agentId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', borderBottom: '1px solid var(--eb-border-default)' }}>
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.displayName || m.agentId}
                </span>
                <span title={chip.tip} style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, padding: '0 6px', borderRadius: 'var(--eb-radius-full)', border: `1px solid ${chip.color}`, color: chip.color, cursor: 'help', whiteSpace: 'nowrap' }}>
                  {chip.label}
                </span>
                {m.drift && m.drift !== 'in-sync' && DRIFT_CHIPS[m.drift] && (
                  <span title={DRIFT_CHIPS[m.drift].tip} style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, padding: '0 6px', borderRadius: 'var(--eb-radius-full)', border: `1px solid ${DRIFT_CHIPS[m.drift].color}`, color: DRIFT_CHIPS[m.drift].color, cursor: 'help', whiteSpace: 'nowrap' }}>
                    {DRIFT_CHIPS[m.drift].label}
                  </span>
                )}
                {m.drift === 'outdated' && (
                  <button disabled={!!busy} onClick={() => onResync({ agentId: m.agentId }, m.agentId)} title="Resync this copy to the current source content" style={linkBtn}>
                    {busy === m.agentId ? 'Updating…' : 'Update'}
                  </button>
                )}
                {m.state === 'excluded-override' && (
                  <button disabled={!!busy} onClick={() => onActivate(m.agentId, { includeMembers: [m.agentId], onlyMembers: [m.agentId], scoped: true })} title="This member manages its own skill list — opt it into this skill anyway" style={linkBtn}>
                    {busy === m.agentId ? 'Adding…' : 'Include'}
                  </button>
                )}
                {m.state === 'pending' && !sourceMissing && (
                  // #776 §3: distribution is system work — the reconcile loop syncs
                  // pending members itself. A manual action only appears once that
                  // loop has reported an error for this member (then it's a Retry,
                  // with the last error + timestamp); otherwise it just reads
                  // "syncing…" and heals on its own.
                  m.reconcile && m.reconcile.lastError ? (
                    <>
                      <span
                        title={`Last sync error${m.reconcile.lastAttemptAt ? ` at ${fmtWhen(m.reconcile.lastAttemptAt)}` : ''}: ${m.reconcile.lastError}${m.reconcile.exhausted ? ' — giving up after repeated failures' : ''}`}
                        style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: 'var(--eb-status-error, #d33)', whiteSpace: 'nowrap', cursor: 'help' }}>
                        {m.reconcile.exhausted ? 'sync failed' : 'retrying…'}
                      </span>
                      <button disabled={!!busy} onClick={() => onActivate(m.agentId, { onlyMembers: [m.agentId], scoped: true })} title={`Re-run the workspace sync now. Last error: ${m.reconcile.lastError}`} style={linkBtn}>
                        {busy === m.agentId ? 'Syncing…' : 'Retry'}
                      </button>
                    </>
                  ) : (
                    <span title="The orchestrator is syncing this member — no action needed." style={{ flexShrink: 0, fontSize: 10, color: 'var(--eb-text-muted)', whiteSpace: 'nowrap' }}>syncing…</span>
                  )
                )}
                {m.state === 'pending' && sourceMissing && (
                  <span title="This skill’s files are no longer available, so it can’t be installed for this agent." style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: 'var(--eb-status-error, #d33)', whiteSpace: 'nowrap' }}>can’t install</span>
                )}
              </div>
            );
          })}
          {resyncable > 0 && (
            <div style={{ marginTop: 'var(--eb-space-3)' }}>
              <button disabled={!!busy} onClick={() => onResync({ teamId }, 'resync')} title="Sync all outdated copies of this skill to the current source content (edited/conflicted copies are left untouched)" style={{ ...footerBtn }}>
                {busy === 'resync' ? 'Syncing…' : `Sync all outdated (${resyncable})`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Action footer ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 'var(--eb-space-4)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        {act && act.active ? (
          <button disabled={busy === 'deactivate'} onClick={() => setConfirmDeactivate(true)} style={footerBtn}>
            {busy === 'deactivate' ? 'Deactivating…' : 'Deactivate…'}
          </button>
        ) : (
          <button disabled={busy === 'activate'} onClick={() => onActivate('activate')} style={footerBtn}>
            {busy === 'activate' ? 'Activating…' : 'Activate'}
          </button>
        )}
        <button onClick={onShare} style={ghostBtn}><Share2 size={13} />Share…</button>
        {/* Distill's "?", deliberately OUTSIDE the team-tier branch below: the
            operator looking at a pool skill and wondering why it cannot be
            distilled here needs the chapter at least as much as the one who can
            press the button (#1985). */}
        <PageHelpButton
          label="What distill, consolidate and domains do"
          size={13}
          section={KNOWLEDGE_HELP_SECTIONS.powerTools}
        />
        {skill.tier === 'team' && (
          <button
            onClick={previewDistill}
            disabled={distillBusy}
            title="Re-synthesise the whole skill from its accumulated content — dedupe, restructure, re-abstract. Shows a diff before applying."
            style={ghostBtn}>
            <Sparkles size={13} />{distillBusy && distill && distill.loading ? 'Distilling…' : 'Distill…'}
          </button>
        )}
        <a href={editorHref} style={ghostBtn} title="Open this skill in the Skills Registry with the tier/team filter applied">
          Open in Skill Editor <ExternalLink size={12} />
        </a>
        {skill.tier === 'team' && (
          <div style={{ position: 'relative', marginLeft: 'auto' }}>
            <button onClick={() => setMenuOpen(o => !o)} title="More actions" style={{ ...ghostBtn, padding: '4px 8px' }}>
              <MoreHorizontal size={16} />
            </button>
            {menuOpen && (
              <div style={{ position: 'absolute', right: 0, bottom: '110%', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', boxShadow: 'var(--eb-shadow-lg)', minWidth: 140, zIndex: 62 }}>
                <button
                  disabled={!!busy}
                  onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 12px', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error, #d33)', cursor: 'pointer' }}>
                  <Trash2 size={13} />Delete…
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDeactivate}
        title="Deactivate skill"
        variant="info"
        confirmLabel="Deactivate"
        message={`The skill stays in the team library. It will be removed from ${installedCount === 1 ? '1 agent workspace' : `all ${installedCount} agent workspaces`} on the next sync. You can activate it again at any time.`}
        onConfirm={() => { setConfirmDeactivate(false); onDeactivate(); }}
        onCancel={() => setConfirmDeactivate(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete team skill"
        variant="danger"
        confirmLabel="Delete"
        message={`Delete team skill "${skill.label}"? A restorable snapshot is archived, then the skill is removed from the team pool. This can’t be undone from here.`}
        onConfirm={() => { setConfirmDelete(false); onDelete(false); }}
        onCancel={() => setConfirmDelete(false)}
      />
      {distill && (
        <div
          onClick={() => !distillBusy && setDistill(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', boxShadow: 'var(--eb-shadow-lg)', maxWidth: 900, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={15} style={{ color: 'var(--eb-status-warning)' }} />
              <strong style={{ fontSize: 'var(--eb-text-sm)' }}>Distill “{skill.label}”</strong>
            </div>
            <div style={{ padding: 'var(--eb-space-4)', overflow: 'auto', flex: 1 }}>
              {distill.loading && <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Re-synthesising the skill…</div>}
              {distill.error && <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-sm)' }}>Distillation failed: {distill.error}</div>}
              {!distill.loading && !distill.error && !distill.changed && (
                <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                  {distill.reason === 'llm-failed'
                    ? 'The re-synthesis did not produce a usable result — the skill is left unchanged.'
                    : 'The distillation produced no change — the skill is already well-structured.'}
                </div>
              )}
              {!distill.loading && !distill.error && distill.changed && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 4 }}>Current</div>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-elevated)', padding: 8, borderRadius: 6, margin: 0, maxHeight: '55vh', overflow: 'auto' }}>{distill.old}</pre>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 4 }}>Distilled</div>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-elevated)', padding: 8, borderRadius: 6, margin: 0, maxHeight: '55vh', overflow: 'auto' }}>{distill.new}</pre>
                  </div>
                </div>
              )}
            </div>
            <div style={{ padding: 'var(--eb-space-3) var(--eb-space-4)', borderTop: '1px solid var(--eb-border-default)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDistill(null)} disabled={distillBusy} style={ghostBtn}>Close</button>
              {!distill.loading && !distill.error && distill.changed && (
                <button onClick={applyDistill} disabled={distillBusy} style={primaryBtn}>
                  {distillBusy ? 'Applying…' : 'Apply distillation'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </SidePanel>
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
                <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
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

function SuggestionCard({ suggestion, onReview, onDismiss, onUndismiss, onAddMerge, onRetire, inBasket, selectable, selected, onToggleSelect }) {
  const related = suggestion.source === 'related';
  // #919: a decay card proposes RETIRING an unused lesson (never promoting) —
  // its primary action archives via the same path as the manual Retire button.
  const decay = suggestion.source === 'decay';
  // #2592: one card per knowledge domain — creates or updates THE domain's skill.
  const domainCard = suggestion.source === 'domain-skill';
  const evidence = decay && suggestion.evidence && typeof suggestion.evidence === 'object' ? suggestion.evidence : null;
  const dismissed = suggestion.status === 'dismissed';
  const stale = suggestion.status === 'stale';
  const resolved = dismissed || stale; // dimmed + restore-only
  return (
    <div style={{
      ...amberCard, flexDirection: 'column', alignItems: 'stretch', gap: 6,
      ...(selected ? { borderStyle: 'solid', borderColor: 'var(--eb-accent-primary)', background: 'var(--eb-accent-muted)' } : {}),
      ...(resolved ? { opacity: 0.7, borderStyle: 'solid', borderColor: 'var(--eb-border-default)' } : {}),
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {selectable && (
          <button
            onClick={onToggleSelect}
            title={selected ? 'Deselect' : 'Select for a bulk action'}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', flexShrink: 0 }}>
            {selected
              ? <CheckCircle2 size={14} style={{ color: 'var(--eb-accent-primary)' }} />
              : <Circle size={14} style={{ color: 'var(--eb-text-muted)' }} />}
          </button>
        )}
        {decay
          ? <Archive size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
          : related
            ? <Combine size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
            : <Sparkles size={12} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />}
        <span
          title={decay
            ? 'No agent has retrieved this lesson for a long time — consider retiring it. Confirming uses the same non-destructive archive as the manual Retire button; nothing is deleted.'
            : related
              ? 'Several distinct but related lessons about one topic — review to combine them into a single reusable skill.'
              : 'This knowledge looks important enough to become a reusable skill. Review it to promote — or dismiss it.'}
          style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-warning)', cursor: 'help' }}>
          {decay ? 'Retire suggestion — unused lesson' : domainCard ? `${suggestion.mode === 'extend' ? 'Update' : 'Create'} domain skill` : related ? 'Related lessons — suggested skill' : 'Suggested skill'}
        </span>
        {suggestion.domainName && (
          <span
            title={domainCard
              ? `Accepting this card ${suggestion.mode === 'extend' ? 'extends' : 'creates'} the skill of the “${suggestion.domainName}” domain (${suggestion.domainSkill}) — every domain grows into exactly one skill.`
              : `This lesson was routed to the “${suggestion.domainName}” knowledge domain.`}
            style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', cursor: 'help' }}>
            → {suggestion.domainName}
          </span>
        )}
        <span
          style={{ marginLeft: 'auto', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', cursor: 'help' }}
          title={decay
            ? 'How long this lesson has gone unretrieved (searches and digest builds both count as use)'
            : domainCard
              ? `${suggestion.lessonCount} pending lesson(s) of this domain from ${suggestion.convergenceCount} agent(s)`
            : related
              ? `${suggestion.lessonCount} related lessons from ${suggestion.convergenceCount} agent(s) — they belong to one topic`
              : suggestion.source === 'agent-nominated'
                ? 'An agent itself nominated this as worth promoting'
                : `${suggestion.convergenceCount} agents learned this independently`}>
          {decay
            ? (evidence ? `unused ${evidence.unusedDays}d` : 'unused')
            : related || domainCard
              ? `${suggestion.lessonCount} lessons · ${suggestion.convergenceCount} agent${suggestion.convergenceCount === 1 ? '' : 's'}`
              : `${suggestion.convergenceCount}× learned${suggestion.source === 'agent-nominated' ? ' · nominated' : ''}`}
        </span>
      </div>
      {evidence && (
        <div style={{ fontSize: 10, color: 'var(--eb-text-muted)' }}>
          not used in {evidence.unusedDays} days · {evidence.searchHits} search{evidence.searchHits === 1 ? '' : 'es'} ·{' '}
          {evidence.digestCount > 0 ? `${evidence.digestCount} digest inline${evidence.digestCount === 1 ? '' : 's'}` : 'never in a digest'}
          {' '}· horizon {evidence.horizonDays}d
        </div>
      )}
      {suggestion.semanticMatch && (
        <div
          title="Some of these lessons were grouped by meaning (embedding similarity), not word overlap — worth a quick sanity check that they really are the same lesson before promoting."
          style={{ fontSize: 10, color: 'var(--eb-text-muted)', cursor: 'help' }}>
          ⚡ semantic match — grouped by meaning, not wording
        </div>
      )}
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', wordBreak: 'break-word' }}>
        {suggestion.text}
        {related && suggestion.lessonCount > 1 && (
          <span style={{ color: 'var(--eb-text-muted)' }}> + {suggestion.lessonCount - 1} related lesson{suggestion.lessonCount === 2 ? '' : 's'}</span>
        )}
      </div>
      {dismissed && suggestion.dismissReason && (
        <div style={{ fontSize: 10, color: 'var(--eb-text-muted)' }}>
          dismissed · {DISMISS_REASON_LABELS[suggestion.dismissReason] || suggestion.dismissReason}
        </div>
      )}
      {stale && (
        <div style={{ fontSize: 10, color: 'var(--eb-text-muted)' }}>
          stale · no new evidence{suggestion.staleAt ? ` since ${fmtWhen(suggestion.staleAt)}` : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-end', alignItems: 'center' }}>
        {resolved ? (
          onUndismiss && (
            <button onClick={onUndismiss} title={stale ? 'Bring this suggestion back into the inbox' : 'Put this suggestion back in the inbox'} style={{ ...miniBtn, display: 'flex', alignItems: 'center', gap: 4 }}>
              <RotateCcw size={11} /> {stale ? 'Restore' : 'Un-dismiss'}
            </button>
          )
        ) : (
          <>
            {onDismiss && (
              <button onClick={onDismiss} title="Turn this suggestion down — it won’t be re-proposed. The underlying lessons stay in team knowledge." style={{ ...miniBtn, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Ban size={11} /> Dismiss
              </button>
            )}
            {!decay && onAddMerge && (
              <button onClick={onAddMerge} disabled={inBasket} title="Collect this suggestion in the merge basket to combine several into one skill" style={{ ...miniBtn, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Combine size={11} /> {inBasket ? 'In basket' : 'Add to merge'}
              </button>
            )}
            {decay ? (
              onRetire && (
                <button onClick={onRetire} title="Retire this lesson — same non-destructive archive as the manual Retire button (kept in git, un-retirable any time)" style={primaryBtn}>
                  <Archive size={12} /> Retire lesson
                </button>
              )
            ) : (
              <button onClick={onReview} title="Open the review dialog — nothing is promoted until you confirm" style={primaryBtn}>Review &amp; promote</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Structured dismiss reasons — the closed set the orchestrator validates (#775).
const DISMISS_REASON_LABELS = {
  'not-relevant': 'not relevant',
  'already-covered': 'already covered',
  'too-specific': 'too specific',
};

// Small modal to pick an optional reason when dismissing one suggestion.
function DismissDialog({ suggestion, onCancel, onConfirm }) {
  const [reason, setReason] = useState(null);
  return (
    <div
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-4)', width: 'min(440px, 92vw)' }}>
        <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)', marginBottom: 6 }}>
          Dismiss this suggestion?
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-3)' }}>
          It won’t be proposed again. The underlying lessons stay in team knowledge, and you can un-dismiss it later from “View all”.
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', marginBottom: 4 }}>Reason (optional)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 'var(--eb-space-3)' }}>
          {Object.entries(DISMISS_REASON_LABELS).map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', cursor: 'pointer' }}>
              <input type="radio" name="dismiss-reason" checked={reason === k} onChange={() => setReason(reason === k ? null : k)} onClick={() => reason === k && setReason(null)} />
              {label}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={miniBtn}>Cancel</button>
          <button onClick={() => onConfirm(reason)} style={primaryBtn}>Dismiss</button>
        </div>
      </div>
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
          text: 'These exist only in one agent’s workspace — teammates can’t use them. “Lift to team” copies a skill into the team pool so every agent on the team loads it. An edited copy of a skill the agent was granted shows here too — “Publish” pushes the edit up to the team pool and/or the global pool directly.',
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
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                {sk.name}
                {sk.granted && (
                  <span style={{ marginLeft: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-normal)' }}>
                    (edited copy of a granted skill)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{sk.agentId}</div>
            </div>
            {sk.granted ? (
              <PublishSkillAction name={sk.name} agentId={sk.agentId} teamId={teamId} onPublished={() => onLifted && onLifted()} />
            ) : (
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
            )}
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
/* #919: the curation-health strip — the 30-day counters the nightly pass
 * persists, amber when the convergence pipeline looks silently dead (pushes
 * happening, nothing converging). Ambient only: the feed carries one event per
 * state transition; this strip is the always-visible surface. Renders nothing
 * until the first nightly pass has produced a record. */
function CurationHealthStrip({ teamId }) {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let alive = true;
    setHealth(null);
    fetch(`/api/knowledge/curation-health?team=${encodeURIComponent(teamId)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(h => { if (alive) setHealth(h); })
      .catch(() => {});
    return () => { alive = false; };
  }, [teamId]);
  if (!health || health.status === 'unknown' || !health.windowDays) return null;
  const silent = health.status === 'silent';
  return (
    <span
      title={silent
        ? `Agents pushed knowledge ${health.pushesSeen}× in the last ${health.windowDays} days, but nothing was raised or promoted — the convergence pipeline may be silently broken.`
        : `Curation activity over the last ${health.windowDays} days: suggestions raised, skills promoted, suggestions dismissed.`}
      style={{ fontSize: 'var(--eb-text-xs)', color: silent ? 'var(--eb-status-warning)' : 'var(--eb-text-muted)', cursor: 'help' }}>
      {silent ? '⚠ ' : ''}curation {health.windowDays}d: {health.suggestionsRaised} raised · {health.promoted} promoted · {health.dismissed} dismissed
    </span>
  );
}

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
          <SummaryPill label="Autonomy" value={`${autonomy} · ${current.label}`} title={current.desc} />
          <SummaryPill label="Review" value={review ? 'on' : 'off'}
            title={autonomy < 1 ? 'Review needs autonomy 1 or higher — at 0, nothing is shared in the first place.' : (review ? 'New lessons wait for your approval before they are shared.' : 'New lessons are shared immediately.')} />
          {GATE_ORDER.map(tr => (
            <SummaryPill key={tr} label={GATE_LABELS[tr]}
              value={tr === 'team>global' ? 'always reviewed' : ((g[tr] || 'review') === 'auto' ? 'automatic' : 'needs review')}
              title={GATE_TIPS[tr]} />
          ))}
          <SummaryPill
            label="Forgetting"
            value={gates.decayHorizonDays === 0 ? 'off' : `${gates.decayHorizonDays ?? 60} days`}
            title={gates.decayHorizonDays === 0
              ? 'The nightly sweep never proposes retiring unused lessons for this team.'
              : `Lessons unused for ${gates.decayHorizonDays ?? 60} days get a retire suggestion — you confirm or dismiss; nothing is archived automatically.`} />
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
  // Mounted only while slid out, so the subject needs no `active` flag. Same
  // z-index reason as the skill inspector: this panel hosts two "?" of its own
  // and would otherwise open the help panel underneath itself (#1985).
  useHelpSubject({ overlay: OVERLAY_KNOWLEDGE_CONFIG });

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

  /* ── Assist synthesis provider (#1213) ── */
  // The team agent's own model-options carries the set of providers usable by
  // this team plus the currently-selected `assistLlmEndpointId`. oauth-token
  // seats are filtered out — they cannot back server-side synthesis calls.
  const [assistEndpoints, setAssistEndpoints] = useState([]);
  const [assistEndpointId, setAssistEndpointId] = useState('');
  const [assistBusy, setAssistBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/ssh-keys').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/github-tokens').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/agents/${encodeURIComponent(teamId)}/model-options`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([keys, toks, mo]) => {
      if (!alive) return;
      setSshKeys(Array.isArray(keys) ? keys : []);
      setTokens(Array.isArray(toks) ? toks : []);
      if (mo) {
        setAssistEndpoints((mo.endpoints || []).filter(e => e && e.authType !== 'oauth-token'));
        setAssistEndpointId(mo.assistLlmEndpointId || '');
      }
    });
    return () => { alive = false; };
  }, [teamId]);

  const saveAssist = (nextId) => {
    setAssistBusy(true);
    setAssistEndpointId(nextId); // optimistic
    fetch(`/api/agents/${encodeURIComponent(teamId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistLlmEndpointId: nextId || null }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        feedback('ok', nextId ? 'Assist provider saved.' : 'Assist provider cleared — synthesis uses the platform default.');
        onChanged && onChanged();
      })
      .catch(e => feedback('error', `Not saved: ${e.message}`))
      .finally(() => setAssistBusy(false));
  };

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
        {/* The panel's own "?" — the forgetting / assist-model / storage chapter,
            which is what the three sections below the ladder cover (#1985). */}
        <PageHelpButton
          label="About these knowledge settings"
          size={13}
          style={{ marginLeft: 4, verticalAlign: '-2px' }}
          section={KNOWLEDGE_HELP_SECTIONS.configuration}
        />
      </p>

      {/* The autonomy ladder's own "?" sits HERE and not inside
          KnowledgeLearningSections: that component is also rendered by the Agent
          Team wizard's Knowledge step, where openHelpFor() would resolve against
          /team-setup and land on a different topic. The wizard step is #1991's
          to wire (#1985). */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'calc(-1 * var(--eb-space-2))' }}>
        <PageHelpButton
          label="How autonomy, review and the promotion gates work"
          size={13}
          section={KNOWLEDGE_HELP_SECTIONS.autonomy}
        />
      </div>

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

      {/* Forgetting (#919) — the nightly sweep only PROPOSES; retiring is always
          a human click, at every autonomy level. */}
      <PanelSection
        title="Forgetting"
        blurb="Propose retiring lessons nobody has used for a while. A lesson counts as used whenever an agent's knowledge search returns it or a digest inlines it — so the conventions and validated lessons the team lives off are never proposed. Stale lessons show up as retire suggestions in the skills inbox; you confirm or dismiss each one, and confirming uses the same reversible archive as the manual Retire button. Nothing is ever archived automatically.">
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
          {[[0, 'Off'], [30, '30 days'], [60, '60 days'], [90, '90 days']].map(([days, label]) => (
            <Chip
              key={days}
              active={(gates.decayHorizonDays ?? 60) === days}
              title={days === 0
                ? 'Never propose retiring lessons — today’s behaviour exactly'
                : `Propose retiring lessons unused for ${days} days${days === 60 ? ' (default)' : ''}`}
              onClick={() => (gates.decayHorizonDays ?? 60) !== days && busy !== 'decay'
                && call('decay', '/api/knowledge/decay', { teamId, decayHorizonDays: days })}>
              {label}{days === 60 ? ' · default' : ''}
            </Chip>
          ))}
        </div>
      </PanelSection>

      {/* First domain skill threshold (#2592) — how much converged evidence a
          knowledge domain needs before its (one) skill is first written. Once the
          skill exists, every further routed lesson extends it. */}
      <PanelSection
        title="First domain skill"
        blurb="Each knowledge domain grows into exactly one team skill. Its first version is only written once enough converged lessons have been routed to the domain — below that, lessons wait in the domain’s queue (they stay in the digest meanwhile). After the skill exists, every new lesson of the domain extends it.">
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
          {[[2, 2], [3, 2], [5, 2], [5, 3]].map(([minLessons, minAgents]) => {
            const cur = gates.domainSkillThreshold || { minLessons: 3, minAgents: 2 };
            const active = cur.minLessons === minLessons && cur.minAgents === minAgents;
            const isDefault = minLessons === 3 && minAgents === 2;
            return (
              <Chip
                key={`${minLessons}-${minAgents}`}
                active={active}
                title={`Write a domain’s first skill once ≥${minLessons} lessons from ≥${minAgents} agents are routed to it${isDefault ? ' (default)' : ''}`}
                onClick={() => !active && busy !== 'domain-threshold'
                  && call('domain-threshold', '/api/knowledge/domain-skill-threshold', { teamId, minLessons, minAgents })}>
                ≥{minLessons} lessons · ≥{minAgents} agents{isDefault ? ' · default' : ''}
              </Chip>
            );
          })}
        </div>
      </PanelSection>

      {/* Assist model (#1213) — the provider the team's AUTONOMOUS synthesis
          (curator auto-promotion + skill distillation) bills against. These runs
          have no user session, so the console's per-user assist selector can't
          apply; the choice is team-derived here instead. Unset → platform
          default (.env). oauth-token seats never appear (not billable). */}
      <PanelSection
        title="Assist model"
        blurb="Which registered Model Provider this team’s automatic knowledge synthesis is billed against — when the curator promotes converged lessons into a skill, or re-distills one. These runs happen on their own, with no person driving them, so they can’t use the per-user model picker in the header. Leave it on the platform default unless this team’s AI spend must be attributed to a specific provider key.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', maxWidth: 460 }}>
          <label style={lbl}>Provider</label>
          <select
            value={assistEndpointId}
            disabled={assistBusy}
            onChange={e => saveAssist(e.target.value)}
            style={inp}>
            <option value="">Platform default (.env)</option>
            {assistEndpoints.map(ep => (
              <option key={ep.id} value={ep.id}>
                {ep.name || ep.id}{ep.defaultModelId ? ` · ${ep.defaultModelId}` : ''}
              </option>
            ))}
          </select>
          {assistEndpoints.length === 0 && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.4 }}>
              No selectable providers for this team yet — synthesis uses the platform default. Register an api-key Model Provider for this team to choose one.
            </div>
          )}
        </div>
      </PanelSection>

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

function Provenance({ detail, onClose, onOpenAgent, onArchive, onValidity, onTriggers, onOpenItem }) {
  const { entry, links } = detail;
  const archived = entry.status === 'archived';
  const promoted = entry.status === 'promoted';
  // #916 bitemporal validity: expiry is derived from validTo (field, not status).
  const expired = typeof entry.validTo === 'string' && entry.validTo !== '' && entry.validTo < new Date().toISOString();
  const [validDate, setValidDate] = useState((entry.validTo || '').slice(0, 10));
  useEffect(() => { setValidDate((entry.validTo || '').slice(0, 10)); }, [entry.id, entry.validTo]);
  // #917: local editing state for the auto-load triggers; Save persists the list.
  const savedTriggers = Array.isArray(entry.loadTriggers) ? entry.loadTriggers : [];
  const [triggers, setTriggers] = useState(savedTriggers);
  const [newType, setNewType] = useState('keyword');
  const [newPattern, setNewPattern] = useState('');
  useEffect(() => {
    setTriggers(Array.isArray(entry.loadTriggers) ? entry.loadTriggers : []);
    setNewPattern('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);
  const triggersDirty = JSON.stringify(triggers) !== JSON.stringify(savedTriggers);
  const addTrigger = () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    if (triggers.some(t => t.type === newType && t.pattern.toLowerCase() === pattern.toLowerCase())) { setNewPattern(''); return; }
    setTriggers([...triggers, { type: newType, pattern }]);
    setNewPattern('');
  };
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
        <Lineage label="Validity">
          <div style={{ fontSize: 'var(--eb-text-sm)', color: expired ? 'var(--eb-status-warning)' : 'var(--eb-text-primary)' }}
            title="When this fact was (or is) true. Expired entries drop out of the digest, search and the active graph automatically — nothing is deleted.">
            From {(entry.validFrom || entry.createdAt || '?').slice(0, 10)} · {entry.validTo
              ? <>until {entry.validTo.slice(0, 10)}{expired ? ' — expired' : ''}</>
              : 'open-ended'}
          </div>
          {entry.supersededBy && (
            <button
              onClick={() => onOpenItem && onOpenItem(entry.supersededBy, entry.teamId)}
              title="This fact was replaced by a newer entry — open it"
              style={{
                marginTop: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)',
                background: 'var(--eb-accent-muted)', border: 'none', padding: '1px 8px',
                borderRadius: 'var(--eb-radius-full)', cursor: onOpenItem ? 'pointer' : 'default',
              }}>
              superseded by {entry.supersededBy}
            </button>
          )}
          {onValidity && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
              <input
                type="date"
                value={validDate}
                onChange={e => setValidDate(e.target.value)}
                title="Valid until — the date this stops being true (inclusive)"
                style={{ ...inp, padding: '2px 6px', fontSize: 'var(--eb-text-xs)', width: 'auto', flex: 1 }}
              />
              <button
                onClick={() => onValidity(entry.id, entry.teamId, validDate)}
                disabled={!validDate || validDate === (entry.validTo || '').slice(0, 10)}
                title="Set the valid-until date — the entry expires everywhere active on that date"
                style={{ ...miniBtn }}>
                Set
              </button>
              {entry.validTo && (
                <button
                  onClick={() => onValidity(entry.id, entry.teamId, null)}
                  title="Clear the valid-until date — the entry is current again everywhere"
                  style={{ ...miniBtn }}>
                  Clear
                </button>
              )}
            </div>
          )}
        </Lineage>
        {onTriggers && (
          <Lineage label="Auto-load when…">
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5, marginBottom: 4 }}
              title="Trigger patterns (#917): when an incoming task matches, this lesson is injected into the agent's knowledge-scoped.md for that session — visible in the Workspace Browser. No triggers = today's behaviour.">
              {triggers.length === 0 ? 'No triggers — loads only via digest or search.' : 'Injected when the task matches:'}
            </div>
            {triggers.map((t, i) => (
              <div key={`${t.type}:${t.pattern}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)', background: 'var(--eb-accent-muted)', padding: '1px 8px', borderRadius: 'var(--eb-radius-full)' }}>
                  {t.type}: {t.pattern}
                </span>
                <button onClick={() => setTriggers(triggers.filter((_, j) => j !== i))} title="Remove this trigger" style={{ ...miniBtn, padding: '0 6px' }}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
              <select value={newType} onChange={e => setNewType(e.target.value)} style={{ ...inp, width: 'auto', padding: '2px 4px', fontSize: 'var(--eb-text-xs)' }}>
                <option value="keyword">keyword</option>
                <option value="path">path</option>
              </select>
              <input
                value={newPattern}
                onChange={e => setNewPattern(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addTrigger()}
                placeholder={newType === 'path' ? 'e.g. src/jobs/*.jcl' : 'e.g. jcl'}
                style={{ ...inp, flex: 1, padding: '2px 6px', fontSize: 'var(--eb-text-xs)' }}
              />
              <button onClick={addTrigger} disabled={!newPattern.trim()} style={{ ...miniBtn }}>Add</button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {(entry.tags || []).length > 0 && triggers.length === 0 && (
                <button
                  onClick={() => setTriggers((entry.tags || []).map(tag => ({ type: 'keyword', pattern: tag })))}
                  title="Pre-fill keyword triggers from this entry's tags — you confirm with Save, nothing is derived silently"
                  style={{ ...miniBtn }}>
                  Derive from tags
                </button>
              )}
              {triggersDirty && (
                <button
                  onClick={() => onTriggers(entry.id, entry.teamId, triggers)}
                  title="Save the trigger list"
                  style={{ ...primaryBtn, padding: '2px 10px', fontSize: 'var(--eb-text-xs)' }}>
                  Save triggers
                </button>
              )}
            </div>
          </Lineage>
        )}
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

function deactivateSkill(teamId, skillName) {
  return fetch('/api/knowledge/deactivate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, skillName }),
  }).then(async r => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  });
}

function dismissSuggestion(teamId, id, reason) {
  return fetch(`/api/knowledge/promotion-suggestions/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: teamId, ...(reason ? { reason } : {}) }),
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return true; });
}

function undismissSuggestion(teamId, id) {
  return fetch(`/api/knowledge/promotion-suggestions/${encodeURIComponent(id)}/undismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: teamId }),
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return true; });
}

// Run an async action over each selected item sequentially, collecting a
// per-item {label, ok, error} so a partial failure names exactly what failed
// (#775 AC4). Never rejects — the bulk bar always reports a full tally.
// `labelOf` turns an item into a human-readable name (skills have `.label`,
// suggestions fall back to their draft name / text / id).
async function runBulk(items, fn, labelOf) {
  const name = labelOf || (it => it.label || (it.draft && it.draft.name)
    || (it.text ? `${it.text.slice(0, 40)}…` : it.id));
  const results = [];
  for (const it of items) {
    try { await fn(it); results.push({ label: name(it), ok: true }); }
    catch (e) { results.push({ label: name(it), ok: false, error: e.message }); }
  }
  return results;
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
  const [name, setName] = useState((suggestion.source === 'domain-skill' && suggestion.domainSkill) || suggestion.draft?.name || '');
  const [skillMd, setSkillMd] = useState(suggestion.draft?.skillMd || '');
  const [tier, setTier] = useState('team');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [activateNow, setActivateNow] = useState(true);
  // #630 AC3: extending a global/adopted skill from a team-framed dialog is a
  // write to EVERY team's copy — require an explicit acknowledgment (not just a
  // soft warning) before it can proceed. Reset whenever the target changes.
  const [ackGlobal, setAckGlobal] = useState(false);
  // #559: pre-ticked "remove the source knowledge, now captured in this skill".
  // Default = remove, so the KB stays lean; the operator can untick to keep it.
  const [removeSource, setRemoveSource] = useState(true);
  const [result, setResult] = useState(null); // combined promote+activate outcome
  // Create a NEW skill (default) vs extend an EXISTING one (issue #553). When the
  // converged cluster auto-matches a skill (AC4) we open straight in extend mode
  // with that skill pre-selected — the operator can always switch back.
  const [mode, setMode] = useState(suggestion.matchedSkill ? 'extend' : 'create');
  const [targetName, setTargetName] = useState(suggestion.matchedSkill?.name || '');
  // #2592: a domain card lands in exactly ONE place — the domain's team skill
  // (created when missing, extended when present). The target is fixed; the server
  // rejects any other name/tier for it.
  const domainSkill = suggestion.source === 'domain-skill' ? (suggestion.domainSkill || null) : null;
  const [skills, setSkills] = useState([]); // all eligible skills (every source/tier)

  // #921: the *name field* is the single source of truth for the draft's
  // frontmatter `name:` — whenever it changes (typing, or a draft arriving), the
  // preview's header is rewritten to match. The ref lets async draft handlers
  // read the freshest name without re-subscribing.
  const nameRef = useRef(name);
  nameRef.current = name;
  useEffect(() => {
    if (mode !== 'create') return;
    setSkillMd(md => syncFrontmatterName(md, name.trim()));
  }, [name, mode]);

  // manual = operator multi-select (no stored suggestion); aggregated = the
  // lessons are distinct and the skill is their synthesis (manual OR the
  // collector's related-theme card).
  const manual = !suggestion.id;
  const aggregated = manual || suggestion.source === 'related' || !!domainSkill;
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

  // #921: exact name collision with a skill already in the target tier — a
  // non-blocking inline hint with a suggested free suffix ("Add to an existing
  // skill" stays the intended path for a genuine same-skill collision).
  const takenNames = useMemo(() => new Set(eligible.map(s => s.name)), [eligible]);
  const nameCollision = mode === 'create' && !!name.trim() && takenNames.has(name.trim());
  const suggestedName = nameCollision ? suggestFreeName(name.trim(), takenNames) : '';
  // #921: advisory only — a frontmatter-less draft still promotes (legacy bodies
  // keep working) but can't be exported/re-imported until a header is added.
  const missingFrontmatter = mode === 'create' && !!skillMd.trim() && !hasFrontmatterMeta(skillMd);

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
  // #630 AC3: a fresh global write must be re-acknowledged — never carry a stale
  // tick across a target/tier/mode change.
  useEffect(() => { setAckGlobal(false); }, [targetName, tier, mode]);

  // Re-synthesise the chosen existing skill + the new knowledge into an editable
  // preview (AC5). Heuristic by default (instant); `useLLM` runs the LLM merge.
  const loadExtendDraft = (useLLM) => {
    if (!targetName) return;
    setBusy('draft'); setError('');
    assistFetch('/api/knowledge/extend-draft', {
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
    assistFetch('/api/knowledge/draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: teamId, entryIds: suggestion.entryIds, heuristicOnly: true }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.draft) {
          // #921: an operator-typed name wins over the draft's — sync the header.
          setSkillMd(md => md || syncFrontmatterName(d.draft.skillMd || '', nameRef.current.trim()));
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
      ? assistFetch('/api/knowledge/draft', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ team: teamId, entryIds: suggestion.entryIds }),
        })
      : assistFetch(`/api/knowledge/promotion-suggestions/${encodeURIComponent(suggestion.id)}/draft`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ team: teamId }),
        });
    req
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.draft?.skillMd) {
          // #921: keep the operator's name if one is typed (single source of
          // truth), syncing the incoming draft's frontmatter to it; only an
          // empty field adopts the draft's name.
          const kept = (nameRef.current || d.draft.name || '').trim();
          setSkillMd(syncFrontmatterName(d.draft.skillMd, kept));
          if (!nameRef.current.trim() && d.draft.name) setName(d.draft.name);
        }
      })
      .catch(() => setError('Draft failed'))
      .finally(() => setBusy(''));
  };

  const promote = () => {
    setBusy('promote'); setError('');
    // Extend an existing skill: the backend re-synthesises provenance (union) and
    // auto-syncs the refreshed content to agents that already have it (AC10).
    // #630 AC2: when "Activate immediately" is ticked, additionally activate for
    // the team so members that don't yet have the skill get it too (idempotent
    // for already-active members). Activation failure never rolls back the extend.
    if (mode === 'extend') {
      fetch('/api/knowledge/promote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'extend', from: 'team', to: effectiveTo, teamId, targetName, skillMd,
          entryIds: suggestion.entryIds, removeSourceKnowledge: removeSource,
          ...(suggestion.id ? { suggestionId: suggestion.id } : {}),
          ...(Array.isArray(suggestion.suggestionIds) && suggestion.suggestionIds.length ? { suggestionIds: suggestion.suggestionIds } : {}),
        }),
      })
        .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); })
        .then(d => {
          if (!activateNow) {
            setResult(cleanupResult(d, `Extended “${targetName}” — active agents pick up the update automatically.`));
            setBusy('');
            return;
          }
          return activateSkill(teamId, targetName.trim())
            .then(a => setResult(cleanupResult(d, `Extended “${targetName}” and ${activationSummary(a)} — including members that didn't have it yet.`)))
            .catch(e => setResult({ kind: 'warn', text: `Extended “${targetName}” — but activation failed: ${e.message}. Use the Activate button on the skill card.` }))
            .finally(() => setBusy(''));
        })
        .catch(e => { setError(e.message); setBusy(''); });
      return;
    }
    fetch('/api/knowledge/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'team', to: tier, teamId, name, skillMd,
        entryIds: suggestion.entryIds, removeSourceKnowledge: removeSource,
        ...(suggestion.id ? { suggestionId: suggestion.id } : {}),
        ...(Array.isArray(suggestion.suggestionIds) && suggestion.suggestionIds.length ? { suggestionIds: suggestion.suggestionIds } : {}),
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

        {domainSkill ? (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.5 }}>
            → <strong>{suggestion.domainName || domainSkill}</strong>{' '}
            <span style={{ color: 'var(--eb-text-muted)' }}>
              ({mode === 'extend' ? 'updates' : 'creates'} the team skill <code>{domainSkill}</code> — one skill per domain)
            </span>
          </div>
        ) : (<>
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
        </>)}

        {domainSkill ? null : mode === 'create' ? (
          <>
            <label style={lbl}>Skill name</label>
            <input value={name} onChange={e => setName(e.target.value)} style={inp} />
            {nameCollision && (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', lineHeight: 1.5 }}>
                A skill named “{name.trim()}” already exists here. Consider{' '}
                <button onClick={() => setName(suggestedName)} style={{ ...btn, display: 'inline-flex', padding: '0 4px' }}>
                  {suggestedName}
                </button>
                {' '}— or use “Add to an existing skill” to fold this knowledge into it.
              </div>
            )}
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
                display: 'flex', gap: 8, alignItems: 'flex-start',
              }}>
                <input type="checkbox" id="kf-promote-ack-global" checked={ackGlobal}
                  onChange={e => setAckGlobal(e.target.checked)} style={{ marginTop: 3, flexShrink: 0 }} />
                <label htmlFor="kf-promote-ack-global" style={{ cursor: 'pointer' }}>
                  <strong>“{targetName}” is a global skill</strong> — shared with every team. I understand that
                  extending it here updates it for <strong>all teams</strong>, not just this one.
                </label>
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
        {missingFrontmatter && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)', lineHeight: 1.5 }}>
            This draft has no <code>name</code>/<code>description</code> frontmatter header. It still
            promotes, but the skill can’t be exported and re-imported until a header is added, and the
            description is what tells agents when to load it.
          </div>
        )}

        {/* Activation is the default last step of every pool-filling flow. In
            CREATE it adds the new skill to the team. In EXTEND (#630 AC2) the
            refreshed content is already auto-synced to agents that HAVE the skill;
            activating additionally reaches members that don't have it yet (added
            since, or a team that adopted but never activated) — otherwise they
            stay stale with no hint. */}
        {(tier === 'team' || tier === 'global') && !result && (
          <ActivateNowCheckbox
            id="kf-promote-activate"
            checked={activateNow}
            onChange={setActivateNow}
            label="Activate for the team immediately"
            description={mode === 'extend'
              ? <>Agents that already have “{targetName || 'this skill'}” pick up the refreshed content automatically.
                  Activating also copies it to members that don't have it yet and adds it to the team's active skills.
                  Members with their own skill list are excluded — add them afterwards from the skill card.</>
              : undefined}
          />
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
                disabled={!!busy || !skillMd.trim() || (mode === 'extend' ? !targetName : !name.trim()) || (globalScopeWarning && !ackGlobal)}
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
  color: 'var(--eb-text-inverted)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};

// Inline keyboard-hint pill shown on review-mode action buttons (#776 §1).
const kbdStyle = {
  fontSize: 9, fontFamily: 'var(--eb-font-mono, monospace)', padding: '0 4px', borderRadius: 3,
  border: '1px solid currentColor', opacity: 0.7, lineHeight: '14px',
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
