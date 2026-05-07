import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Plus, Trash2, Layers, ChevronDown, ChevronRight,
  Edit, MessageCircle, RefreshCw, Power, PowerOff, FileText,
  User, Users, Workflow, Info,
} from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

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
  'expert': {
    icon: User,
    title: 'Expert (standalone)',
    short: 'A single chat agent with its own system prompt.',
    body: (
      <>
        Creates one Matrix user (<code>@id:local</code>) you can talk to in a 1:1 chat.
        The system prompt you write below shapes its persona — for example a COBOL specialist,
        a code-review buddy, or a release manager. Add cron / GitHub triggers later to make
        it run autonomously in addition to responding to messages.
      </>
    ),
    when: 'Use this for one-of-a-kind agents — every expert is unique.',
  },
  'expert-group': {
    icon: Users,
    title: 'Expert Group',
    short: 'A reusable template — spawn multiple identical instances on demand.',
    body: (
      <>
        Stores a system-prompt template without creating a Matrix user itself. Instead you click
        <strong> Add Instance</strong> on the group card to spawn one or more agents that all
        share the same prompt and Working Environment, but each gets its own Matrix user,
        workspace and chat.
      </>
    ),
    when: 'Use when you need several copies of the same kind of expert — e.g. a pool of three reviewer agents working in parallel.',
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
    id: '', displayName: '', role: 'expert', environmentId: '', systemPrompt: '',
    briefingsPath: '',
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
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
        <div style={labelStyle}>ID <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <input
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }}
          value={form.id}
          onChange={e => update('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          placeholder="e.g. cobol-expert"
        />
        <div style={helpTextStyle}>
          Lowercase letters, digits and hyphens only. Becomes the Matrix user
          (<code>@{form.id || 'id'}:local</code>) and the workspace folder name.
          <strong> Cannot be changed after creation.</strong>
        </div>
      </div>

      <div>
        <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} placeholder="COBOL Expert" />
        <div style={helpTextStyle}>
          A short, human-readable label shown in the agents list and chat header — e.g. <em>COBOL Expert</em>.
        </div>
      </div>

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
          Defines the skills, repositories, GitHub token and LLM endpoint the agent receives at creation time.
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
          <RoleCard value="expert"        current={form.role} onSelect={v => update('role', v)} />
          <RoleCard value="expert-group"  current={form.role} onSelect={v => update('role', v)} />
          <RoleCard value="orchestrator"  current={form.role} onSelect={v => update('role', v)} />
        </div>
        <RoleDetailBanner role={form.role} />
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
          {form.role === 'expert-group' ? 'System Prompt Template' : 'System Prompt'}
          {' '}<span style={{ color: 'var(--eb-status-error)' }}>*</span>
        </div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-1)' }}>
          {form.role === 'expert-group'
            ? <>Stored once and reused for every instance you spawn from this group. Define the persona, expertise, and tone — each instance gets its own workspace but the same instructions.</>
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
  const [form, setForm] = useState({
    displayName: agent.displayName || '',
    briefingsPath: agent.briefingsPath || '',
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

      {agent.role === 'expert-instance' && (
        <div>
          <div style={labelStyle}>Parent Group (read-only)</div>
          <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.parentGroupId || '—'}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit}>
          {saving ? 'Saving…' : 'Save Changes'}
        </PrimaryBtn>
        <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
      </div>
    </div>
  );
}

/* ── Agent Row ──────────────────────────────────────────────────────── */
function AgentRow({ agent, onActivate, onDeactivate, onToggleEnabled, onEdit, onDelete, onOpenBrief, navigate, tree, busy }) {
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
          @{agent.id}:local
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
        <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
      </div>
    </div>
  );
}

/* ── Orchestrator Card (with bp-instance children) ─────────────────── */
function OrchestratorCard({ agent, onEdit, onDelete, onSyncBps, onActivate, onDeactivate, onToggleEnabled, onEditChild, onDeleteChild, navigate, syncing, busyIds }) {
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
    fetch(`/api/agents/${agent.id}/briefings`)
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

/* ── Expert Group Card ──────────────────────────────────────────────── */
function ExpertGroupCard({ agent, onEdit, onDelete, onAddInstance, onActivate, onDeactivate, onToggleEnabled, onEditChild, onDeleteChild, navigate, addingInstance, busyIds }) {
  const expandedKey = `aee_eg_expanded_${agent.id}`;
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
            }}>Expert Group</span>
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
            {children.length} instance{children.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => onAddInstance(agent)}
            disabled={addingInstance}
            style={{
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', cursor: addingInstance ? 'not-allowed' : 'pointer',
              padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4, color: 'var(--eb-text-secondary)',
              opacity: addingInstance ? 0.5 : 1,
            }}
          >
            <Plus size={13} /> {addingInstance ? 'Adding…' : 'Add Instance'}
          </button>
          <IconBtn icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
        </div>
      </div>

      {/* Instances */}
      {expanded && (
        children.length === 0 ? (
          <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', textAlign: 'center', padding: 'var(--eb-space-4)' }}>
            No instances yet. Click <strong>Add Instance</strong> to create one.
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
            />
          ))
        )
      )}
    </div>
  );
}

