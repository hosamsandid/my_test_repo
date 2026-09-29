// Pure view helpers for the Flow Control board (#2573, concept
// `docs/flow-control-concept.md` Amendment 3). Dependency-free so it
// unit-tests under `node --test` in the `admin-console-src` job — the JSX page
// cannot be imported there (#651).
//
// The board answers one question — who is working on what, and where does a
// person have to step in. Every decision (which items appear, the stages, the
// row's position, the human-block reason) is made server-side by
// `orchestrator/flow-board.js`; this module only turns that response into
// display strings. It never reads a GitHub label.
//
// Input is the `GET /api/teams/:teamId/flow-board` response:
//   { stages[{id,label,roles}], rows[], needsHuman[], sessions[], pools[],
//     held[], config, canManage, generatedAt, stale, warning, maintenance }

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

// "4m", "3h 10m", "2d 5h" — compact enough for a table cell, precise enough
// that two rows can be compared at a glance.
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'under 1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// Time elapsed since an ISO timestamp, or '' when it is missing or unparseable.
export function since(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return formatDuration(Math.max(0, now - t));
}

// The header's "Updated 12s ago". Seconds matter here: with a 30 s refresh the
// operator wants to see the counter reset.
export function updatedAgo(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return 'Updated just now';
  if (s < 60) return `Updated ${s}s ago`;
  return `Updated ${formatDuration(s * 1000)} ago`;
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

// `o/r#12` → `#12` when the whole board is one repository; the full ref
// otherwise, so two repos' #12 never read the same.
export function itemRef(repo, number, singleRepo) {
  if (number == null) return '';
  return singleRepo || !repo ? `#${number}` : `${repo}#${number}`;
}

function prLinks(prs, singleRepo) {
  return (Array.isArray(prs) ? prs : []).map((p) => ({
    key: `${p.repo}#${p.number}`,
    label: `PR ${itemRef(p.repo, p.number, singleRepo)}`,
    url: p.url || null,
    state: p.state || 'open',
  }));
}

const STATUS_TEXT = {
  working: 'working',
  queued: 'up next',
  idle: 'waiting',
  ready: 'released',
  done: 'done',
};

// One board row: title, links, the progress steps and the current stage with
// its time in stage. `stages` is the board's own stage list, so the step count
// is exactly the team's hand-off chain.
export function rowView(row, stages, { now = Date.now(), singleRepo = true } = {}) {
  const list = Array.isArray(stages) ? stages : [];
  const current = Number.isInteger(row.stageIndex) ? row.stageIndex : list.findIndex((s) => s.id === row.stageId);
  const steps = list.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: i < current || row.done ? 'past' : i === current ? 'current' : 'future',
  }));
  const stage = list[current] || null;
  return {
    id: row.id,
    title: row.title || '(untitled)',
    url: row.url || null,
    ref: row.issue ? itemRef(row.issue.repo, row.issue.number, singleRepo) : '',
    issueUrl: row.issue ? row.issue.url || row.url || null : null,
    prs: prLinks(row.prs, singleRepo),
    steps,
    stageLabel: stage ? stage.label : '',
    status: row.status,
    statusText: STATUS_TEXT[row.status] || '',
    agentId: row.agentId || null,
    inStage: since(row.since, now),
    done: !!row.done,
    blocked: !!row.needsHuman,
  };
}

// ---------------------------------------------------------------------------
// Area ① — who is working right now
// ---------------------------------------------------------------------------

export function sessionView(s, { now = Date.now(), singleRepo = true } = {}) {
  const item = s.issue
    ? itemRef(s.issue.repo, s.issue.number, singleRepo)
    : Array.isArray(s.prs) && s.prs[0]
      ? `PR ${itemRef(s.prs[0].repo, s.prs[0].number, singleRepo)}`
      : '';
  return {
    id: s.id || s.agentId,
    role: s.roleLabel || s.roleId || s.agentId,
    instance: s.instance != null ? `#${s.instance}` : null,
    agentId: s.agentId,
    item,
    title: s.title || null,
    running: since(s.startedAt, now),
  };
}

// Tooltips a newcomer can act on: what happens to running work, what happens
// to new work, and how to undo it. `help-topics/flow-control.md` quotes the
// same three facts — `flow-control-view.test.js` keeps the two in step.
export const POOL_ACTION_TOOLTIPS = Object.freeze({
  pause: 'Pause: running instances finish their current work. New work waits in a queue and starts when you click Resume.',
  drain: 'Drain: running instances finish their current work, new work waits, and the role switches itself Off once the last one is done. Click Switch on to start it again.',
  resume: 'Resume: start taking new work again. Anything that waited while paused starts now.',
  switchOn: 'Switch on: start taking new work again. Anything that waited while the role was off starts now.',
});

// One pooled role: occupancy, the plain-language state and the buttons that
// apply to it. `running` → Pause + Drain; `paused` → Resume; `draining` and
// `off` → Switch on (the same "back to running" write, named for what the
// operator sees).
export function poolView(p) {
  const busy = Number.isFinite(p.busy) ? p.busy : 0;
  const occupancy = p.capacity != null ? `${busy} of ${p.capacity} busy` : `${busy} busy`;
  const held = Number.isFinite(p.held) && p.held > 0 ? p.held : 0;
  const waiting = held ? ` · ${held} waiting` : '';
  let stateText;
  let actions;
  switch (p.state) {
    case 'paused':
      stateText = `Paused${busy ? `, ${busy} still running` : ''}${waiting}`;
      actions = ['resume'];
      break;
    case 'draining':
      stateText = `Draining, ${busy} still running${waiting}`;
      actions = ['switchOn'];
      break;
    case 'off':
      stateText = `Off${waiting}`;
      actions = ['switchOn'];
      break;
    default:
      stateText = null;
      actions = ['pause', 'drain'];
  }
  return {
    key: p.roleId || p.agentId,
    roleId: p.roleId,
    label: p.label || p.roleId,
    occupancy,
    state: p.state || 'running',
    stateText,
    actions: actions.map((a) => ({
      id: a,
      label: { pause: 'Pause', drain: 'Drain', resume: 'Resume', switchOn: 'Switch on' }[a],
      tooltip: POOL_ACTION_TOOLTIPS[a],
      nextState: a === 'pause' ? 'paused' : a === 'drain' ? 'draining' : 'running',
    })),
  };
}

