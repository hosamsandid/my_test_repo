import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Plus, Trash2, Layers, ChevronDown, ChevronRight,
  Edit, MessageCircle, RefreshCw, Power, PowerOff, FileText,
  User, Users, Workflow, Info, Download, Upload, Copy, UserPlus, BookmarkPlus,
} from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { inferMissingRoles } from './missing-roles-view.js';
import {
  PROMPT_MODES,
  PROMPT_MODE_LABELS,
  resolvePromptMode,
  composeMemberPrompt,
} from './prompt-mode-view.js';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import { notifyPluginsChanged } from '../components/plugin-nav';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
import SkillPicker from '../components/SkillPicker';
import PluginGrantPicker from '../components/PluginGrantPicker';
import { effectiveGrantFor } from './plugin-grant-view.js';
import {
  AGENTS_PAGE_COPY,
  EMPTY_STATE_PRIMARY_CTA,
} from './agents-view.js';
import SyncReposPanel from '../components/SyncReposPanel';
import useAutoDerivedId, { sanitizeId } from '../hooks/useAutoDerivedId';
import { summarizeTeamAction } from './team-action-summary.js';
import { describeAgentSubmitState } from './agent-create-submit-state.js';
import { usePageActions } from '../context/PageActionsContext';
// Lifecycle presentation shared with Agent Chat's left rail (#1928). These
// styles, dialog bodies and forms used to be defined here; they moved into
// `agent-lifecycle/` unchanged so the chat renders the *same* components rather
// than a second copy that could drift. Only the definitions moved — every call
// site below is untouched.
import {
  labelStyle, inputStyle, helpTextStyle, PrimaryBtn, SecondaryBtn,
} from './agent-lifecycle/form-kit.jsx';
import {
  ImportAgentForm, CloneAgentForm, ExtractTemplateForm,
} from './agent-lifecycle/AgentLifecycleForms.jsx';
import {
  DisableWarningDialog, TeamDisableDialog, DeactivateWarningDialog, renderDeleteMessage,
} from './agent-lifecycle/AgentLifecycleDialogs.jsx';
import { agentState } from './agent-lifecycle/agent-lifecycle-menu.js';

const hasRepos = (env) =>
  (Array.isArray(env?.repositories) && env.repositories.length > 0) ||
  !!env?.repository?.url;

function repoDirName(url) {
  if (!url) return '';
  return url.replace(/\.git$/, '').split(/[/:]/g).filter(Boolean).pop() || '';
}

/* ── BP-dependency hierarchy helpers ────────────────────────────────────
   Topo-sorts the bp-instance children of an orchestrator so they are listed
   in dependency order, matching how the unified Flows viewer lays them out. */

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
    // Team members carry a `parentMemberId` (imported BP hierarchy, #377). When
    // any member declares one, render the parent-child tree like the
    // orchestrator does for bp-instances; otherwise fall back to a flat list.
    const hasHierarchy = list.some(
      (a) => a.parentMemberId && list.some((x) => x.id === a.parentMemberId),
    );
    if (hasHierarchy) return buildParentTree(list, collapsed);

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

