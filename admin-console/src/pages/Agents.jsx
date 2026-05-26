import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Plus, Trash2, Layers, ChevronDown, ChevronRight,
  Edit, MessageCircle, RefreshCw, Power, PowerOff, FileText,
  User, Users, Workflow, Info, GitMerge, Download, Upload,
} from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import useAutoDerivedId from '../hooks/useAutoDerivedId';

const hasRepos = (env) =>
  (Array.isArray(env?.repositories) && env.repositories.length > 0) ||
  !!env?.repository?.url;

function repoDirName(url) {
  if (!url) return '';
  return url.replace(/\.git$/, '').split(/[/:]/g).filter(Boolean).pop() || '';
}

/* ── BP-dependency hierarchy helpers ────────────────────────────────────
   Mirrors the topo-sort logic in admin-console/src/pages/briefings/bp-graph.js
   so the bp-instance children of an orchestrator are listed in the same
   dependency order as the BP-explorer flow view. */

function topoSortBpIds(ids, byId) {
  const idSet = new Set(ids);
  const result = [];
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const bp = byId[id];
    if (!bp) return;
    (bp.depends_on || []).forEach((depId) => {
      if (idSet.has(depId)) visit(depId);
    });
    result.push(id);
  }
  ids.forEach((id) => visit(id));
  return result;
}

function collectBpDescendants(id, byId, into) {
  const bp = byId[id];
  if (!bp || !bp.children) return;
  bp.children.forEach((cid) => {
    into.add(cid);
    collectBpDescendants(cid, byId, into);
  });
}

function topoSortBpRoots(rootIds, byId) {
  const treeMembers = {};
  rootIds.forEach((rid) => {
    const m = new Set([rid]);
    collectBpDescendants(rid, byId, m);
    treeMembers[rid] = m;
  });
  const idToRoot = {};
  rootIds.forEach((rid) => {
    treeMembers[rid].forEach((m) => { idToRoot[m] = rid; });
  });
  const rootDeps = {};
  rootIds.forEach((rid) => { rootDeps[rid] = new Set(); });
  rootIds.forEach((rid) => {
    treeMembers[rid].forEach((m) => {
      const bp = byId[m];
      if (!bp) return;
      (bp.depends_on || []).forEach((depId) => {
        const depRoot = idToRoot[depId];
        if (depRoot && depRoot !== rid) rootDeps[rid].add(depRoot);
      });
    });
  });
  const rootSet = new Set(rootIds);
  const result = [];
  const visited = new Set();
  function visit(rid) {
    if (visited.has(rid)) return;
    visited.add(rid);
    (rootDeps[rid] || new Set()).forEach((dep) => {
      if (rootSet.has(dep)) visit(dep);
    });
    result.push(rid);
  }
  rootIds.forEach((rid) => visit(rid));
  return result;
}

// Build a flat list of bp-instance rows annotated with classic
// file-tree-connector metadata: depth, ancestorMore (vertical-line flags
// per ancestor level), isLast (last sibling at its depth), hasChildren,
// and isCollapsed. The orchestrator itself is the implicit depth-0 ancestor;
// BP roots are emitted at depth 1 so every row gets a connector.
//
// Falls back to a flat alphabetical list when BP metadata is unavailable
// (still loading, fetch failed, or no agent.bpId).
function buildAgentTree(agents, bps, collapsedSet) {
  const list = Array.isArray(agents) ? agents : [];
  const collapsed = collapsedSet instanceof Set ? collapsedSet : new Set();

  if (!Array.isArray(bps) || bps.length === 0) {
    const sorted = [...list].sort(
      (a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id),
    );
    return sorted.map((a, i) => ({
      agent: a,
      depth: 1,
      ancestorMore: [],
      isLast: i === sorted.length - 1,
      hasChildren: false,
      isCollapsed: false,
    }));
  }

  const byId = {};
  bps.forEach((bp) => { if (bp && bp.id) byId[bp.id] = bp; });

  const agentByBpId = {};
  list.forEach((a) => { if (a.bpId) agentByBpId[a.bpId] = a; });

  const sortedRootBpIds = topoSortBpRoots(
    bps.filter((bp) => bp && !bp.parent).map((bp) => bp.id),
    byId,
  );

  // Depth-1 items: BP roots that have agents, then orphans (agents whose BP
  // is no longer in the directory). Orphans never have BP children.
  const depth1 = [];
  sortedRootBpIds.forEach((bpId) => {
    if (agentByBpId[bpId]) depth1.push({ kind: 'bp', bpId });
  });
  list
    .filter((a) => !a.bpId || !byId[a.bpId])
    .sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id))
    .forEach((a) => depth1.push({ kind: 'orphan', agent: a }));

  const rows = [];
  const emitted = new Set();

  function walk(items, depth, ancestorTrail) {
    items.forEach((item, idx) => {
      const isLast = idx === items.length - 1;
      let agent;
      let childIds = [];
      if (item.kind === 'bp') {
        const bp = byId[item.bpId];
        if (!bp) return;
        agent = agentByBpId[item.bpId];
        childIds = Array.isArray(bp.children) && bp.children.length > 0
          ? topoSortBpIds(bp.children, byId).filter((cid) => agentByBpId[cid])
          : [];
      } else {
        agent = item.agent;
      }
      if (!agent || emitted.has(agent.id)) return;

      const hasChildren = childIds.length > 0;
      const isCollapsed = hasChildren && collapsed.has(agent.id);
      rows.push({
        agent,
        depth,
        ancestorMore: ancestorTrail.slice(),
        isLast,
        hasChildren,
        isCollapsed,
      });
      emitted.add(agent.id);

      if (hasChildren && !isCollapsed) {
        const childItems = childIds.map((bpId) => ({ kind: 'bp', bpId }));
        walk(childItems, depth + 1, [...ancestorTrail, !isLast]);
      }
    });
  }

  walk(depth1, 1, []);
  return rows;
}

/* ── Tree connector lines ──────────────────────────────────────────────
   Renders ancestor + elbow segments as absolutely-positioned CSS lines.
   Each slot stretches across the row's full padding-box (negative vertical
   margin) so vertical lines stitch through adjacent rows without breaks —
   far more continuous than Unicode glyphs in monospace. */

const TREE_SLOT_WIDTH = 22;
const TREE_LINE_COLOR = 'var(--eb-border-default)';

const _vLine = (extra) => ({
  position: 'absolute',
  left: '50%',
  width: 1,
  background: TREE_LINE_COLOR,
  transform: 'translateX(-0.5px)',
  ...extra,
});

const _hLine = (extra) => ({
  position: 'absolute',
  top: '50%',
  height: 1,
  background: TREE_LINE_COLOR,
  transform: 'translateY(-0.5px)',
  ...extra,
});

/* ── Brief Viewer ──────────────────────────────────────────────────────
   Reads the brief.md straight from the orchestrator's already-cloned
   workspace via the existing /api/agents/:id/workspace/file endpoint.
   The orchestrator's claim loop pulls main on a throttle, so what we
   read here matches the latest committed state on the default branch. */

function stripYamlFrontmatter(text) {
  if (typeof text !== 'string') return '';
  // Match a leading --- block and remove it. Tolerates leading whitespace.
  return text.replace(/^\s*---\n[\s\S]*?\n---\s*\n?/, '');
}

// Compact, dashboard-aligned typography for the brief.md body. Without
// these the browser's default heading sizes look oversized inside a
// 640px side panel.
const BRIEF_MD_COMPONENTS = {
  h1: (props) => <h2 style={{ fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', margin: '1em 0 0.4em' }} {...props} />,
  h2: (props) => <h3 style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', margin: '1em 0 0.4em' }} {...props} />,
  h3: (props) => <h4 style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-secondary)', margin: '0.9em 0 0.3em' }} {...props} />,
  h4: (props) => <h5 style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', margin: '0.8em 0 0.3em' }} {...props} />,
  p:  (props) => <p style={{ margin: '0 0 0.6em' }} {...props} />,
  ul: (props) => <ul style={{ paddingLeft: '1.4em', margin: '0 0 0.6em' }} {...props} />,
  ol: (props) => <ol style={{ paddingLeft: '1.4em', margin: '0 0 0.6em' }} {...props} />,
  li: (props) => <li style={{ margin: '0.15em 0' }} {...props} />,
  code: ({ inline, ...props }) => inline
    ? <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: '0.92em', background: 'var(--eb-bg-elevated)', padding: '1px 5px', borderRadius: 'var(--eb-radius-sm)' }} {...props} />
    : <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: '0.9em' }} {...props} />,
  pre: (props) => <pre style={{ background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-3)', overflowX: 'auto', fontSize: '0.92em' }} {...props} />,
  blockquote: (props) => <blockquote style={{ borderLeft: '3px solid var(--eb-border-default)', paddingLeft: 'var(--eb-space-3)', color: 'var(--eb-text-secondary)', margin: '0.5em 0' }} {...props} />,
  a:  (props) => <a target="_blank" rel="noreferrer" style={{ color: 'var(--eb-accent-primary)' }} {...props} />,
  hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--eb-border-default)', margin: '1em 0' }} />,
  table: (props) => <table style={{ borderCollapse: 'collapse', width: '100%', margin: '0.5em 0', fontSize: '0.95em' }} {...props} />,
  th: (props) => <th style={{ borderBottom: '1px solid var(--eb-border-default)', padding: '4px 8px', textAlign: 'left' }} {...props} />,
  td: (props) => <td style={{ borderBottom: '1px solid var(--eb-border-default)', padding: '4px 8px' }} {...props} />,
};