// ---------------------------------------------------------------------------
// Area ② — where a person is needed
// ---------------------------------------------------------------------------

export function needsYouView(entry, { now = Date.now(), singleRepo = true } = {}) {
  const ref = entry.issue
    ? itemRef(entry.issue.repo, entry.issue.number, singleRepo)
    : Array.isArray(entry.prs) && entry.prs[0]
      ? `PR ${itemRef(entry.prs[0].repo, entry.prs[0].number, singleRepo)}`
      : '';
  return {
    id: entry.id,
    ref,
    title: entry.title || '(untitled)',
    url: entry.url || null,
    reason: entry.reason || (entry.needsHuman && entry.needsHuman.reason) || '',
    waiting: since(entry.since || (entry.needsHuman && entry.needsHuman.since), now),
  };
}

// ---------------------------------------------------------------------------
// The whole board
// ---------------------------------------------------------------------------

export const EMPTY_TEXT = 'Nothing in progress';

// Everything the page renders, in render order. Area ② is `null` when empty
// so the page simply does not mount it (AC8).
export function boardView(data, now = Date.now()) {
  const d = data || {};
  const repos = Array.isArray(d.repos) ? d.repos : [];
  const opts = { now, singleRepo: repos.length <= 1 };
  const stages = Array.isArray(d.stages) ? d.stages : [];
  const rows = (Array.isArray(d.rows) ? d.rows : []).map((r) => rowView(r, stages, opts));
  const needs = (Array.isArray(d.needsHuman) ? d.needsHuman : []).map((n) => needsYouView(n, opts));
  return {
    stages,
    roles: Array.isArray(d.roles) ? d.roles : [],
    sessions: (Array.isArray(d.sessions) ? d.sessions : []).map((s) => sessionView(s, opts)),
    pools: (Array.isArray(d.pools) ? d.pools : []).map(poolView),
    held: Array.isArray(d.held) ? d.held : [],
    needsYou: needs.length ? needs : null,
    rows,
    empty: rows.length === 0,
    emptyText: EMPTY_TEXT,
    warning: d.warning || null,
    stale: !!d.stale,
    partial: Array.isArray(d.warnings) ? d.warnings : [],
    noRepos: !d.maintenance && repos.length === 0 && d.generatedAt != null,
    maintenance: !!d.maintenance,
    canManage: !!d.canManage,
    doneRetentionHours: d.doneRetentionHours ?? (d.config && d.config.doneRetentionHours) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Auto-refresh preference — remembered per user
// ---------------------------------------------------------------------------

export const AUTO_REFRESH_MS = 30_000;
const AUTO_REFRESH_PREFIX = 'flowControl.autoRefresh.';

// Per-username key, matching `agentChat.coachmark.<id>.<username>`; a missing
// username (the env single-admin) falls back to a shared `anon` bucket.
export function autoRefreshKey(username) {
  return `${AUTO_REFRESH_PREFIX}${username || 'anon'}`;
}

function resolveStore(store) {
  if (store) return store;
  return typeof window !== 'undefined' ? window.localStorage : null;
}

// On unless the user switched it off — the board is a live view.
export function readAutoRefresh(username, store) {
  const ls = resolveStore(store);
  if (!ls) return true;
  try {
    return ls.getItem(autoRefreshKey(username)) !== 'off';
  } catch {
    return true;
  }
}

export function writeAutoRefresh(username, on, store) {
  const ls = resolveStore(store);
  if (!ls) return;
  try {
    ls.setItem(autoRefreshKey(username), on ? 'on' : 'off');
  } catch {
    /* ignore — the worst case is the default next visit */
  }
}

// ---------------------------------------------------------------------------
// Column configuration (optional, per team)
// ---------------------------------------------------------------------------

// The editable form of the config: one entry per role in the order the graph
// derives (`roles` from the board response — before any rename/merge/hide, so
// a hidden or merged role can be brought back). Ready and Done are fixed frames
// and never appear here.
export function configFormRows(roles, config) {
  const cfg = (config && config.stages) || {};
  return (Array.isArray(roles) ? roles : []).map((r) => {
    const c = cfg[r.id] || {};
    return {
      id: r.id,
      derivedLabel: r.label || r.id,
      label: c.label || '',
      hidden: !!c.hidden,
      mergeInto: c.mergeInto || '',
    };
  });
}

// Back to the stored shape; empty fields are dropped so "no config" stays the
// automatic derivation.
export function configFromForm(formRows, doneRetentionHours) {
  const stages = {};
  for (const r of Array.isArray(formRows) ? formRows : []) {
    const entry = {};
    if (r.label && r.label.trim()) entry.label = r.label.trim();
    if (r.hidden) entry.hidden = true;
    if (r.mergeInto && r.mergeInto !== r.id) entry.mergeInto = r.mergeInto;
    if (Object.keys(entry).length) stages[r.id] = entry;
  }
  const hours = Number(doneRetentionHours);
  return {
    doneRetentionHours: Number.isFinite(hours) && hours >= 0 ? hours : 24,
    stages,
  };
}