/* ── Leaf Agent Card ────────────────────────────────────────────────── */
function LeafAgentCard({ agent, onEdit, onDelete, onToggleEnabled, onDeactivate, navigate, busy }) {
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
          <IconBtn icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
        </div>
      </div>
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [addingInstanceId, setAddingInstanceId] = useState(null);
  const [busyIds, setBusyIds] = useState(new Set());

  const agents = rawAgents || [];
  const byName = (a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id);
  const bpInstances = agents.filter(a => a.role === 'bp-instance');
  const expertInstances = agents.filter(a => a.role === 'expert-instance');
  const orchestrators = agents
    .filter(a => a.role === 'orchestrator')
    .sort(byName)
    .map(o => ({ ...o, children: bpInstances.filter(c => c.parentOrchestratorId === o.id) }));
  const expertGroups = agents
    .filter(a => a.role === 'expert-group')
    .sort(byName)
    .map(g => ({ ...g, children: expertInstances.filter(i => i.parentGroupId === g.id).sort(byName) }));
  const leaves = agents
    .filter(a => !['orchestrator', 'bp-instance', 'expert-group', 'expert-instance'].includes(a.role))
    .sort(byName);

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
      await apiCall('PUT', `/api/agents/${agent.id}`, { enabled: agent.enabled === false });
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

  async function handleAddInstance(group) {
    setAddingInstanceId(group.id);
    try {
      await apiCall('POST', `/api/agents/${group.id}/instances`);
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setAddingInstanceId(null);
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
      await apiCall('POST', `/api/agents/${target.id}/deactivate`);
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      markBusy(target.id, false);
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

  // Count agent types (groups/orchestrators/leaves), not individual instances/stubs,
  // consistent with how bp-instances under orchestrators are also not counted separately.
  const totalCount = orchestrators.length + expertGroups.length + leaves.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>Agents</h1>
        <PrimaryBtn onClick={() => openPanel('create', null)}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Plus size={15} /> New Agent</span>
        </PrimaryBtn>
      </div>

      <div style={{
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        lineHeight: 1.55,
      }}>
        <p style={{ margin: 0, fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
          What is an agent?
        </p>
        <p style={{ margin: 0 }}>
          An <strong>Agent</strong> is a long-running Claude Code instance with its own Matrix user, workspace and session history.
          You chat with it in a 1:1 room (no shared multi-agent room exists). When you create an agent you choose:
        </p>
        <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
          <li><strong>A Working Environment</strong> — supplies skills, repositories, GitHub token and the LLM endpoint.</li>
          <li><strong>A role</strong> — Expert (one chat agent), Expert Group (a template for many identical instances), or Orchestrator (drives a folder of ACE BriefingPacks).</li>
          <li><strong>A system prompt</strong> — the persona / instructions Claude reads at startup. Orchestrators don't need one; their behaviour is fixed.</li>
        </ul>
        <p style={{ margin: 0 }}>
          After creation the agent appears below as a card. <em>Active</em> agents have a Matrix user and can be chatted with;
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
            />
          ))}
          {expertGroups.map(g => (
            <ExpertGroupCard
              key={g.id}
              agent={g}
              navigate={navigate}
              addingInstance={addingInstanceId === g.id}
              busyIds={busyIds}
              onEdit={a => openPanel('edit', a)}
              onDelete={a => setDeleteTarget(a)}
              onAddInstance={handleAddInstance}
              onActivate={handleActivate}
              onDeactivate={a => setDeactivateTarget(a)}
              onToggleEnabled={handleToggleEnabled}
              onEditChild={a => openPanel('edit', a)}
              onDeleteChild={a => setDeleteTarget(a)}
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
            />
          ))}
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
        title="Delete Agent"
        message={
          deleteTarget?.role === 'orchestrator'
            ? `Delete orchestrator "${deleteTarget.displayName}"? Its BP-instance children must be deleted separately.`
            : deleteTarget?.role === 'expert-group'
            ? `Delete expert group "${deleteTarget.displayName}"? Its instances must be deleted separately.`
            : `Delete agent "${deleteTarget?.displayName ?? deleteTarget?.id}"? This removes the workspace and all associated data.`
        }
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!deactivateTarget}
        title="Deactivate Agent"
        message={
          `Reset "${deactivateTarget?.displayName ?? deactivateTarget?.id}" to its stub state? ` +
          `This stops the agent process, deactivates its Matrix user, and wipes the workspace. ` +
          `The stub config is kept so the agent can be reactivated later — but session history, ` +
          `cloned repositories, and any in-workspace state will be lost.`
        }
        variant="danger"
        confirmLabel="Deactivate"
        onConfirm={handleDeactivateConfirmed}
        onCancel={() => setDeactivateTarget(null)}
      />
    </div>
  );
}