function BriefViewer({ orchestratorId, relPath }) {
  const [state, setState] = useState({ loading: true, content: '', error: null, truncated: false });

  useEffect(() => {
    if (!orchestratorId || !relPath) return;
    let cancelled = false;
    setState({ loading: true, content: '', error: null, truncated: false });
    fetch(`/api/agents/${orchestratorId}/workspace/file?path=${encodeURIComponent(relPath)}`)
      .then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          throw new Error(detail.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (data.binary) {
          setState({ loading: false, content: '', error: 'Binary file', truncated: false });
        } else {
          setState({ loading: false, content: data.content || '', error: null, truncated: !!data.truncated });
        }
      })
      .catch((err) => { if (!cancelled) setState({ loading: false, content: '', error: err.message, truncated: false }); });
    return () => { cancelled = true; };
  }, [orchestratorId, relPath]);

  const body = useMemo(() => stripYamlFrontmatter(state.content), [state.content]);

  if (state.loading) {
    return <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading…</div>;
  }
  if (state.error) {
    return (
      <div role="alert" style={{
        padding: 'var(--eb-space-3)',
        background: 'var(--eb-status-error-bg)',
        border: '1px solid var(--eb-status-error)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-status-error)',
      }}>
        Failed to load: {state.error}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{
        fontFamily: 'var(--eb-font-mono)',
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
        wordBreak: 'break-all',
      }}>
        {relPath}
      </div>
      {state.truncated && (
        <div style={{
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-warning-bg)',
          border: '1px solid var(--eb-status-warning)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-status-warning)',
        }}>
          File was truncated by the workspace API — showing the first portion only.
        </div>
      )}
      <div className="brief-viewer-md" style={{
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-primary)',
        lineHeight: 1.55,
      }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={BRIEF_MD_COMPONENTS}>{body}</ReactMarkdown>
      </div>
    </div>
  );
}

function TreeConnector({ ancestorMore, isLast }) {
  return (
    <div style={{
      display: 'flex',
      alignSelf: 'stretch',
      flexShrink: 0,
      // Pull connector across the row's vertical padding so vertical lines
      // bridge the gap between adjacent rows.
      margin: 'calc(-1 * var(--eb-space-3)) 0',
    }}>
      {ancestorMore.map((more, i) => (
        <div key={i} style={{
          width: TREE_SLOT_WIDTH,
          position: 'relative',
          alignSelf: 'stretch',
        }}>
          {more && <span style={_vLine({ top: 0, bottom: 0 })} />}
        </div>
      ))}
      <div style={{
        width: TREE_SLOT_WIDTH,
        position: 'relative',
        alignSelf: 'stretch',
      }}>
        {/* top half: always — connects upward to parent */}
        <span style={_vLine({ top: 0, height: '50%' })} />
        {/* bottom half: only when this row is not the last sibling */}
        {!isLast && <span style={_vLine({ top: '50%', bottom: 0 })} />}
        {/* horizontal: from elbow corner to the right edge of the slot */}
        <span style={_hLine({ left: '50%', right: 0 })} />
      </div>
    </div>
  );
}

/* ── Shared style helpers ───────────────────────────────────────────── */
const labelStyle = {
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
  fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)',
};
const inputStyle = {
  width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
};
const helpTextStyle = {
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
  marginTop: 'var(--eb-space-1)', lineHeight: 1.5,
};

/* ── Role catalogue (single source of truth for labels + descriptions) ─ */
const ROLE_INFO = {
  'agent': {
    icon: User,
    title: 'Agent (standalone)',
    short: 'A single chat agent with its own system prompt.',
    body: (
      <>
        Creates a single agent that you can talk to in the <strong>Agent Chat</strong>.
        The system prompt you write below shapes its persona — for example a COBOL specialist,
        a code-review buddy, or a release manager. Add cron / GitHub triggers later to make
        it run autonomously in addition to responding to messages.
      </>
    ),
    when: 'Use this for one-of-a-kind agents that act on their own.',
  },
  'team': {
    icon: Users,
    title: 'Team',
    short: 'A reusable template — spawn multiple team members from one prompt.',
    body: (
      <>
        Stores a system-prompt template without creating an agent itself. Instead you click
        <strong> Add Member</strong> on the team card to spawn one or more agents that all
        share the same prompt and Working Environment, but each gets its own workspace and
        its own conversation in the Agent Chat.
      </>
    ),
    when: 'Use when you need several copies of the same kind of agent — e.g. a pool of three reviewer agents working in parallel.',
  },
  'orchestrator': {
    icon: Workflow,
    title: 'Orchestrator',
    short: 'Watches a directory of BriefingPacks and manages one agent per mission.',
    body: (
      <>
        Pointed at a folder of ACE BriefingPacks. The orchestrator scans the folder, lists one
        stub <em>bp-instance</em> per mission, and offers to materialise / claim the mission
        when it transitions to <code>dispatched</code>. Each materialised mission becomes its
        own agent with its own chat, executing the BriefingPack's LoopScript.
      </>
    ),
    when: 'Use when you have a Briefings repository (ACE) that you want to drive end-to-end through this console.',
  },
};

/* ── Role picker ───────────────────────────────────────────────────────
   Card-style radio group. Single source of truth for what each role
   means; same component is reused for the in-form info banner. */

function RoleCard({ value, current, onSelect }) {
  const info = ROLE_INFO[value];
  if (!info) return null;
  const Icon = info.icon;
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      style={{
        textAlign: 'left',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: 'var(--eb-space-3)',
        alignItems: 'flex-start',
        padding: 'var(--eb-space-3)',
        background: active ? 'var(--eb-bg-elevated)' : 'var(--eb-bg-surface)',
        border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-md)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'var(--eb-text-primary)',
        outline: active ? '2px solid var(--eb-accent-primary)' : 'none',
        outlineOffset: -2,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 'var(--eb-radius-md)',
        background: active ? 'var(--eb-accent-primary)' : 'var(--eb-bg-app)',
        color: active ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)',
        flexShrink: 0,
      }}>
        <Icon size={15} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)' }}>
          {info.title}
        </span>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
          {info.short}
        </span>
      </span>
      <span
        aria-hidden="true"
        style={{
          width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
          marginTop: 4,
          border: `2px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
          background: active ? 'var(--eb-accent-primary)' : 'transparent',
          boxShadow: active ? 'inset 0 0 0 3px var(--eb-bg-elevated)' : 'none',
        }}
      />
    </button>
  );
}

function RoleDetailBanner({ role }) {
  const info = ROLE_INFO[role];
  if (!info) return null;
  return (
    <div style={{
      display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-status-info-bg, var(--eb-bg-elevated))',
      border: '1px solid var(--eb-status-info, var(--eb-border-default))',
      borderRadius: 'var(--eb-radius-md)',
      fontSize: 'var(--eb-text-xs)',
      lineHeight: 1.6,
      color: 'var(--eb-text-primary)',
    }}>
      <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-status-info, var(--eb-text-secondary))' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
        <div>{info.body}</div>
        <div style={{ color: 'var(--eb-text-muted)' }}>
          <strong style={{ color: 'var(--eb-text-secondary)' }}>When to use:</strong> {info.when}
        </div>
      </div>
    </div>
  );
}

function PrimaryBtn({ children, onClick, disabled, saving, style = {} }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || saving}
      style={{
        padding: 'var(--eb-space-2) var(--eb-space-4)',
        background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
        border: 'none', borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
        cursor: (disabled || saving) ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        opacity: (disabled || saving) ? 0.6 : 1, ...style,
      }}
    >{children}</button>
  );
}

function SecondaryBtn({ children, onClick, style = {} }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: 'var(--eb-space-2) var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
        cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', ...style,
      }}
    >{children}</button>
  );
}

function IconBtn({ icon: Icon, label, onClick, danger, title, disabled }) {
  return (
    <button
      aria-label={label}
      title={title || label}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'none',
        border: `1px solid ${danger ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: danger ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)',
        padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon size={13} />
    </button>
  );
}