// Parent-child tree from team members' `parentMemberId` pointers (imported BP
// hierarchy, #377). Produces the same row shape as buildAgentTree so the tree
// connectors render identically to the orchestrator's bp-instance view.
// Siblings are sorted alphabetically; cycles / dangling parents degrade to
// roots. Children of a collapsed node are omitted.
function buildParentTree(list, collapsed) {
  const byId = {};
  list.forEach((a) => { byId[a.id] = a; });
  const nameOf = (id) => (byId[id]?.displayName || id);
  const byName = (x, y) => nameOf(x).localeCompare(nameOf(y));

  const childrenOf = {};
  const roots = [];
  list.forEach((a) => {
    const p = a.parentMemberId && byId[a.parentMemberId] && a.parentMemberId !== a.id
      ? a.parentMemberId : null;
    if (p) (childrenOf[p] = childrenOf[p] || []).push(a.id);
    else roots.push(a.id);
  });
  roots.sort(byName);
  Object.values(childrenOf).forEach((arr) => arr.sort(byName));

  const rows = [];
  const emitted = new Set();
  function walk(ids, depth, ancestorTrail) {
    ids.forEach((id, idx) => {
      const agent = byId[id];
      if (!agent || emitted.has(id)) return;
      const isLast = idx === ids.length - 1;
      const kids = (childrenOf[id] || []).filter((c) => !emitted.has(c));
      const hasChildren = kids.length > 0;
      const isCollapsed = hasChildren && collapsed.has(id);
      rows.push({ agent, depth, ancestorMore: ancestorTrail.slice(), isLast, hasChildren, isCollapsed });
      emitted.add(id);
      if (hasChildren && !isCollapsed) walk(kids, depth + 1, [...ancestorTrail, !isLast]);
    });
  }
  walk(roots, 1, []);

  // Safety net: any member not emitted (e.g. a parent cycle) is appended flat.
  const leftovers = list.filter((a) => !emitted.has(a.id)).sort((a, b) => byName(a.id, b.id));
  leftovers.forEach((a, i) => {
    rows.push({ agent: a, depth: 1, ancestorMore: [], isLast: i === leftovers.length - 1, hasChildren: false, isCollapsed: false });
  });
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

// Compact typography for the brief.md body. Without these the browser's
// default heading sizes look oversized inside a 640px side panel.
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

/* ── Role catalogue (single source of truth for labels + descriptions) ─
   The long per-role explanation lives in the page's help topic
   (api/helper-chat/help-topics/agents.md, #1875) — here we keep only the
   one-line card label and the one-line "when to use", so the form stays lean
   and the concept text has a single home the "?" affordance opens. */
const ROLE_INFO = {
  'agent': {
    icon: User,
    title: 'Agent (standalone)',
    short: 'A single chat agent with its own system prompt.',
    when: 'Use this for one-of-a-kind agents that act on their own.',
  },
  'team': {
    icon: Users,
    title: 'Agent Team',
    short: 'A reusable template — spawn multiple team members from one prompt.',
    when: 'Use when you need several copies of the same kind of agent — e.g. a pool of three reviewer agents working in parallel.',
  },
  'orchestrator': {
    icon: Workflow,
    title: 'Orchestrator',
    short: 'Watches a folder of mission files and runs one agent per mission.',
    when: 'Use when you have an ACE briefings repository whose missions you want to drive end-to-end through this console.',
  },
  'team-member': {
    icon: User,
    title: 'Team Member',
    short: 'One agent spawned from an Agent Team — most fields inherit from the team.',
    when: 'You do not pick this role yourself — it is assigned when you add a member to a team.',
  },
  'bp-instance': {
    icon: FileText,
    title: 'Mission Agent (bp-instance)',
    short: 'One agent per mission, managed by an Orchestrator from a BriefingPack.',
    when: 'You do not pick this role yourself — the orchestrator assigns it per mission.',
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
      <div style={{ flex: '1 1 auto', minWidth: 0, color: 'var(--eb-text-muted)' }}>
        <strong style={{ color: 'var(--eb-text-secondary)' }}>When to use:</strong> {info.when}
      </div>
      {/* The full role catalogue moved into the page help topic (#1875) — the
          "?" is how you reach it from inside the form. */}
      <PageHelpButton label="What the roles mean" size={14} style={{ padding: 0, flexShrink: 0 }} />
    </div>
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
      Path inside the agent's workspace where the mission files live — usually a cloned ACE briefings repository.
      The <code>artifacts/briefings/</code> subdirectory is appended automatically.
      On creation, the orchestrator scans this path and registers one stub agent per mission it finds.
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
    briefingsPath: '', skills: [],
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName: v => update('displayName', v),
    setId:   v => update('id', v),
    getName: () => form.displayName,
  });
  const { data: environments } = useApi('/api/environments');
  const envs = environments || [];
  // Create form has no team context yet, so only the global pool is offered
  // (grant-aware picker, #633 — team skills appear once the agent belongs to a
  // team and is edited).
  const { data: skillsData } = useApi('/api/skills');
  const poolSkills = (skillsData || []).filter(s => s.source === 'pool');

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

  // System prompt is optional for teams and orchestrators: members can be given
  // their own per-role prompts later, so a team can be created without a
  // default. The pure helper derives the gate AND the ordered list of unmet
  // requirements from one place, so the disabled button and the "why" hint
  // below can never disagree.
  const { canSubmit, reasons: submitBlockers } = describeAgentSubmitState(form);

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
            {' '}{ID_FORMAT_HINT} Used as the agent's URL
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
            </option>
          ))}
        </select>
        <div style={helpTextStyle}>
          Defines the repositories, GitHub token and model provider the agent receives at creation time.
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
                Agent Team Wizard
              </Link>{' '}
              instead — it sets up the full team structure automatically.
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

      <div>
        <div style={labelStyle}>Skills</div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
          {form.role === 'team'
            ? "The whole team's skill set, copied into every member's workspace at seed time — members inherit it unless they set their own override."
            : "Skills copied into this agent's workspace at seed time. Only global-pool skills are offered here; team-tier skills become available once the agent belongs to a team and you edit it there."}
        </div>
        <SkillPicker
          skills={poolSkills}
          selected={form.skills}
          onChange={v => update('skills', v)}
        />
      </div>

      {form.role !== 'orchestrator' && (
      <div>
        <div style={labelStyle}>
          {form.role === 'team' ? 'System Prompt Template' : 'System Prompt'}
          {form.role === 'team'
            ? <span style={{ marginLeft: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-normal)' }}>(optional)</span>
            : <>{' '}<span style={{ color: 'var(--eb-status-error)' }}>*</span></>}
        </div>
        <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-1)' }}>
          {form.role === 'team'
            ? <>Stored once and reused for every member that inherits it. Define the persona, expertise, and tone — each member gets its own workspace but the same instructions. Leave blank to give members an empty default; you can then set a custom prompt per member.</>
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        {/* When the button is disabled (and not merely saving), spell out
            exactly which required field is still empty so a user new to the
            console isn't left guessing why the form looks broken. */}
        {!saving && submitBlockers.length > 0 && (
          <div style={{
            display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
          }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
            <span>
              Create Agent is disabled until you:
              <ul style={{ margin: 'var(--eb-space-1) 0 0', paddingLeft: 'var(--eb-space-4)' }}>
                {submitBlockers.map(r => (
                  <li key={r.field}>{r.message}</li>
                ))}
              </ul>
            </span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <PrimaryBtn onClick={() => onSave(form)} saving={saving} disabled={!canSubmit}>
            {saving ? 'Creating…' : 'Create Agent'}
          </PrimaryBtn>
          <SecondaryBtn onClick={onCancel}>Cancel</SecondaryBtn>
        </div>
      </div>
    </div>
  );
}

/* ── Agent Edit Form ────────────────────────────────────────────────── */
// Host-folder context mount(s) (#1283, multiple folders #1290). A self-contained
// Plugin grant (#1547). Like ContextMountControl below — and unlike the rest of
// the edit form, which batches into one PUT on Save — this saves IMMEDIATELY
// through its own endpoint. A plugin grant is not just a config field: it seeds
// the CLI + a scope token into the live workspace and reconnects the broker's
// network, all without a respawn. Batching it into the form's PUT would make
// "Save" mean two very different things.
function PluginGrantSection({ agent, parentTeam }) {
  const { data, refetch } = useApi('/api/plugins');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [notice, setNotice] = React.useState('');

  // Optimistic local grant so the row reflects the click before the refetch;
  // reset from props whenever the server view changes.
  const serverGrant = React.useMemo(
    () => effectiveGrantFor(agent, parentTeam),
    [agent, parentTeam],
  );
  const [grant, setGrant] = React.useState(serverGrant);
  React.useEffect(() => { setGrant(serverGrant); }, [serverGrant]);

  const installed = (data && data.installed) || [];

  // The quota ceiling for "per agent" granularity is only honest if it counts
  // the members that would actually carry the grant, so a team's members are
  // counted for real rather than assumed to be one.
  const { data: allAgents } = useApi(agent.role === 'team' ? '/api/agents' : null);
  const memberCount = React.useMemo(() => {
    if (agent.role !== 'team') return 1;
    const list = Array.isArray(allAgents) ? allAgents : (allAgents && allAgents.agents) || [];
    const n = list.filter(a => a && a.parentTeamId === agent.id).length;
    return n > 0 ? n : 1;
  }, [agent.role, agent.id, allAgents]);

  async function apply(pluginId, active, scopeGranularity) {
    setBusy(true); setErr(''); setNotice('');
    const verb = active ? 'activate' : 'deactivate';
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(agent.id)}/plugins/${verb}`, {
        pluginId, scopeGranularity,
      });
      setNotice(active
        ? `${pluginId} activated — its CLI is available to the agent now, no restart needed.`
        : `${pluginId} deactivated.`);
      await refetch();
      // A grant change can add/remove a scope the caller can see — refresh the
      // sidebar's plugin nav, which no longer refetches on navigation (#1679).
      notifyPluginsChanged();
    } catch (e) {
      setErr(e.message || `Could not ${verb} ${pluginId}`);
      setGrant(serverGrant); // roll the optimistic toggle back
    } finally { setBusy(false); }
  }

  function onToggle(pluginId, active, granularity) {
    setGrant(active
      ? [...grant.filter(g => g.id !== pluginId), { id: pluginId, scopeGranularity: granularity }]
      : grant.filter(g => g.id !== pluginId));
    apply(pluginId, active, granularity);
  }

  function onGranularity(pluginId, granularity) {
    setGrant(grant.map(g => (g.id === pluginId ? { ...g, scopeGranularity: granularity } : g)));
    // A granularity flip is re-activation at the new scope: the server re-mints
    // the token and rewrites the config, additively.
    apply(pluginId, true, granularity);
  }

  if (installed.length === 0) return null;

  return (
    <div>
      <div style={labelStyle}>Plugins</div>
      <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
        Governed capabilities beyond the container, reached through a broker that holds the
        privilege so the agent never does. Changes apply immediately — no save, no restart.
        {agent.role === 'team' && ' For a team agent this is the whole squad\'s grant; members inherit it.'}
        {agent.role === 'team-member' && ' Changing this here creates a per-member override that replaces the team\'s set.'}
      </div>
      {err && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-xs)', marginBottom: 'var(--eb-space-2)' }}>{err}</div>
      )}
      {notice && !err && (
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)', marginBottom: 'var(--eb-space-2)' }}>{notice}</div>
      )}
      <PluginGrantPicker
        plugins={installed}
        grants={grant}
        onToggle={onToggle}
        onGranularity={onGranularity}
        memberCount={memberCount}
        disabled={busy}
      />
    </div>
  );
}

// control: unlike the rest of the edit form (one PUT on Save), a mount change is
// baked at container spawn time and re-provisions the agent, so it saves
// immediately via its own PATCH endpoint and reports the respawn outcome. Each
// folder gets a distinct, stable in-container path — a single legacy folder at
// the bare `/context`, additional folders at `/context/<slug>` (the slug is
// derived from the folder's basename server-side and de-duplicated). Availability
// is local/self-hosted only — the capability probe disables the control (with an
// explanation) on the hosted stack (AC8).
function ContextMountControl({ agent }) {
  const { data: capability } = useApi('/api/context-mount/capability');
  const supported = capability ? !!capability.supported : null; // null = still loading
  const mountPath = (capability && capability.mountPath) || '/context';

  // Initial rows: the multi-folder field when present, else the legacy single
  // folder, else empty. `slug`/`name` are carried (hidden) so a re-save keeps a
  // folder's in-container path stable even if the host path is repointed.
  const initialRows = () => {
    if (Array.isArray(agent.contextMounts) && agent.contextMounts.length) {
      return agent.contextMounts.map(m => ({
        path: m.path || '',
        name: m.name || '',
        slug: m.slug || null,
        readWrite: m.readWrite === true,
        target: m.slug ? `${mountPath}/${m.slug}` : null,
      }));
    }
    if (agent.contextMount) {
      return [{ path: agent.contextMount, name: '', slug: null, readWrite: agent.contextMountRw === true, target: mountPath }];
    }
    return [];
  };
  const snapshot = (rs) => JSON.stringify(rs.map(r => ({ path: (r.path || '').trim(), readWrite: !!r.readWrite })));

  const [rows, setRows] = useState(initialRows);
  const [saved, setSaved] = useState(() => snapshot(initialRows()));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const dirty = snapshot(rows) !== saved;
  const disabled = busy || supported === null;

  const updateRow = (i, patch) => setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows(rs => [...rs, { path: '', name: '', slug: null, readWrite: false, target: null }]);
  const removeRow = (i) => setRows(rs => rs.filter((_, idx) => idx !== i));

  async function persist(nextRows) {
    setBusy(true); setMsg(''); setErr('');
    try {
      const mounts = nextRows
        .map(r => ({
          path: (r.path || '').trim(),
          readWrite: !!r.readWrite,
          ...(r.name ? { name: r.name } : {}),
          ...(r.slug ? { slug: r.slug } : {}),
        }))
        .filter(m => m.path);
      const res = await apiCall('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/context-mount`, { mounts });
      const applied = Array.isArray(res && res.mounts) ? res.mounts : [];
      const appliedRows = applied.map(m => ({
        path: m.hostPath || '',
        name: m.name || '',
        slug: m.slug || null,
        readWrite: m.readWrite === true,
        target: m.target || null,
      }));
      setRows(appliedRows);
      setSaved(snapshot(appliedRows));
      const n = appliedRows.length;
      if (!n) {
        setMsg('Context folders cleared. ' + (res && res.respawned ? 'Agent re-provisioned.' : 'Takes effect on the next start.'));
      } else {
        const suffix = n === 1 ? 'folder' : 'folders';
        setMsg(res && res.respawned
          ? `${n} ${suffix} mounted under ${mountPath}. Agent re-provisioned.`
          : `Saved ${n} ${suffix}. Takes effect the next time the agent starts.`);
      }
    } catch (e) {
      setErr((e && e.message) || 'Could not update the context folders');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={labelStyle}>Host context folders</div>
      <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
        Expose one or more folders from the host machine to this agent as live context.
        Each folder's current contents appear inside the agent under <code>{mountPath}</code>
        {' '}at its own path; changes the host makes are reflected on the agent's next access.
        By default each folder is <strong>read-only</strong>; tick read-write to let the agent
        create, modify and delete files in it — those changes land on the host. Saving
        re-provisions the agent's container.
      </div>
      {supported === false ? (
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)' }}>
          Not available in this environment — host-folder mounts are offered only on the
          local / self-hosted stack.
        </div>
      ) : (
        <>
          {rows.length === 0 && (
            <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)', fontStyle: 'italic' }}>
              No folders attached. Add one below.
            </div>
          )}
          {rows.map((row, i) => (
            <div key={i} style={{ marginBottom: 'var(--eb-space-3)', paddingBottom: 'var(--eb-space-2)', borderBottom: '1px solid var(--eb-border-default)' }}>
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                <input
                  type="text"
                  value={row.path}
                  onChange={e => updateRow(i, { path: e.target.value })}
                  placeholder="/absolute/path/on/the/host"
                  disabled={disabled}
                  style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)', flex: '1 1 auto', minWidth: 0 }}
                />
                <SecondaryBtn
                  onClick={() => removeRow(i)}
                  title="Remove this folder"
                  style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto', flex: '0 0 auto' }}
                >
                  Remove
                </SecondaryBtn>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-1)', cursor: disabled ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={row.readWrite}
                  onChange={e => updateRow(i, { readWrite: e.target.checked })}
                  disabled={disabled}
                />
                <span style={helpTextStyle}>Mount read-write — let the agent write back to this folder (off by default).</span>
              </label>
              {row.target && (
                <div style={{ ...helpTextStyle, marginTop: 'var(--eb-space-1)' }}>
                  Mounts at <code>{row.target}</code>
                </div>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            <SecondaryBtn onClick={addRow} style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
              + Add folder
            </SecondaryBtn>
            <SecondaryBtn onClick={() => persist(rows)} style={{ opacity: (disabled || !dirty) ? 0.6 : 1, pointerEvents: (disabled || !dirty) ? 'none' : 'auto' }}>
              {busy ? 'Saving…' : 'Save & re-provision'}
            </SecondaryBtn>
            {rows.length > 0 && (
              <SecondaryBtn onClick={() => { setRows([]); persist([]); }} style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
                Clear all
              </SecondaryBtn>
            )}
          </div>
          {msg && <div style={{ ...helpTextStyle, color: 'var(--eb-status-success)' }}>{msg}</div>}
          {err && <div role="alert" style={{ ...helpTextStyle, color: 'var(--eb-status-error)' }}>{err}</div>}
        </>
      )}
    </div>
  );
}

function AgentEditForm({ agent, onSave, onCancel, saving, error }) {
  // Initial values for the inheritance toggles. `agent.systemPrompt` /
  // `agent.skillsOverride` absent === inheriting from the parent team.
  // System-prompt mode (#1511): resolve the three-way mode from the config
  // (explicit `promptMode`, else legacy systemPrompt-presence inference — AC7).
  const initialPromptMode = agent.role === 'team-member'
    ? resolvePromptMode(agent)
    : PROMPT_MODES.INHERIT;
  const initialInheritSkills = agent.role === 'team-member'
    && !Array.isArray(agent.skillsOverride);
  const initialInheritMcp = agent.role === 'team-member'
    && !Array.isArray(agent.mcpServersOverride);

  // MCP overrides are stored as [{serverId, credentialId|null}, ...]. We
  // serialize them for editing as one entry per line — `serverId:credentialId`,
  // or just `serverId` when no credential is bound; trades polish for less form
  // scaffolding.
  const initialMcpText = Array.isArray(agent.mcpServersOverride)
    ? agent.mcpServersOverride.map(m => m.credentialId ? `${m.serverId}:${m.credentialId}` : m.serverId).join('\n')
    : '';

  const [form, setForm] = useState({
    displayName: agent.displayName || '',
    briefingsPath: agent.briefingsPath || '',
    // non-member roles: the agent's own skill grant
    skills: Array.isArray(agent.skills) ? agent.skills : [],
    // team-only field
    systemPromptTemplate: agent.systemPromptTemplate || '',
    // team-member override fields. `promptMode` is one of inherit/additional/
    // exclusive (#1511); `promptOverride` holds the agent-specific text — the
    // addition (additional mode) or the full override (exclusive). One shared
    // text field so switching between additional/exclusive keeps typed text.
    promptMode: initialPromptMode,
    promptOverride: agent.systemPrompt || '',
    inheritSkills: initialInheritSkills,
    skillsOverride: Array.isArray(agent.skillsOverride)
      ? agent.skillsOverride
      : [],
    inheritMcp: initialInheritMcp,
    mcpOverrideText: initialMcpText,
  });
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const canSubmit = !!form.displayName;

  // Skills live on the agent construct itself for non-member roles.
  const hasOwnSkills = agent.role === 'team' || agent.role === 'agent' || agent.role === 'orchestrator';
  // Grant-aware picker (#633): scope the pool to the agent's own team so its
  // team-tier skills are grantable, not just the global pool. Team-first
  // resolution and shadowing markers are rendered by the picker.
  const skillsUrl = agent.teamId
    ? `/api/skills?teamId=${encodeURIComponent(agent.teamId)}`
    : '/api/skills';
  const { data: skillsData } = useApi(skillsUrl);
  const grantSkills = (skillsData || []).filter(s => s.source === 'pool' || s.source === 'team');

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
    if (hasOwnSkills) {
      submit.skills = form.skills;
    }
    if (agent.role === 'team') {
      submit.systemPromptTemplate = form.systemPromptTemplate;
    }
    if (agent.role === 'team-member') {
      // System-prompt mode (#1511). `promptMode` selects one of the three modes;
      // `systemPrompt` carries the agent-specific text (null = inherit → clear
      // the override). The API composes the effective prompt from the two.
      submit.promptMode = form.promptMode;
      submit.systemPrompt = form.promptMode === PROMPT_MODES.INHERIT
        ? null
        : form.promptOverride;
      submit.skillsOverride = form.inheritSkills
        ? null
        : form.skillsOverride;
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

      <RoleDetailBanner role={agent.role} />

      <div>
        <div style={labelStyle}>Working Environment (read-only)</div>
        <div style={{ ...inputStyle, color: 'var(--eb-text-muted)', background: 'var(--eb-bg-app)', fontFamily: 'var(--eb-font-mono)' }}>
          {agent.environmentId}
        </div>
      </div>

      <FormInput label="Display Name *" value={form.displayName} onChange={v => update('displayName', v)} />

      {hasOwnSkills && (
        <div>
          <div style={labelStyle}>Skills</div>
          <div style={{ ...helpTextStyle, marginTop: 0, marginBottom: 'var(--eb-space-2)' }}>
            The agent's active skills, copied into its workspace at (re)seed time. For team agents this is the whole team's set — members inherit it unless they override.
          </div>
          <SkillPicker
            skills={grantSkills}
            selected={form.skills}
            onChange={v => update('skills', v)}
          />
        </div>
      )}

      <PluginGrantSection agent={agent} parentTeam={parentTeam} />

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
          <div style={{ marginTop: 'var(--eb-space-1)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Prompt changes take effect from each member's next session.
          </div>
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

          <PromptModeControl
            mode={form.promptMode}
            onModeChange={v => update('promptMode', v)}
            teamPrompt={parentTeamPrompt}
            text={form.promptOverride}
            onTextChange={v => update('promptOverride', v)}
          />
          <div style={{ marginTop: 'calc(-1 * var(--eb-space-2))', marginBottom: 'var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Prompt changes take effect from this agent's next session.
          </div>

          <InheritOrCustom
            label="Skills"
            inherit={form.inheritSkills}
            onToggle={v => update('inheritSkills', v)}
            inheritedPreview={
              parentTeam && Array.isArray(parentTeam.skills) && parentTeam.skills.length
                ? `(team skills: ${parentTeam.skills.join(', ')})`
                : '(team has no skills yet)'
            }
            inheritedLabel="Inherited from the team"
            renderCustom={() => (
              <SkillPicker
                skills={grantSkills}
                selected={form.skillsOverride}
                onChange={v => update('skillsOverride', v)}
              />
            )}
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

      {agent.role !== 'team' && (
        <div style={{ paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
          <ContextMountControl agent={agent} />
        </div>
      )}

      {agent.role !== 'team' && agent.environmentId && (
        <div style={{ paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
          <div style={labelStyle}>Repositories</div>
          <SyncReposPanel
            endpoint={`/api/agents/${encodeURIComponent(agent.id)}/sync-repositories`}
            actionLabel="Sync repositories"
            description={"Clone any repositories added to this agent's Working Environment that are missing from its workspace. Already-cloned repositories are left untouched."}
          />
        </div>
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
// Three-mode system-prompt selector for team-members (#1511): Inherit from team
// / Additional input / Exclusive overriding input. Skills and MCP keep the
// two-way InheritOrCustom widget below (unchanged, AC10).
//
//   - inherit    → the team prompt only; shown read-only (AC2).
//   - additional → an agent-specific addition appended AFTER the team prompt in a
//                  clearly delimited section; the box previews the COMBINED
//                  effective prompt (team + addition), not the addition alone
//                  (AC9).
//   - exclusive  → the agent-specific text fully replaces the team prompt (AC6).
//
// One shared text field backs both additional and exclusive, so switching
// between them keeps whatever the user typed (edge case: no silent text loss).
const readonlyPromptBoxStyle = {
  ...inputStyle,
  background: 'var(--eb-bg-app)',
  color: 'var(--eb-text-muted)',
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-sm)',
  minHeight: 100,
  whiteSpace: 'pre-wrap',
  maxHeight: 260,
  overflow: 'auto',
};

function PromptModeControl({ mode, onModeChange, teamPrompt, text, onTextChange }) {
  const modes = [PROMPT_MODES.INHERIT, PROMPT_MODES.ADDITIONAL, PROMPT_MODES.EXCLUSIVE];
  return (
    <div>
      <div style={labelStyle}>System Prompt</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-2)' }}>
        {modes.map(m => (
          <label key={m} style={radioLabelStyle}>
            <input type="radio" checked={mode === m} onChange={() => onModeChange(m)} />
            {' '}{PROMPT_MODE_LABELS[m]}
          </label>
        ))}
      </div>

      {mode === PROMPT_MODES.INHERIT && (
        <div style={readonlyPromptBoxStyle}>
          {teamPrompt ? teamPrompt : <em>(inheriting the team prompt)</em>}
        </div>
      )}

      {mode === PROMPT_MODES.ADDITIONAL && (
        <>
          <textarea
            value={text}
            onChange={e => onTextChange(e.target.value)}
            placeholder="Agent-specific instructions to append after the team prompt…"
            style={{ ...inputStyle, minHeight: 120, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' }}
          />
          <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Effective prompt preview (team prompt + your addition):
          </div>
          <div style={readonlyPromptBoxStyle}>
            {composeMemberPrompt(PROMPT_MODES.ADDITIONAL, teamPrompt, text) || <em>(the team prompt is empty)</em>}
          </div>
        </>
      )}

      {mode === PROMPT_MODES.EXCLUSIVE && (
        <textarea
          value={text}
          onChange={e => onTextChange(e.target.value)}
          placeholder="Full system prompt that replaces the team prompt…"
          style={{ ...inputStyle, minHeight: 140, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' }}
        />
      )}
    </div>
  );
}

function InheritOrCustom({
  label, inherit, onToggle,
  inheritedPreview, inheritedLabel,
  customValue, onCustomChange, customMultiline, customPlaceholder,
  renderCustom,
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
      ) : renderCustom ? (
        renderCustom()
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
function AgentRow({ agent, onActivate, onDeactivate, onToggleEnabled, onEdit, onDelete, onOpenBrief, onExport, onClone, onExtractTemplate, navigate, tree, busy, locked = false }) {
  const state = agentState(agent);
  const isStub = state === 'stub';
  const t = tree || {
    depth: 0, ancestorMore: [], isLast: true, hasChildren: false, isCollapsed: false,
  };
  return (
    <div
      className="eb-wrap-md"
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
      <div className="eb-wrap-md" style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
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
              label={locked ? 'Team is disabled — enable the team first' : (state === 'active' ? 'Disable' : 'Enable')}
              disabled={busy || locked}
            />
            <IconButton
              icon={PowerOff}
              label="Reset to stub"
              title="Reset to stub — wipes the workspace (session history, cloned repos, in-workspace state). Not a pause; use the Disable toggle to pause."
              danger
              onClick={() => onDeactivate(agent)}
              disabled={busy}
            />
          </>
        )}
        {onOpenBrief && (
          <IconButton
            icon={FileText}
            label="View mission"
            title="View mission spec"
            onClick={() => onOpenBrief(agent)}
          />
        )}
        <IconButton icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
        <IconButton
          icon={MessageCircle}
          label="Open chat"
          title={isStub ? 'Stub — activate first' : 'Open chat'}
          onClick={() => !isStub && navigate(`/chats/${agent.id}`)}
          disabled={isStub}
        />
        {onExport && !isStub && (
          <IconButton icon={Download} label="Export" title="Export agent as ZIP" onClick={() => onExport(agent.id)} />
        )}
        {onClone && (
          <IconButton icon={Copy} label="Clone" title="Clone this agent" onClick={() => onClone(agent)} />
        )}
        {onExtractTemplate && !isStub && (
          <IconButton icon={BookmarkPlus} label="Save as template" title="Save this agent's prompt, skills and config as a reusable Agent Template" onClick={() => onExtractTemplate(agent)} />
        )}
        <IconButton icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
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
      <div className="eb-wrap-md" style={{
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

        <div className="eb-wrap-md" style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
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
              <IconButton
                icon={PowerOff}
                label="Reset to stub"
                title="Reset to stub — wipes the workspace (session history, cloned repos, in-workspace state). Not a pause; use the Disable toggle to pause."
                danger
                onClick={() => onDeactivate(agent)}
                disabled={busyIds.has(agent.id)}
              />
            </>
          )}
          <IconButton icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          <IconButton icon={MessageCircle} label="Open chat" onClick={() => !isStub && navigate(`/chats/${agent.id}`)} disabled={isStub} />
          {onExport && !isStub && (
            <IconButton icon={Download} label="Export" title="Export agent as ZIP" onClick={() => onExport(agent.id)} />
          )}
          <IconButton icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
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
function TeamCard({ agent, onEdit, onDelete, onAddMember, onAddRole, onActivate, onDeactivate, onToggleEnabled, onToggleTeam, onEditChild, onDeleteChild, onExport, onCloneChild, onExtractTemplateChild, navigate, addingMember, busyIds, processTemplates, addingRoleKey }) {
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

  // Loop-closing roles this team is missing relative to its inferred source
  // process template (#1375). Null unless a template clearly matches — so
  // unrelated / fully-covered teams show nothing.
  const missingRoles = useMemo(
    () => inferMissingRoles(agent, children, processTemplates),
    [agent, children, processTemplates],
  );

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div className="eb-wrap-md" style={{
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
            }} title="A squad of agents working a repo — not the same as a Team on the Teams page">Agent Team</span>
            <ToggleSwitch
              checked={agent.enabled !== false}
              onChange={() => onToggleTeam(agent)}
              label={agent.enabled !== false ? 'Disable team' : 'Enable team'}
            />
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id} · env: {agent.environmentId}
          </div>
        </div>

        <div className="eb-wrap-md" style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <span style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
            background: 'var(--eb-bg-app)', padding: '2px 8px',
            borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)',
          }}>
            {children.length} member{children.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => navigate(`/flows?proc=${encodeURIComponent(agent.id)}`)}
            title="Grow this team by adding agents in the Flow Editor"
            style={{
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
              padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4, color: 'var(--eb-text-secondary)',
            }}
          >
            <Workflow size={13} /> Open in Flow Editor
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
          <IconButton icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          {onExport && (
            <IconButton icon={Download} label="Export" title="Export team as ZIP" onClick={() => onExport(agent.id)} />
          )}
          <IconButton icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
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
              locked={agent.enabled === false}
              onActivate={onActivate}
              onDeactivate={onDeactivate}
              onToggleEnabled={onToggleEnabled}
              onEdit={onEditChild}
              onDelete={onDeleteChild}
              onExport={onExport}
              onClone={onCloneChild}
              onExtractTemplate={onExtractTemplateChild}
            />
          ))
        )
      )}

      {/* Missing loop-closing roles (#1375). Additive hint: only shown when the
          team clearly matches a reference template and is missing roles from it.
          Adding a role reuses the members endpoint and starts it disabled. */}
      {expanded && missingRoles && missingRoles.missing.length > 0 && (
        <div style={{
          padding: 'var(--eb-space-4)',
          borderTop: '1px solid var(--eb-border-default)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Info size={13} style={{ flexShrink: 0 }} />
            Missing roles from the <strong style={{ color: 'var(--eb-text-secondary)' }}>{missingRoles.templateName}</strong> loop.
            Add one to close a gap (e.g. no <code>merger</code> ⇒ merges stay manual). New roles start disabled.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)' }}>
            {missingRoles.missing.map(role => {
              const busy = addingRoleKey === `${agent.id}:${role.id}`;
              return (
                <button
                  key={role.id}
                  onClick={() => onAddRole(agent, missingRoles.templateId, role)}
                  disabled={!!addingRoleKey}
                  title={`Add the ${role.displayName} role from the ${missingRoles.templateName} template (starts disabled)`}
                  style={{
                    background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
                    borderRadius: 'var(--eb-radius-md)', cursor: addingRoleKey ? 'not-allowed' : 'pointer',
                    padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: 4, color: 'var(--eb-text-secondary)',
                    opacity: addingRoleKey && !busy ? 0.5 : 1,
                  }}
                >
                  <UserPlus size={13} /> {busy ? 'Adding…' : `Add ${role.displayName} role`}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Leaf Agent Card ────────────────────────────────────────────────── */
function LeafAgentCard({ agent, onEdit, onDelete, onToggleEnabled, onDeactivate, onExport, onClone, onExtractTemplate, navigate, busy }) {
  const state = agentState(agent);

  return (
    <div style={{
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      overflow: 'hidden',
    }}>
      <div className="eb-wrap-md" style={{
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
        <div className="eb-wrap-md" style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <ToggleSwitch
            checked={state === 'active'}
            onChange={() => onToggleEnabled(agent)}
            label={state === 'active' ? 'Disable' : 'Enable'}
            disabled={busy}
          />
          <IconButton
            icon={PowerOff}
            label="Reset to stub"
            title="Reset to stub — wipes the workspace (session history, cloned repos, in-workspace state). Not a pause; use the Disable toggle to pause."
            danger
            onClick={() => onDeactivate(agent)}
            disabled={busy}
          />
          <IconButton icon={Edit} label="Edit" onClick={() => onEdit(agent)} />
          <IconButton icon={MessageCircle} label="Open chat" onClick={() => navigate(`/chats/${agent.id}`)} />
          <IconButton icon={Download} label="Export" title="Export agent as ZIP" onClick={() => onExport(agent.id)} />
          {onClone && (
            <IconButton icon={Copy} label="Clone" title="Clone this agent" onClick={() => onClone(agent)} />
          )}
          {onExtractTemplate && (
            <IconButton icon={BookmarkPlus} label="Save as template" title="Save this agent's prompt, skills and config as a reusable Agent Template" onClick={() => onExtractTemplate(agent)} />
          )}
          <IconButton icon={Trash2} label="Delete" danger onClick={() => onDelete(agent)} />
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
    <div className="eb-wrap-md" style={{
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
      <IconButton icon={Trash2} label="Delete orphan" danger onClick={() => onDelete(agent)} />
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
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivateWarning, setDeactivateWarning] = useState(null); // { agent, busy, activeTriggers }
  const [disableWarning, setDisableWarning] = useState(null); // { agent, busy, activeTriggers }
  // Team-wide disable/enable: preview + confirm + result, mirroring the
  // per-agent disableWarning flow but operating on every member at once.
  const [teamActionPrompt, setTeamActionPrompt] = useState(null); // { team, action: 'disable'|'enable', members }
  const [teamActionBusy, setTeamActionBusy] = useState(false);
  const [teamActionError, setTeamActionError] = useState(null);
  const [teamActionResult, setTeamActionResult] = useState(null); // { action, successIds, failedMembers }
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [addingMemberId, setAddingMemberId] = useState(null);
  // Missing-blueprint-role detection (#1375): the full reference process-template
  // bundles (roles + label registry), fetched once and handed to each TeamCard so
  // it can infer which loop-closing roles the team is missing. The `/api/process-templates`
  // list is slim (no roles/labels), so each bundle is fetched by id.
  const [processTemplates, setProcessTemplates] = useState([]);
  const [addingRoleKey, setAddingRoleKey] = useState(null); // `${teamId}:${roleId}` while adding
  const [addRoleNotice, setAddRoleNotice] = useState(null); // { text } success toast
  const [busyIds, setBusyIds] = useState(new Set());
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const importFileRef = useRef(null);
  // Existing template ids (both tiers) for the "Save as template" unique-id
  // suggestion (#1509), fetched lazily when the dialog opens.
  const [extractTemplateIds, setExtractTemplateIds] = useState(() => new Set());

  const agents = rawAgents || [];
  const existingAgentIds = useMemo(() => new Set(agents.map(a => a.id)), [agents]);
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

  // Load the full reference process-template bundles once (#1375). Best-effort:
  // if the pool isn't seeded or the fetch fails, the missing-role hints simply
  // don't appear — the rest of the page is unaffected. Only runs when at least
  // one Agent Team exists to compare against.
  useEffect(() => {
    if (teams.length === 0) return;
    if (processTemplates.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { templates } = await apiCall('GET', '/api/process-templates');
        const list = Array.isArray(templates) ? templates : [];
        const bundles = await Promise.all(list.map(t =>
          apiCall('GET', `/api/process-templates/${encodeURIComponent(t.id)}`).catch(() => null)));
        if (!cancelled) setProcessTemplates(bundles.filter(Boolean));
      } catch { /* pool not seeded / unreachable — no hints, no error */ }
    })();
    return () => { cancelled = true; };
  }, [teams.length, processTemplates.length]);

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

  // Step 1: a file was picked — open the import dialog (id / team options)
  // instead of submitting immediately, so the operator can re-id the agent
  // or assign it to a team before it lands.
  function handleImportFileSelected(e) {
    const file = e.target.files?.[0];
    if (importFileRef.current) importFileRef.current.value = '';
    if (!file) return;
    setImportError(null);
    setImportSuccess(null);
    setImportFile(file);
    setSelectedAgent(null);
    setSaveError(null);
    setPanelMode('import');
  }

  // Step 2: dialog submitted. Returns the parsed response so the form can
  // react to a 409 id-conflict (reveal/seed the new-id field).
  async function handleImportSubmit({ newId, parentTeamId }) {
    const formData = new FormData();
    formData.append('file', importFile);
    if (newId) formData.append('newId', newId);
    if (parentTeamId) formData.append('parentTeamId', parentTeamId);
    const resp = await fetch('/api/agents/import', { method: 'POST', body: formData });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      setImportSuccess(
        `Agent '${data.agentId}' imported${data.parentTeamId ? ` into team '${data.parentTeamId}'` : ''} ` +
        `and started — open it in Agent Chat.`,
      );
      setImportFile(null);
      closePanel();
      refetch();
    }
    return { ok: resp.ok, status: resp.status, data };
  }

  // Clone dialog submitted. Returns the parsed response so the form can react
  // to a 409 id-conflict (re-suggest an id) without closing.
  async function handleCloneSubmit({ newId, newDisplayName, parentTeamId }) {
    const resp = await fetch(`/api/agents/${encodeURIComponent(selectedAgent.id)}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newId, newDisplayName, parentTeamId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      closePanel();
      refetch();
    }
    return { ok: resp.ok, status: resp.status, data };
  }

  // "Save as template" (#1509). Fetch the existing template ids first (both
  // tiers) so the dialog can seed a unique id suggestion, then open the panel.
  // Best-effort: an unreachable list just yields an empty set (server still
  // enforces uniqueness with a 409).
  async function openExtractPanel(agent) {
    let ids = new Set();
    try {
      const { templates } = await apiCall('GET', '/api/agent-templates');
      ids = new Set((Array.isArray(templates) ? templates : []).map(t => t.id));
    } catch { /* list unreachable — empty set, server still guards uniqueness */ }
    setExtractTemplateIds(ids);
    openPanel('extract', agent);
  }

  // Extract dialog submitted. Returns the parsed response so the form can react
  // to a 409 id-conflict (re-suggest an id) without closing.
  async function handleExtractSubmit(form) {
    const resp = await fetch(`/api/agents/${encodeURIComponent(selectedAgent.id)}/extract-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
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

  async function handleToggleTeam(team) {
    const action = team.enabled === false ? 'enable' : 'disable';
    setTeamActionError(null);
    try {
      const { members } = await apiCall('GET', `/api/teams/${team.id}/members`);
      setTeamActionPrompt({ team, action, members });
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function handleTeamDisableConfirmed(mode) {
    const { team, members } = teamActionPrompt;
    setTeamActionBusy(true);
    setTeamActionError(null);
    try {
      const result = await apiCall('POST', `/api/teams/${team.id}/disable`, { mode });
      const summary = summarizeTeamAction(result, members);
      setTeamActionPrompt(null);
      refetch();
      if (summary.failedMembers.length > 0) {
        setTeamActionResult({ action: 'disable', ...summary });
      }
    } catch (e) {
      setTeamActionError(e.message);
    } finally {
      setTeamActionBusy(false);
    }
  }

  async function handleTeamEnableConfirmed() {
    const { team, members } = teamActionPrompt;
    setTeamActionBusy(true);
    setTeamActionError(null);
    try {
      const result = await apiCall('POST', `/api/teams/${team.id}/enable`, {});
      const summary = summarizeTeamAction(result, members);
      setTeamActionPrompt(null);
      refetch();
      if (summary.failedMembers.length > 0) {
        setTeamActionResult({ action: 'enable', ...summary });
      }
    } catch (e) {
      setTeamActionError(e.message);
    } finally {
      setTeamActionBusy(false);
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

  // Add a loop-closing role a team is missing, from its inferred source process
  // template (#1375). Reuses the members endpoint's process-template branch, then
  // disables the fresh member so nothing wakes until the operator confirms (AC3).
  async function handleAddRole(team, templateId, role) {
    const key = `${team.id}:${role.id}`;
    setAddingRoleKey(key);
    setActionError(null);
    setAddRoleNotice(null);
    try {
      const created = await apiCall('POST', `/api/agents/${team.id}/members`, {
        processTemplateId: templateId,
        roleId: role.id,
      });
      const memberId = (created && created.id) || `${team.id}-${role.id}`;
      // Start disabled — reuse the existing member disable path (PUT enabled:false)
      // rather than a new backend field, so nothing wakes until the operator
      // enables it. Best-effort: the role is already added even if this fails.
      try {
        await apiCall('PUT', `/api/agents/${memberId}`, { enabled: false });
      } catch { /* member added; leave enable state to the operator */ }
      setAddRoleNotice({ text: `Added ${role.displayName || role.id} (disabled). Enable it when you're ready to close the loop.` });
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setAddingRoleKey(null);
    }
  }

  async function handleDelete() {
    setDeleteBusy(true);
    try {
      await apiCall('DELETE', `/api/agents/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    } finally {
      setDeleteBusy(false);
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

  const headerAction = usePageActions(
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
      <input
        ref={importFileRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={handleImportFileSelected}
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
      <SecondaryBtn onClick={() => openPanel('create', null)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}>
        <Plus size={15} /> New Agent
      </SecondaryBtn>
    </div>
  );

  return (
    <>
      {headerAction}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <p style={{ margin: '0 0 var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
        {AGENTS_PAGE_COPY.subtitle}
      </p>
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

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)' }}>Dismiss</button>
        </div>
      )}

      {addRoleNotice && (
        <div role="status" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-success-bg, var(--eb-bg-elevated))', border: '1px solid var(--eb-status-success)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
          {addRoleNotice.text}
          <button onClick={() => setAddRoleNotice(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-success)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)' }}>Dismiss</button>
        </div>
      )}

      {totalCount === 0 ? (
        <div style={{
          padding: 'var(--eb-space-8)', textAlign: 'center',
          background: 'var(--eb-bg-surface)', border: '1px dashed var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--eb-space-4)',
        }}>
          <p style={{ margin: 0 }}>{AGENTS_PAGE_COPY.emptyLead} Start something new from the Create launcher:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', justifyContent: 'center' }}>
            <Link
              to={EMPTY_STATE_PRIMARY_CTA.to}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', borderRadius: 'var(--eb-radius-md)',
                background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
                fontWeight: 600, textDecoration: 'none', fontSize: 'var(--eb-text-sm)',
              }}
            >
              {EMPTY_STATE_PRIMARY_CTA.label}
            </Link>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--eb-text-xs)' }}>
            {AGENTS_PAGE_COPY.emptyAdvancedHint}
          </p>
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
              processTemplates={processTemplates}
              addingRoleKey={addingRoleKey}
              onAddRole={handleAddRole}
              onEdit={a => openPanel('edit', a)}
              onDelete={a => setDeleteTarget(a)}
              onAddMember={handleAddMember}
              onActivate={handleActivate}
              onDeactivate={a => setDeactivateTarget(a)}
              onToggleEnabled={handleToggleEnabled}
              onToggleTeam={handleToggleTeam}
              onEditChild={a => openPanel('edit', a)}
              onDeleteChild={a => setDeleteTarget(a)}
              onExport={handleExport}
              onCloneChild={a => openPanel('clone', a)}
              onExtractTemplateChild={a => openExtractPanel(a)}
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
              onClone={ag => openPanel('clone', ag)}
              onExtractTemplate={ag => openExtractPanel(ag)}
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
                  These agents reference a parent that no longer exists. Delete each one to remove its workspace and chat account.
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
        open={panelMode === 'import'}
        onClose={() => { setImportFile(null); closePanel(); }}
        title="Import Agent"
        width="480px"
      >
        {panelMode === 'import' && importFile && (
          <ImportAgentForm
            file={importFile}
            teams={teams}
            onSubmit={handleImportSubmit}
            onCancel={() => { setImportFile(null); closePanel(); }}
          />
        )}
      </SidePanel>

      <SidePanel
        open={panelMode === 'clone' && !!selectedAgent}
        onClose={closePanel}
        title={`Clone Agent — ${selectedAgent?.displayName ?? ''}`}
        width="480px"
      >
        {selectedAgent && panelMode === 'clone' && (
          <CloneAgentForm
            agent={selectedAgent}
            teams={teams}
            existingIds={existingAgentIds}
            onSubmit={handleCloneSubmit}
            onCancel={closePanel}
          />
        )}
      </SidePanel>

      <SidePanel
        open={panelMode === 'extract' && !!selectedAgent}
        onClose={closePanel}
        title={`Save as template — ${selectedAgent?.displayName ?? ''}`}
        width="480px"
      >
        {selectedAgent && panelMode === 'extract' && (
          <ExtractTemplateForm
            agent={selectedAgent}
            existingTemplateIds={extractTemplateIds}
            onSubmit={handleExtractSubmit}
            onCancel={closePanel}
          />
        )}
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
        busy={deleteBusy}
      />

      <ConfirmDialog
        open={!!deactivateTarget}
        title="Reset agent to stub?"
        message={
          `Reset "${deactivateTarget?.displayName ?? deactivateTarget?.id}" to its stub state? ` +
          `This stops the agent process and wipes the workspace. ` +
          `The stub config is kept so the agent can be reactivated later — but session history, ` +
          `cloned repositories, and any in-workspace state will be lost. ` +
          `To pause without losing anything, cancel and use the Disable toggle instead.`
        }
        variant="danger"
        confirmLabel="Reset to stub"
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

      <ConfirmDialog
        open={!!teamActionPrompt && teamActionPrompt.action === 'enable'}
        title={`Enable team "${teamActionPrompt?.team?.displayName ?? ''}"?`}
        message={teamActionPrompt && (
          <div>
            <p style={{ marginTop: 0 }}>
              This brings back every member this team disabled automatically. Members that were disabled on their own before the team was disabled stay off.
            </p>
            <ul style={{ margin: '0 0 var(--eb-space-2)', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)' }}>
              {(teamActionPrompt.members || []).filter(m => m.disabledByTeam).map(m => (
                <li key={m.id}>{m.displayName}</li>
              ))}
            </ul>
            {teamActionError && (
              <p style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{teamActionError}</p>
            )}
          </div>
        )}
        variant="info"
        confirmLabel="Enable team"
        busy={teamActionBusy}
        onConfirm={handleTeamEnableConfirmed}
        onCancel={() => { setTeamActionPrompt(null); setTeamActionError(null); }}
      />

      <TeamDisableDialog
        open={!!teamActionPrompt && teamActionPrompt.action === 'disable'}
        team={teamActionPrompt?.team}
        members={teamActionPrompt?.members || []}
        error={teamActionError}
        busy={teamActionBusy}
        onDrain={() => handleTeamDisableConfirmed('drain')}
        onAbort={() => handleTeamDisableConfirmed('abort')}
        onCancel={() => { setTeamActionPrompt(null); setTeamActionError(null); }}
      />

      <ConfirmDialog
        open={!!teamActionResult}
        variant="danger"
        alertOnly
        title={teamActionResult?.action === 'disable' ? 'Some members failed to disable' : 'Some members failed to enable'}
        message={teamActionResult && (
          <div>
            <p style={{ marginTop: 0 }}>
              {teamActionResult.failedMembers.length} member(s) could not be {teamActionResult.action === 'disable' ? 'disabled' : 'enabled'}:
            </p>
            <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)' }}>
              {teamActionResult.failedMembers.map(m => (
                <li key={m.id}><strong>{m.displayName}</strong> — {m.error}</li>
              ))}
            </ul>
          </div>
        )}
        onConfirm={() => setTeamActionResult(null)}
        onCancel={() => setTeamActionResult(null)}
      />
    </div>
    </>
  );
}