/* ── Enable/Disable toggle ──────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange, label, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      style={{
        width: 34, height: 18,
        borderRadius: 'var(--eb-radius-full)',
        border: 'none',
        background: checked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background var(--eb-transition-fast)',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 16 : 2,
        width: 14, height: 14, borderRadius: '50%',
        background: 'white',
        transition: 'left var(--eb-transition-fast)',
      }} />
    </button>
  );
}

/* ── Agent state derivation ────────────────────────────────────────── */
// Three states: stub (no token, never activated), active (token + enabled),
// paused (token + disabled). Drive UI off this single function.
function agentState(agent) {
  if (!agent.token && agent.enabled === false) return 'stub';
  if (agent.enabled === false) return 'paused';
  return 'active';
}

function StateBadge({ state }) {
  const cfg = {
    stub:    { bg: 'var(--eb-bg-app)',            color: 'var(--eb-text-muted)',     label: 'Not initialised' },
    paused:  { bg: 'var(--eb-status-warning-bg)', color: 'var(--eb-status-warning)', label: 'Paused' },
    active:  { bg: 'var(--eb-status-success-bg)', color: 'var(--eb-status-success)', label: 'Active' },
  }[state] || { bg: 'var(--eb-bg-app)', color: 'var(--eb-text-muted)', label: state };
  return (
    <span style={{
      fontSize: 'var(--eb-text-xs)', color: cfg.color, background: cfg.bg,
      padding: '2px 8px', borderRadius: 'var(--eb-radius-full)',
      border: `1px solid ${cfg.color}`,
    }}>{cfg.label}</span>
  );
}

/* ── Mission Directory Field ─────────────────────────────────────────── */
function MissionDirectoryField({ value, onChange, repoDirs }) {
  const [showCustom, setShowCustom] = useState(
    () => value !== '' && !repoDirs.includes(value)
  );

  useEffect(() => {
    setShowCustom(value !== '' && !repoDirs.includes(value));
  }, [value, repoDirs]);

  const helpText = (
    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
      Path inside the agent's workspace where ACE BriefingPacks live — usually the directory of a cloned briefings repository.
      The <code>artifacts/briefings/</code> subdirectory is appended automatically.
      On creation, the orchestrator scans this path and registers one stub <em>bp-instance</em> per mission found.
    </div>
  );

  if (repoDirs.length === 0) {
    return (
      <div>
        <div style={labelStyle}>Mission Directory</div>
        <input
          style={inputStyle}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. my-repo"
        />
        {helpText}
      </div>
    );
  }

  const selectValue = showCustom ? '__custom__' : value;

  return (
    <div>
      <div style={labelStyle}>Mission Directory</div>
      <select
        style={inputStyle}
        value={selectValue}
        onChange={e => {
          if (e.target.value === '__custom__') {
            setShowCustom(true);
          } else {
            setShowCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {!selectValue && <option value="">— please select —</option>}
        {repoDirs.map(dir => (
          <option key={dir} value={dir}>{dir}</option>
        ))}
        <option disabled value="__sep__">──────────</option>
        <option value="__custom__">Custom path…</option>
      </select>
      {showCustom && (
        <input
          style={{ ...inputStyle, marginTop: 'var(--eb-space-2)' }}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. my-repo"
          autoFocus
        />
      )}
      {helpText}
    </div>
  );
}

/* ── Agent Create Form ─────────────────────────────────────────────── */
function AgentCreateForm({ onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    id: '', displayName: '', role: 'agent', environmentId: '', systemPrompt: '',
    briefingsPath: '',
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName: v => update('displayName', v),
    setId:   v => update('id', v),
    getName: () => form.displayName,
  });
  const { data: environments } = useApi('/api/environments');
  const envs = environments || [];

  const repoDirs = useMemo(() => {
    const env = envs.find(e => e.id === form.environmentId);
    if (!env) return [];
    const repos = Array.isArray(env.repositories)
      ? env.repositories
      : env.repository?.url ? [env.repository] : [];
    return repos.map(r => repoDirName(r.url)).filter(Boolean);
  }, [envs, form.environmentId]);

  useEffect(() => {
    if (form.role !== 'orchestrator') return;
    if (repoDirs.length !== 1) return;
    if (!form.briefingsPath) update('briefingsPath', repoDirs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.role, form.environmentId, repoDirs]);

  const canSubmit = form.id && form.displayName && form.environmentId &&
    (form.role === 'orchestrator' || form.systemPrompt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <div>
        <FormInput label="Display Name *" value={form.displayName} onChange={handleNameChange} placeholder="COBOL Agent" />
        <div style={helpTextStyle}>
          A short, human-readable label shown in the agents list and chat header — e.g. <em>COBOL Agent</em>.
        </div>
      </div>

      <IdField
        value={form.id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        placeholder="e.g. cobol-agent"
        helpText={
          <>
            Auto-derived from Display Name; edit to override.
            Lowercase letters, digits and hyphens only. Used as the agent's URL
            (<code>/chats/{form.id || 'id'}</code>) and the workspace folder name.
            <strong> Cannot be changed after creation.</strong>
          </>
        }
      />

      <div>
        <div style={labelStyle}>Working Environment <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <select value={form.environmentId} onChange={e => update('environmentId', e.target.value)} style={inputStyle} disabled={envs.length === 0}>
          <option value="">— please select —</option>
          {envs.map(env => (
            <option key={env.id} value={env.id}>
              {env.name} ({env.id})
              {hasRepos(env) ? ' · Git' : ''}
              {Array.isArray(env.skills) && env.skills.length > 0 ? ` · ${env.skills.length} Skills` : ''}
            </option>
          ))}
        </select>
        <div style={helpTextStyle}>
          Defines the skills, repositories, GitHub token and model provider the agent receives at creation time.
          Manage these on the <em>Working Environments</em> page. Each agent gets its own isolated workspace,
          but the recipe is shared.
        </div>
        {envs.length === 0 && (
          <div style={{
            marginTop: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-status-warning-bg)',
            border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-primary)',
          }}>
            No Working Environments yet — create one on the <strong>Working Environments</strong> page first.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        <div style={labelStyle}>Role <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <RoleCard value="agent"         current={form.role} onSelect={v => update('role', v)} />
          <RoleCard value="team"          current={form.role} onSelect={v => update('role', v)} />
          <RoleCard value="orchestrator"  current={form.role} onSelect={v => update('role', v)} />
        </div>
        <RoleDetailBanner role={form.role} />
        {(form.role === 'team' || form.role === 'team-member') && (
          <div style={{
            display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
            padding: 'var(--eb-space-3)',
            background: 'color-mix(in srgb, var(--eb-accent-primary) 8%, transparent)',
            border: '1px solid var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-primary)',
            lineHeight: 1.6,
          }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-accent-primary)' }} />
            <span>
              Consider using the{' '}
              <Link to="/team-setup" style={{ color: 'var(--eb-accent-primary)' }}>
                Team Wizard
              </Link>{' '}
              instead — it sets up the full team structure automatically.
            </span>
          </div>
        )}
        {form.role === 'orchestrator' && (
          <div style={{
            display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
            padding: 'var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-secondary)',
            lineHeight: 1.6,
          }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-text-muted)' }} />
            <span>
              An Orchestrator monitors a directory of BriefingPacks (ACE task files) and manages their lifecycle.
              Use this only if you are working with ACE LoopScripts. See{' '}
              <Link to="/flows" style={{ color: 'var(--eb-accent-primary)' }}>
                Flows
              </Link>{' '}
              (in the nav) to visualise active orchestrators.
            </span>
          </div>
        )}
      </div>

      {form.role === 'orchestrator' && (
        <MissionDirectoryField
          value={form.briefingsPath}
          onChange={val => update('briefingsPath', val)}
          repoDirs={repoDirs}
        />
      )}

      {form.role !== 'orchestrator' && (
      <div>
        <div style={labelStyle}>
          {form.role === 'team' ? 'System Prompt Template' : 'System Prompt'}
          {' '}<span style={{ color: 'var(--eb-status-error)' }}>*</span>
        </div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-1)' }}>
          {form.role === 'team'
            ? <>Stored once and reused for every member you spawn from this team. Define the persona, expertise, and tone — each member gets its own workspace but the same instructions.</>
            : <>The persona Claude reads at startup. Describe the agent's role, expertise, communication style and any constraints. Markdown is fine; treat it like the <code>system</code> message in a chat completion.</>}
        </div>
        <textarea
          value={form.systemPrompt}
          onChange={e => update('systemPrompt', e.target.value)}
          placeholder={'You are an experienced COBOL developer with 20+ years working on mainframe migrations.\n\nWhen analysing code, always:\n- Identify the COBOL dialect (IBM Enterprise, GnuCOBOL, …)\n- Highlight any non-standard extensions\n- Suggest a Java equivalent for each paragraph'}
          rows={9}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
        />
      </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit}>
          {saving ? 'Creating…' : 'Create Agent'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Agent Edit Form ────────────────────────────────────────────────── */
function AgentEditForm({ agent, onSave, onCancel, saving, error }) {
  // Initial values for the inheritance toggles. `agent.systemPrompt` /
  // `agent.skillsOverride` absent === inheriting from the parent team.
  const initialInheritPrompt = agent.role === 'team-member'
    && !(typeof agent.systemPrompt === 'string' && agent.systemPrompt.length > 0);
  const initialInheritSkills = agent.role === 'team-member'
    && !Array.isArray(agent.skillsOverride);
  const initialInheritMcp = agent.role === 'team-member'
    && !Array.isArray(agent.mcpServersOverride);

  // MCP overrides are stored as [{serverId, credentialId|null}, ...]. We
  // serialize them for editing as one entry per line — `serverId:credentialId`,
  // or just `serverId` when no credential is bound. Same idea as the
  // skillsOverrideText field above; trades polish for less form scaffolding.
  const initialMcpText = Array.isArray(agent.mcpServersOverride)
    ? agent.mcpServersOverride.map(m => m.credentialId ? `${m.serverId}:${m.credentialId}` : m.serverId).join('\n')
    : '';

  const [form, setForm] = useState({
    displayName: agent.displayName || '',
    briefingsPath: agent.briefingsPath || '',
    // team-only field
    systemPromptTemplate: agent.systemPromptTemplate || '',
    // team-member override fields
    inheritPrompt: initialInheritPrompt,
    promptOverride: agent.systemPrompt || '',
    inheritSkills: initialInheritSkills,
    skillsOverrideText: Array.isArray(agent.skillsOverride)
      ? agent.skillsOverride.join(', ')
      : '',
    inheritMcp: initialInheritMcp,
    mcpOverrideText: initialMcpText,
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const canSubmit = !!form.displayName;

  const { data: environments } = useApi('/api/environments');
  const repoDirs = useMemo(() => {
    const envs = environments || [];
    const env = envs.find(e => e.id === agent.environmentId);
    if (!env) return [];
    const repos = Array.isArray(env.repositories)
      ? env.repositories
      : env.repository?.url ? [env.repository] : [];
    return repos.map(r => repoDirName(r.url)).filter(Boolean);
  }, [environments, agent.environmentId]);

  // For team-members: fetch the parent team's config to display its
  // current systemPromptTemplate as a preview when inheriting.
  const parentTeamUrl = agent.role === 'team-member' && agent.parentTeamId
    ? `/api/agents/${encodeURIComponent(agent.parentTeamId)}`
    : null;
  const { data: parentTeam } = useApi(parentTeamUrl || '/api/agents');
  const parentTeamPrompt = parentTeamUrl && parentTeam?.role === 'team'
    ? (parentTeam.systemPromptTemplate || '')
    : '';

  function buildSubmit() {
    const submit = {
      displayName: form.displayName,
      briefingsPath: form.briefingsPath,
    };
    if (agent.role === 'team') {
      submit.systemPromptTemplate = form.systemPromptTemplate;
    }
    if (agent.role === 'team-member') {
      // null = clear override (= switch to inherit). The API knows the convention.
      submit.systemPrompt = form.inheritPrompt ? null : form.promptOverride;
      submit.skillsOverride = form.inheritSkills
        ? null
        : form.skillsOverrideText
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
      // MCP override: parse "serverId[:credentialId]" lines into the
      // {serverId, credentialId} array shape the API expects. Empty / bare
      // server lines are kept (credentialId null) so the API can return a
      // clear "credential missing" error instead of silently dropping them.
      submit.mcpServersOverride = form.inheritMcp
        ? null
        : form.mcpOverrideText
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .map(line => {
              const [serverId, credentialId] = line.split(':').map(p => p.trim());
              return { serverId, credentialId: credentialId || null };
            });
    }
    return submit;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)' }}>
          {error}
        </div>
      )}

      <div>
        <div style={labelStyle}>ID (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.id}
        </div>
      </div>

      <div>
        <div style={labelStyle}>Role (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.role}
        </div>
      </div>

      <div>
        <div style={labelStyle}>Working Environment (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.environmentId}
        </div>
      </div>

      <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} />

      {agent.role === 'orchestrator' && (
        <MissionDirectoryField
          value={form.briefingsPath}
          onChange={val => update('briefingsPath', val)}
          repoDirs={repoDirs}
        />
      )}

      {agent.role === 'team' && (
        <div>
          <label style={labelStyle}>
            Team Default Prompt
            <span style={{ marginLeft: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-normal)' }}>
              — saved here propagates to every member that inherits.
            </span>
          </label>
          <textarea
            value={form.systemPromptTemplate}
            onChange={e => update('systemPromptTemplate', e.target.value)}
            style={{ ...inputStyle, minHeight: 160, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' }}
          />
        </div>
      )}

      {agent.role === 'bp-instance' && (
        <>
          <div>
            <div style={labelStyle}>Parent Orchestrator (read-only)</div>
            <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
              {agent.parentOrchestratorId || '—'}
            </div>
          </div>
          <div>
            <div style={labelStyle}>Mission ID (read-only)</div>
            <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
              {agent.bpId || '—'}
              {agent.bpSlug ? <span style={{ marginLeft: 8 }}>· slug: <code>{agent.bpSlug}</code></span> : null}
            </div>
          </div>
          {agent.briefingsPath && (
            <div>
              <div style={labelStyle}>Mission Directory (inherited, read-only)</div>
              <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
                {agent.briefingsPath}
              </div>
            </div>
          )}
        </>
      )}

      {agent.role === 'team-member' && (
        <>
          <div>
            <div style={labelStyle}>Parent Team (read-only)</div>
            <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
              {agent.parentTeamId || '—'}
            </div>
          </div>

          <InheritOrCustom
            label="System Prompt"
            inherit={form.inheritPrompt}
            onToggle={v => update('inheritPrompt', v)}
            inheritedPreview={parentTeamPrompt}
            inheritedLabel="Inherited from team"
            customValue={form.promptOverride}
            onCustomChange={v => update('promptOverride', v)}
            customMultiline
          />

          <InheritOrCustom
            label="Skills"
            inherit={form.inheritSkills}
            onToggle={v => update('inheritSkills', v)}
            inheritedPreview={
              parentTeam && parentTeam.environmentId
                ? `(team env: ${parentTeam.environmentId})`
                : ''
            }
            inheritedLabel="Inherited from team's environment"
            customValue={form.skillsOverrideText}
            onCustomChange={v => update('skillsOverrideText', v)}
            customPlaceholder="comma-separated skill names, e.g. cobol-analysis, jcl-converter"
          />

          <InheritOrCustom
            label="MCP Servers"
            inherit={form.inheritMcp}
            onToggle={v => update('inheritMcp', v)}
            inheritedPreview={
              parentTeam && parentTeam.environmentId
                ? `(team env: ${parentTeam.environmentId})`
                : ''
            }
            inheritedLabel="Inherited from team's environment"
            customValue={form.mcpOverrideText}
            onCustomChange={v => update('mcpOverrideText', v)}
            customPlaceholder={'one per line: serverId[:credentialId]\ne.g. wiki:wiki-team-a'}
            customMultiline
          />
        </>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave(buildSubmit())} saving={saving} disabled={!canSubmit}>
          {saving ? 'Saving…' : 'Save Changes'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

// Reusable inherit/override widget for team-member fields. Single source
// of truth for the toggle styling so the prompt and skills sections look
// identical.
function InheritOrCustom({
  label, inherit, onToggle,
  inheritedPreview, inheritedLabel,
  customValue, onCustomChange, customMultiline, customPlaceholder,
}) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{ display: 'flex', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-2)' }}>
        <label style={radioLabelStyle}>
          <input type="radio" checked={inherit} onChange={() => onToggle(true)} /> Inherit from team
        </label>
        <label style={radioLabelStyle}>
          <input type="radio" checked={!inherit} onChange={() => onToggle(false)} /> Custom
        </label>
      </div>
      {inherit ? (
        <div style={{
          ...inputStyle,
          background: 'var(--eb-bg-app)',
          color: 'var(--eb-text-muted)',
          fontFamily: 'var(--eb-font-mono)',
          fontSize: 'var(--eb-text-sm)',
          minHeight: customMultiline ? 100 : 'auto',
          whiteSpace: customMultiline ? 'pre-wrap' : 'normal',
        }}>
          {inheritedPreview ? inheritedPreview : <em>({inheritedLabel || 'inheriting'})</em>}
        </div>
      ) : customMultiline ? (
        <textarea
          value={customValue}
          onChange={e => onCustomChange(e.target.value)}
          placeholder={customPlaceholder || ''}
          style={{ ...inputStyle, minHeight: 140, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' }}
        />
      ) : (
        <input
          type="text"
          value={customValue}
          onChange={e => onCustomChange(e.target.value)}
          placeholder={customPlaceholder || ''}
          style={inputStyle}
        />
      )}
    </div>
  );
}

const radioLabelStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--eb-space-2)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
  cursor: 'pointer',
};

/* ── Agent Row ──────────────────────────────────────────────────────── */
function AgentRow({ agent, onActivate, onDeactivate, onToggleEnabled, onEdit, onDelete, onOpenBrief, onExport, navigate, tree, busy }) {
  const state = agentState(agent);
  const isStub = state === 'stub';
  const t = tree || {
    depth: 0, ancestorMore: [], isLast: true, hasChildren: false, isCollapsed: false,
  };
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        borderTop: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        opacity: isStub ? 0.85 : 1,
      }}
    >
      {t.depth > 0 && (
        <TreeConnector ancestorMore={t.ancestorMore} isLast={t.isLast} />
      )}
      {t.hasChildren ? (
        <button
          onClick={t.onToggleCollapse}
          aria-label={t.isCollapsed ? 'Expand subtree' : 'Collapse subtree'}
          title={t.isCollapsed ? 'Expand' : 'Collapse'}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--eb-text-secondary)', padding: 0,
            display: 'flex', alignItems: 'center', flexShrink: 0,
          }}
        >
          {t.isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : (
        t.depth > 0 && <span style={{ display: 'inline-block', width: 14, flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <span style={{ fontSize: 'var(--eb-text-sm)' }}>{agent.displayName}</span>
        <span style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}>
          {agent.id}
        </span>
        <StateBadge state={state} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        {isStub ? (
          <PrimaryBtn
            onClick={() => onActivate(agent)}
            saving={busy}
            style={{ padding: '4px 10px', fontSize: 'var(--eb-text-xs)' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Power size={13} /> Activate
            </span>
          </PrimaryBtn>
        ) : (
          <>
            <ToggleSwitch
              checked={state === 'active'}
              onChange={() => onToggleEnabled(agent)}
              label={state === 'active' ? 'Disable' : 'Enable'}
              disabled={busy}
            />
            <IconBtn
              icon={PowerOff}
              label="Deactivate"
              title="Deactivate — reset to stub state"
              onClick={() => onDeactivate(agent)}
              disabled={busy}
            />
          </>
        )}
        {onOpenBrief && (
          <IconBtn
            icon={FileText}
            label="View mission"
            title="View mission spec"
            onClick={() => onOpenBrief(agent)}
          />
        )}
        <IconBtn icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
        <IconBtn
          icon={MessageCircle}
          label="Open chat"
          title={isStub ? 'Stub — activate first' : 'Open chat'}
          onClick={() => !isStub && navigate(`/chats/${agent.id}`)}
          disabled={isStub}
        />
        {onExport && !isStub && (
          <IconBtn icon={Download} label="Export" title="Export agent as ZIP" onClick={() => onExport(agent.id)} />
        )}
        <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
      </div>
    </div>
  );
}

/* ── Orchestrator Card (with bp-instance children) ─────────────────── */
function OrchestratorCard({ agent, onEdit, onDelete, onSyncBps, onActivate, onDeactivate, onToggleEnabled, onEditChild, onDeleteChild, onExport, navigate, syncing, busyIds }) {
  const expandedKey = `aee_orc_expanded_${agent.id}`;
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(expandedKey) === 'true'; } catch { return false; }
  });
  const toggleExpanded = () => setExpanded(prev => {
    const next = !prev;
    try { localStorage.setItem(expandedKey, String(next)); } catch {}
    return next;
  });
  const [bps, setBps] = useState(null); // null = not yet loaded
  // Subtrees default to fully expanded — entries in this set are collapsed.
  const [collapsedNodes, setCollapsedNodes] = useState(() => new Set());
  const children = agent.children || [];
  const state = agentState(agent);
  const isStub = state === 'stub';

  // Lazy fetch BP metadata on first expansion. We re-fetch whenever the BP
  // count changes (sync added/removed stubs) so the order stays consistent
  // with what the user just clicked. Failures fall through to alphabetical.
  useEffect(() => {
    if (!expanded || isStub || !agent.briefingsPath) return;
    let cancelled = false;
    const rel = (agent.briefingsPath || '').replace(/^\/+|\/+$/g, '');
    const workspace = `/workspace/agents/${agent.id}${rel ? `/${rel}` : ''}`;
    fetch(`/api/bp-explorer/briefings?workspace=${encodeURIComponent(workspace)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (!cancelled) setBps(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setBps([]); });
    return () => { cancelled = true; };
  }, [expanded, isStub, agent.id, agent.briefingsPath, children.length]);

  const toggleCollapse = (id) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const treeRows = useMemo(
    () => buildAgentTree(children, bps, collapsedNodes),
    [children, bps, collapsedNodes],
  );

  // Resolve each bp-instance row to its brief.md path (relative to the
  // orchestrator's workspace). Empty when bps haven't loaded yet or a
  // particular row's BP is gone (orphan).
  const briefPathByAgentId = useMemo(() => {
    if (!Array.isArray(bps) || bps.length === 0) return {};
    const bpById = {};
    bps.forEach((bp) => { if (bp && bp.id) bpById[bp.id] = bp; });
    const briefingsBase = (agent.briefingsPath || '').replace(/^\/+|\/+$/g, '');
    const out = {};
    children.forEach((c) => {
      const bp = c.bpId ? bpById[c.bpId] : null;
      const rel = bp && bp._rel_path;
      if (!rel) return;
      out[c.id] = briefingsBase ? `${briefingsBase}/${rel}` : rel;
    });
    return out;
  }, [bps, children, agent.briefingsPath]);

  const [briefTarget, setBriefTarget] = useState(null);
  const handleOpenBrief = (childAgent) => {
    const relPath = briefPathByAgentId[childAgent.id];
    if (!relPath) return;
    setBriefTarget({ agent: childAgent, relPath });
  };

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)',
        borderBottom: expanded ? '1px solid var(--eb-border-default)' : 'none',
      }}>
        <button
          onClick={toggleExpanded}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-text-secondary)', padding: 0, display: 'flex' }}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <Layers size={18} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-md)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            {agent.displayName}
            <StateBadge state={state} />
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id} · orchestrator · env: {agent.environmentId}
            {agent.briefingsPath ? ` · path: ${agent.briefingsPath}` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <span style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
            background: 'var(--eb-bg-app)', padding: '2px 8px',
            borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)',
          }}>
            {children.length} mission{children.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => onSyncBps(agent)}
            disabled={syncing || isStub}
            title={isStub ? 'Activate the orchestrator first' : 'Re-scan the mission directory'}
            style={{
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', cursor: (syncing || isStub) ? 'not-allowed' : 'pointer',
              padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4, color: 'var(--eb-text-secondary)',
              opacity: (syncing || isStub) ? 0.5 : 1,
            }}
          >
            <RefreshCw size={13} /> {syncing ? 'Syncing…' : 'Sync'}
          </button>
          {isStub ? (
            <PrimaryBtn
              onClick={() => onActivate(agent)}
              saving={busyIds.has(agent.id)}
              style={{ padding: '4px 10px', fontSize: 'var(--eb-text-xs)' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Power size={13} /> Activate
              </span>
            </PrimaryBtn>
          ) : (
            <>
              <ToggleSwitch
                checked={state === 'active'}
                onChange={() => onToggleEnabled(agent)}
                label={state === 'active' ? 'Disable' : 'Enable'}
                disabled={busyIds.has(agent.id)}
              />
              <IconBtn
                icon={PowerOff}
                label="Deactivate"
                title="Deactivate — reset to stub state"
                onClick={() => onDeactivate(agent)}
                disabled={busyIds.has(agent.id)}
              />
            </>
          )}
          <IconBtn icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          <IconBtn icon={MessageCircle} label="Open chat" onClick={() => !isStub && navigate(`/chats/${agent.id}`)} disabled={isStub} />
          {onExport && !isStub && (
            <IconBtn icon={Download} label="Export" title="Export agent as ZIP" onClick={() => onExport(agent.id)} />
          )}
          <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
        </div>
      </div>

      {/* Children */}
      {expanded && (
        children.length === 0 ? (
          <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', textAlign: 'center', padding: 'var(--eb-space-4)' }}>
            {isStub
              ? 'Activate the orchestrator to load its missions.'
              : 'No missions found. Click Sync to re-scan the directory.'}
          </div>
        ) : (
          treeRows.map((row) => (
            <AgentRow
              key={row.agent.id}
              agent={row.agent}
              tree={{
                depth: row.depth,
                ancestorMore: row.ancestorMore,
                isLast: row.isLast,
                hasChildren: row.hasChildren,
                isCollapsed: row.isCollapsed,
                onToggleCollapse: () => toggleCollapse(row.agent.id),
              }}
              navigate={navigate}
              busy={busyIds.has(row.agent.id)}
              onActivate={onActivate}
              onDeactivate={onDeactivate}
              onToggleEnabled={onToggleEnabled}
              onEdit={onEditChild}
              onDelete={onDeleteChild}
              onOpenBrief={briefPathByAgentId[row.agent.id] ? handleOpenBrief : undefined}
            />
          ))
        )
      )}

      <SidePanel
        open={!!briefTarget}
        onClose={() => setBriefTarget(null)}
        title={briefTarget ? briefTarget.agent.displayName : ''}
        width="640px"
      >
        {briefTarget && (
          <BriefViewer orchestratorId={agent.id} relPath={briefTarget.relPath} />
        )}
      </SidePanel>
    </div>
  );
}

/* ── Team Card ──────────────────────────────────────────────────────── */
function TeamCard({ agent, onEdit, onDelete, onAddMember, onActivate, onDeactivate, onToggleEnabled, onEditChild, onDeleteChild, onExport, navigate, addingMember, busyIds }) {
  const expandedKey = `aee_team_expanded_${agent.id}`;
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(expandedKey) !== 'false'; } catch { return true; }
  });
  const toggleExpanded = () => setExpanded(prev => {
    const next = !prev;
    try { localStorage.setItem(expandedKey, String(next)); } catch {}
    return next;
  });

  const children = agent.children || [];

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)',
        borderBottom: expanded ? '1px solid var(--eb-border-default)' : 'none',
      }}>
        <button
          onClick={toggleExpanded}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-text-secondary)', padding: 0, display: 'flex' }}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <Layers size={18} style={{ color: 'var(--eb-accent-secondary, var(--eb-accent-primary))', flexShrink: 0 }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-md)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            {agent.displayName}
            <span style={{
              fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)',
              background: 'var(--eb-bg-app)', padding: '2px 8px',
              borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-accent-primary)',
            }}>Team</span>
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id} · env: {agent.environmentId}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <span style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
            background: 'var(--eb-bg-app)', padding: '2px 8px',
            borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)',
          }}>
            {children.length} member{children.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => navigate(`/team-setup?team=${encodeURIComponent(agent.id)}&mode=extend`)}
            style={{
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
              padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4, color: 'var(--eb-text-secondary)',
            }}
          >
            <GitMerge size={13} /> Extend team
          </button>
          <button
            onClick={() => onAddMember(agent)}
            disabled={addingMember}
            style={{
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', cursor: addingMember ? 'not-allowed' : 'pointer',
              padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4, color: 'var(--eb-text-secondary)',
              opacity: addingMember ? 0.5 : 1,
            }}
          >
            <Plus size={13} /> {addingMember ? 'Adding…' : 'Add Member'}
          </button>
          <IconBtn icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          {onExport && (
            <IconBtn icon={Download} label="Export" title="Export team as ZIP" onClick={() => onExport(agent.id)} />
          )}
          <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
        </div>
      </div>

      {/* Members */}
      {expanded && (
        children.length === 0 ? (
          <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', textAlign: 'center', padding: 'var(--eb-space-4)' }}>
            No members yet. Click <strong>Add Member</strong> to create one.
          </div>
        ) : (
          children.map((child, idx) => (
            <AgentRow
              key={child.id}
              agent={child}
              tree={{ depth: 1, ancestorMore: [], isLast: idx === children.length - 1, hasChildren: false, isCollapsed: false }}
              navigate={navigate}
              busy={busyIds.has(child.id)}
              onActivate={onActivate}
              onDeactivate={onDeactivate}
              onToggleEnabled={onToggleEnabled}
              onEdit={onEditChild}
              onDelete={onDeleteChild}
              onExport={onExport}
            />
          ))
        )
      )}
    </div>
  );
}

/* ── Leaf Agent Card ────────────────────────────────────────────────── */
function LeafAgentCard({ agent, onEdit, onDelete, onToggleEnabled, onDeactivate, onExport, navigate, busy }) {
  const state = agentState(agent);

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)',
      }}>
        <Layers size={18} style={{ color: 'var(--eb-text-secondary)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-md)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            {agent.displayName}
            <StateBadge state={state} />
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id} · {agent.role} · env: {agent.environmentId}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <ToggleSwitch
            checked={state === 'active'}
            onChange={() => onToggleEnabled(agent)}
            label={state === 'active' ? 'Disable' : 'Enable'}
            disabled={busy}
          />
          <IconBtn
            icon={PowerOff}
            label="Deactivate"
            title="Deactivate — reset to stub state"
            onClick={() => onDeactivate(agent)}
            disabled={busy}
          />
          <IconBtn icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          <IconBtn icon={MessageCircle} label="Open chat" onClick={() => navigate(`/chats/${agent.id}`)} />
          <IconBtn icon={Download} label="Export" title="Export agent as ZIP" onClick={() => onExport(agent.id)} />
          <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
        </div>
      </div>
    </div>
  );
}

function OrphanCard({ agent, onDelete }) {
  const reason =
    agent.role === 'team-member'
      ? `parent team "${agent.parentTeamId}" is gone`
      : agent.role === 'bp-instance'
      ? `parent orchestrator "${agent.parentOrchestratorId}" is gone`
      : 'parent agent is gone';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-status-warning)',
      borderRadius: 'var(--eb-radius-md)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'var(--eb-font-medium)', fontSize: 'var(--eb-text-sm)' }}>
          {agent.displayName ?? agent.id}
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.id} · {agent.role} · {reason}
        </div>
      </div>
      <IconBtn icon={Trash2} label="Delete orphan" danger onClick={() => onDelete(agent)} />
    </div>
  );
}

/* ── Main Component ─────────────────────────────────────────────────── */
export default function Agents() {
  const navigate = useNavigate();
  const { data: rawAgents, loading, error, refetch } = useApi('/api/agents');

  const [panelMode, setPanelMode] = useState(null); // null | 'create' | 'edit'
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivateWarning, setDeactivateWarning] = useState(null); // { agent, busy, activeTriggers }
  const [disableWarning, setDisableWarning] = useState(null); // { agent, busy, activeTriggers }
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [addingMemberId, setAddingMemberId] = useState(null);
  const [busyIds, setBusyIds] = useState(new Set());
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);
  const importFileRef = useRef(null);

  const agents = rawAgents || [];
  const byName = (a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id);
  const bpInstances = agents.filter(a => a.role === 'bp-instance');
  const teamMembers = agents.filter(a => a.role === 'team-member');
  const orchestratorIds = new Set(agents.filter(a => a.role === 'orchestrator').map(a => a.id));
  const teamIds = new Set(agents.filter(a => a.role === 'team').map(a => a.id));
  const orchestrators = agents
    .filter(a => a.role === 'orchestrator')
    .sort(byName)
    .map(o => ({ ...o, children: bpInstances.filter(c => c.parentOrchestratorId === o.id) }));
  const teams = agents
    .filter(a => a.role === 'team')
    .sort(byName)
    .map(t => ({ ...t, children: teamMembers.filter(m => m.parentTeamId === t.id).sort(byName) }));
  const leaves = agents
    .filter(a => !['orchestrator', 'bp-instance', 'team', 'team-member'].includes(a.role))
    .sort(byName);
  // Orphans: members/instances whose parent is gone. Must be rendered explicitly,
  // otherwise they vanish from the UI entirely (filtered out of leaves above and
  // not nested under any parent card) and the only way to delete them is via SSH.
  const orphans = [
    ...teamMembers.filter(m => !m.parentTeamId || !teamIds.has(m.parentTeamId)),
    ...bpInstances.filter(b => !b.parentOrchestratorId || !orchestratorIds.has(b.parentOrchestratorId)),
  ].sort(byName);

  function openPanel(mode, agent) {
    setSaveError(null);
    setSelectedAgent(agent);
    setPanelMode(mode);
  }
  function closePanel() {
    setPanelMode(null);
    setSelectedAgent(null);
    setSaveError(null);
  }

  function markBusy(id, busy) {
    setBusyIds(prev => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  }

  function handleExport(agentId) {
    window.open(`/api/agents/${encodeURIComponent(agentId)}/export`, '_blank');
  }

  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!importFileRef.current) return;
    importFileRef.current.value = '';
    if (!file) return;
    setImportError(null);
    setImportSuccess(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch('/api/agents/import', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setImportSuccess(`Agent '${data.agentId}' imported. Activate it from the card below.`);
      refetch();
    } catch (e) {
      setImportError(e.message);
    }
  }

  async function handleCreateAgent(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('POST', '/api/agents', form);
      closePanel();
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEditAgent(form) {
    setSaving(true);
    setSaveError(null);
    try {
      await apiCall('PUT', `/api/agents/${selectedAgent.id}`, form);
      closePanel();
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(agent) {
    markBusy(agent.id, true);
    try {
      await apiCall('PUT', `/api/agents/${agent.id}`, { enabled: true });
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  async function handleToggleEnabled(agent) {
    markBusy(agent.id, true);
    try {
      if (agent.enabled !== false) {
        // Disabling: probe without a mode first. The orchestrator returns 409
        // with a warning payload if the agent is running and has active
        // triggers or a busy session — show the drain-vs-abort dialog in that case.
        const res = await fetch(`/api/agents/${agent.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data.warning) {
          setDisableWarning({ agent, busy: data.busy, activeTriggers: data.activeTriggers || [] });
          return;
        }
        if (!res.ok) {
          setActionError(data.error || `HTTP ${res.status}`);
          return;
        }
      } else {
        await apiCall('PUT', `/api/agents/${agent.id}`, { enabled: true });
      }
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  async function handleDisableConfirmed(mode) {
    const { agent } = disableWarning;
    setDisableWarning(null);
    markBusy(agent.id, true);
    try {
      await apiCall('PUT', `/api/agents/${agent.id}`, { enabled: false, disableMode: mode });
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  async function handleSyncBps(agent) {
    setSyncingId(agent.id);
    try {
      await apiCall('POST', `/api/agents/${agent.id}/sync-bps`);
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setSyncingId(null);
    }
  }

  async function handleAddMember(team) {
    setAddingMemberId(team.id);
    try {
      await apiCall('POST', `/api/agents/${team.id}/members`);
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setAddingMemberId(null);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/agents/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    }
  }

  async function handleDeactivateConfirmed() {
    const target = deactivateTarget;
    setDeactivateTarget(null);
    if (!target) return;
    markBusy(target.id, true);
    try {
      const res = await fetch(`/api/agents/${target.id}/deactivate`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.warning) {
        setDeactivateWarning({ agent: target, busy: data.busy, activeTriggers: data.activeTriggers || [] });
        return;
      }
      if (!res.ok) {
        setActionError(data.error || `HTTP ${res.status}`);
        return;
      }
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(target.id, false);
    }
  }

  async function handleDeactivateMode(mode) {
    const { agent } = deactivateWarning;
    setDeactivateWarning(null);
    markBusy(agent.id, true);
    try {
      await apiCall('POST', `/api/agents/${agent.id}/deactivate`, { mode });
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(agent.id, false);
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {[1, 2].map(i => (
          <div key={i} style={{ height: 72, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-lg)', color: 'var(--eb-status-error)' }}>
        Failed to load agents: {error}
      </div>
    );
  }

  // Count agent types (teams/orchestrators/leaves), not individual members/stubs,
  // consistent with how bp-instances under orchestrators are also not counted separately.
  // Orphans count too — otherwise the page shows the empty state while orphans still need cleanup.
  const totalCount = orchestrators.length + teams.length + leaves.length + orphans.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>Agents</h1>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <input
            ref={importFileRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={handleImport}
          />
          <button
            onClick={() => importFileRef.current?.click()}
            style={{
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
              padding: '6px 12px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 6, color: 'var(--eb-text-secondary)',
            }}
          >
            <Upload size={14} /> Import Agent
          </button>
          <PrimaryBtn onClick={() => openPanel('create', null)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Plus size={15} /> New Agent</span>
          </PrimaryBtn>
        </div>
      </div>
      {importSuccess && (
        <div role="status" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-success-bg, #e6f9f0)', border: '1px solid var(--eb-status-success, #22c55e)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {importSuccess}
          <button onClick={() => setImportSuccess(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>✕</button>
        </div>
      )}
      {importError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {importError}
          <button onClick={() => setImportError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>✕</button>
        </div>
      )}

      <div style={{
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
        lineHeight: 1.55,
      }}>
        <p style={{ margin: 0, fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
          What is an agent?
        </p>
        <p style={{ margin: 0 }}>
          An <strong>Agent</strong> is a long-running Claude Code instance with its own workspace and session history.
          Once created, you talk to it in the <strong>Agent Chat</strong>. This page is for advanced and custom
          configurations — for most use cases, the guided paths below are faster:
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--eb-text-xs)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--eb-border-default)', color: 'var(--eb-text-primary)' }}>Role</th>
              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--eb-border-default)', color: 'var(--eb-text-primary)' }}>Plain-language description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: '4px 8px', verticalAlign: 'top', whiteSpace: 'nowrap' }}><strong>Agent</strong></td>
              <td style={{ padding: '4px 8px' }}>A standalone chat assistant. Use <Link to="/quickstart" style={{ color: 'var(--eb-accent-primary)' }}>Single Agent</Link> for the fastest setup.</td>
            </tr>
            <tr>
              <td style={{ padding: '4px 8px', verticalAlign: 'top', whiteSpace: 'nowrap' }}><strong>Team / Team-member</strong></td>
              <td style={{ padding: '4px 8px' }}>Part of a coordinated group. Use the <Link to="/team-setup" style={{ color: 'var(--eb-accent-primary)' }}>Team Wizard</Link> — don&apos;t create these manually unless you know what you&apos;re doing.</td>
            </tr>
            <tr>
              <td style={{ padding: '4px 8px', verticalAlign: 'top', whiteSpace: 'nowrap' }}><strong>Orchestrator</strong></td>
              <td style={{ padding: '4px 8px' }}>Manages a folder of BriefingPacks (ACE workflow tasks). Only needed for ACE-based workflows.</td>
            </tr>
          </tbody>
        </table>
        <p style={{ margin: 0 }}>
          After creation the agent appears below as a card. <em>Active</em> agents are running and ready to chat;
          <em> paused</em> agents keep their workspace but the process is stopped; <em>not initialised</em> stubs (e.g. orchestrator children) need
          one click on <strong>Activate</strong> to come to life. You can edit, deactivate or delete each agent from its card.
        </p>
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)' }}>Dismiss</button>
        </div>
      )}

      {totalCount === 0 ? (
        <div style={{
          padding: 'var(--eb-space-8)', textAlign: 'center',
          background: 'var(--eb-bg-surface)', border: '1px dashed var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
        }}>
          No agents yet. Click <strong>+ New Agent</strong> to create the first one.
        </div>
      ) : (
        <>
          {orchestrators.map(o => (
            <OrchestratorCard
              key={o.id}
              agent={o}
              navigate={navigate}
              syncing={syncingId === o.id}
              busyIds={busyIds}
              onEdit={a => openPanel('edit', a)}
              onDelete={a => setDeleteTarget(a)}
              onSyncBps={handleSyncBps}
              onActivate={handleActivate}
              onDeactivate={a => setDeactivateTarget(a)}
              onToggleEnabled={handleToggleEnabled}
              onEditChild={a => openPanel('edit', a)}
              onDeleteChild={a => setDeleteTarget(a)}
              onExport={handleExport}
            />
          ))}
          {teams.map(t => (
            <TeamCard
              key={t.id}
              agent={t}
              navigate={navigate}
              addingMember={addingMemberId === t.id}
              busyIds={busyIds}
              onEdit={a => openPanel('edit', a)}
              onDelete={a => setDeleteTarget(a)}
              onAddMember={handleAddMember}
              onActivate={handleActivate}
              onDeactivate={a => setDeactivateTarget(a)}
              onToggleEnabled={handleToggleEnabled}
              onEditChild={a => openPanel('edit', a)}
              onDeleteChild={a => setDeleteTarget(a)}
              onExport={handleExport}
            />
          ))}
          {leaves.map(a => (
            <LeafAgentCard
              key={a.id}
              agent={a}
              navigate={navigate}
              busy={busyIds.has(a.id)}
              onEdit={ag => openPanel('edit', ag)}
              onDelete={ag => setDeleteTarget(ag)}
              onDeactivate={ag => setDeactivateTarget(ag)}
              onToggleEnabled={handleToggleEnabled}
              onExport={handleExport}
            />
          ))}
          {orphans.length > 0 && (
            <div style={{
              padding: 'var(--eb-space-4)',
              background: 'var(--eb-bg-surface)',
              border: '1px solid var(--eb-status-warning)',
              borderRadius: 'var(--eb-radius-lg)',
              display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
            }}>
              <div>
                <div style={{ fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-status-warning)', fontSize: 'var(--eb-text-md)' }}>
                  Orphaned agents ({orphans.length})
                </div>
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 2 }}>
                  These agents reference a parent that no longer exists. Delete each one to remove its workspace and Matrix user.
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
                {orphans.map(o => (
                  <OrphanCard key={o.id} agent={o} onDelete={ag => setDeleteTarget(ag)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <SidePanel open={panelMode === 'create'} onClose={closePanel} title="New Agent" width="600px" loading={saving}>
        <AgentCreateForm onSave={handleCreateAgent} onCancel={closePanel} saving={saving} error={saveError} />
      </SidePanel>

      <SidePanel
        open={panelMode === 'edit' && !!selectedAgent}
        onClose={closePanel}
        title={`Edit Agent — ${selectedAgent?.displayName ?? ''}`}
        width="480px"
        loading={saving}
      >
        {selectedAgent && panelMode === 'edit' && (
          <AgentEditForm agent={selectedAgent} onSave={handleEditAgent} onCancel={closePanel} saving={saving} error={saveError} />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title={
          deleteTarget?.role === 'team'
            ? `Delete team "${deleteTarget.displayName}"?`
            : deleteTarget?.role === 'orchestrator'
            ? `Delete orchestrator "${deleteTarget.displayName}"?`
            : 'Delete agent?'
        }
        message={renderDeleteMessage(deleteTarget)}
        variant="danger"
        confirmLabel={
          (deleteTarget?.role === 'team' || deleteTarget?.role === 'orchestrator') &&
          (deleteTarget?.children?.length ?? 0) > 0
            ? `Delete ${deleteTarget.role === 'team' ? 'team' : 'orchestrator'} and ${deleteTarget.children.length} ${deleteTarget.role === 'team' ? 'member' : 'mission'}${deleteTarget.children.length !== 1 ? 's' : ''}`
            : 'Delete'
        }
        maxWidth={
          (deleteTarget?.role === 'team' || deleteTarget?.role === 'orchestrator') &&
          (deleteTarget?.children?.length ?? 0) > 0
            ? 560
            : 440
        }
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!deactivateTarget}
        title="Deactivate Agent"
        message={
          `Reset "${deactivateTarget?.displayName ?? deactivateTarget?.id}" to its stub state? ` +
          `This stops the agent process and wipes the workspace. ` +
          `The stub config is kept so the agent can be reactivated later — but session history, ` +
          `cloned repositories, and any in-workspace state will be lost.`
        }
        variant="danger"
        confirmLabel="Deactivate"
        onConfirm={handleDeactivateConfirmed}
        onCancel={() => setDeactivateTarget(null)}
      />

      <DisableWarningDialog
        open={!!disableWarning}
        agent={disableWarning?.agent}
        busy={disableWarning?.busy}
        activeTriggers={disableWarning?.activeTriggers}
        onDrain={() => handleDisableConfirmed('drain')}
        onAbort={() => handleDisableConfirmed('abort')}
        onCancel={() => setDisableWarning(null)}
      />

      <DeactivateWarningDialog
        open={!!deactivateWarning}
        agent={deactivateWarning?.agent}
        busy={deactivateWarning?.busy}
        activeTriggers={deactivateWarning?.activeTriggers}
        onDrain={() => handleDeactivateMode('drain')}
        onHardStop={() => handleDeactivateMode('hard-stop')}
        onCancel={() => setDeactivateWarning(null)}
      />
    </div>
  );
}

function DisableWarningDialog({ open, agent, busy, activeTriggers, onDrain, onAbort, onCancel }) {
  if (!open) return null;
  const name = agent?.displayName ?? agent?.id ?? 'this agent';
  const triggerCount = Array.isArray(activeTriggers) ? activeTriggers.length : 0;

  const parts = [];
  if (busy) parts.push('a session is currently running');
  if (triggerCount > 0) parts.push(`${triggerCount} active trigger${triggerCount !== 1 ? 's' : ''}`);

  return (
    <div role="dialog" aria-modal="true" aria-label="Disable agent" style={{
      position: 'fixed', inset: 0, background: 'oklch(0 0 0 / 0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-5)', maxWidth: 480,
        width: '90%', boxShadow: 'var(--eb-shadow-xl)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)' }}>
          <span style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2, fontSize: 20 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              Disable "{name}"
            </h3>
            <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
              {parts.length > 0
                ? `This agent has ${parts.join(' and ')}. Choose how to proceed:`
                : 'This agent has active state. Choose how to proceed:'}
            </p>
            <ul style={{ margin: 'var(--eb-space-2) 0 0', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
              <li><strong>Let run</strong> — disable immediately; the current execution finishes naturally. No new triggers will start.</li>
              <li><strong>Hard stop</strong> — kill the process now. Any in-progress work is aborted.</li>
            </ul>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-4)' }}>
          <button onClick={onCancel} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)',
            color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Cancel</button>
          <button onClick={onDrain} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Let run</button>
          <button onClick={onAbort} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-status-error)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Hard stop</button>
        </div>
      </div>
    </div>
  );
}

function DeactivateWarningDialog({ open, agent, busy, activeTriggers, onDrain, onHardStop, onCancel }) {
  if (!open) return null;
  const name = agent?.displayName ?? agent?.id ?? 'this agent';
  const triggerCount = Array.isArray(activeTriggers) ? activeTriggers.length : 0;

  const parts = [];
  if (busy) parts.push('a session is currently running');
  if (triggerCount > 0) parts.push(`${triggerCount} active trigger${triggerCount !== 1 ? 's' : ''}`);

  return (
    <div role="dialog" aria-modal="true" aria-label="Deactivate agent" style={{
      position: 'fixed', inset: 0, background: 'oklch(0 0 0 / 0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-5)', maxWidth: 500,
        width: '90%', boxShadow: 'var(--eb-shadow-xl)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)' }}>
          <span style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2, fontSize: 20 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              Deactivate "{name}"
            </h3>
            <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
              {parts.length > 0
                ? `This agent has ${parts.join(' and ')}. Choose how to proceed:`
                : 'This agent has active state. Choose how to proceed:'}
            </p>
            <ul style={{ margin: 'var(--eb-space-2) 0 0', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
              <li><strong>Let run</strong> — disable triggers now so no new executions start; the current execution finishes naturally. Come back to deactivate fully once the agent is idle.</li>
              <li><strong>Hard stop</strong> — kill the process immediately, then wipe the workspace.</li>
            </ul>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-4)' }}>
          <button onClick={onCancel} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)',
            color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Cancel</button>
          <button onClick={onDrain} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Let run</button>
          <button onClick={onHardStop} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-status-error)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Hard stop + Deactivate</button>
        </div>
      </div>
    </div>
  );
}

function renderDeleteMessage(target) {
  if (!target) return '';

  if (target.role === 'team' || target.role === 'orchestrator') {
    const children = Array.isArray(target.children) ? target.children : [];
    const childNoun = target.role === 'team' ? 'member' : 'mission';
    const childNounPlural = target.role === 'team' ? 'members' : 'missions';
    const parentNoun = target.role === 'team' ? 'team' : 'orchestrator';

    if (children.length === 0) {
      return (
        <>
          <p style={{ margin: 0 }}>
            Delete this {parentNoun}? It currently has no {childNounPlural} attached.
            The workspace, configuration and Matrix user will be removed permanently.
          </p>
        </>
      );
    }

    return (
      <>
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)',
          border: '1px solid var(--eb-status-error)',
          borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-text-primary)',
          fontWeight: 'var(--eb-font-semibold)',
          fontSize: 'var(--eb-text-sm)',
        }}>
          ⚠ This will permanently delete the {parentNoun} <strong>and all {children.length} {children.length === 1 ? childNoun : childNounPlural}</strong> below.
          Workspaces, session histories and Matrix users for every listed agent will be removed. This cannot be undone.
        </div>
        <p style={{ margin: 'var(--eb-space-3) 0 var(--eb-space-1)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
          {childNounPlural[0].toUpperCase() + childNounPlural.slice(1)} that will be deleted:
        </p>
        <ul style={{
          margin: 0,
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          maxHeight: 220,
          overflowY: 'auto',
          background: 'var(--eb-bg-app)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          listStyle: 'none',
          fontFamily: 'var(--eb-font-mono)',
          fontSize: 'var(--eb-text-xs)',
        }}>
          {children.map((c) => (
            // Stacked layout: id on top, displayName underneath. Side-by-side
            // didn't survive long ids + long titles — the row blew the dialog
            // open even with min-width:0 on the parent because both spans
            // wanted full width. Stacking is robust regardless of length and
            // keeps the visual hierarchy (mono id, muted title).
            <li key={c.id} style={{
              padding: '4px 0',
              display: 'flex', flexDirection: 'column', gap: 1,
              borderBottom: '1px solid var(--eb-border-subtle, transparent)',
            }}>
              <span style={{ color: 'var(--eb-text-primary)', wordBreak: 'break-all' }}>
                {c.id}
              </span>
              {c.displayName && c.displayName !== c.id && (
                <span style={{
                  color: 'var(--eb-text-muted)',
                  fontFamily: 'var(--eb-font-sans, inherit)',
                  fontSize: '11px',
                  wordBreak: 'break-word',
                }}>
                  {c.displayName}
                </span>
              )}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return `Delete agent "${target.displayName ?? target.id}"? This removes the workspace and all associated data.`;
}
