// flow-copilot-view.js — pure view logic for the Flow Copilot chat panel
// (#1069, spec #1047). Everything here is renderer-free and unit-tested:
// mapping the session-local chat history to the stateless endpoint's message
// list, the proposal-card change/lint presentation, and the error taxonomy
// (provider-missing vs retryable transport). FlowCopilotPanel.jsx consumes it.

// Starter prompts shown as clickable chips in the empty state (#1047 UX spec).
export const STARTER_PROMPTS = [
  'An issue-triage agent labels new issues `req:refine`; a Business Analyst refines them; '
    + 'a human approves with `ready`; a Developer implements and opens a PR; a Code Reviewer '
    + 'either requests revisions or labels `ready-to-merge`; a Merger merges.',
  'Add a security reviewer that also reviews every PR.',
  'Insert a human approval gate before the dispatcher.',
];

/**
 * Map the panel's chat entries to the stateless endpoint's `messages` array.
 * The server only accepts `{role: 'user'|'assistant', content: string}`:
 * error rows are client-side furniture and are dropped; an assistant turn is
 * resent as its summary — the authoritative bundle state travels separately in
 * the request's `bundle` field, so replaying whole proposal JSON would only
 * burn context.
 */
export function toApiMessages(entries) {
  const out = [];
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e) continue;
    if (e.role === 'user' && typeof e.content === 'string') {
      out.push({ role: 'user', content: e.content });
    } else if (e.role === 'assistant') {
      const content = typeof e.summary === 'string' && e.summary.trim()
        ? e.summary
        : '(proposal without summary)';
      out.push({ role: 'assistant', content });
    }
  }
  return out;
}

// Change-kind → { verb, noun } for the proposal card's change list. Kinds come
// from computeChanges in api/flow-copilot.js.
const CHANGE_TEXT = {
  'role-added': 'Role added',
  'role-removed': 'Role removed',
  'role-modified': 'Role modified',
  'label-added': 'Label registered',
  'label-removed': 'Label removed',
  'label-modified': 'Label modified',
  'gate-added': 'Gate added',
  'gate-removed': 'Gate removed',
  'gate-modified': 'Gate modified',
  'stage-added': 'Stage added',
  'stage-removed': 'Stage removed',
  'stage-modified': 'Stage modified',
  'human-added': 'Human role added',
  'human-removed': 'Human role removed',
  'human-modified': 'Human role modified',
  'name-changed': 'Flow renamed to',
};

/** One human-readable line per change entry ({kind, id}). */
export function describeChange(change) {
  if (!change || typeof change !== 'object') return '';
  const label = CHANGE_TEXT[change.kind] || change.kind || 'Changed';
  return change.id ? `${label}: ${change.id}` : label;
}

/** Lint severity → the accent color token (mirrors LintsPanel's red/amber). */
export function lintColor(severity) {
  if (severity === 'error') return 'var(--eb-status-error)';
  if (severity === 'warning') return 'var(--eb-status-warning)';
  return 'var(--eb-text-muted)';
}

/**
 * Classify a failed POST /api/process/copilot for the chat's error row.
 * A 400 bundle-too-large is a non-retryable bundle-size error (AC2 #1404).
 * A 400 otherwise is a request-shape/provider problem — the panel always sends
 * a valid shape, so in practice it means no Model Provider is configured;
 * retrying the identical request cannot succeed, the fix is configuration.
 * A 504 is a retryable LLM timeout (AC3 #1404).
 * Everything else (502 transport, network) is retryable as-is.
 */
export function copilotErrorInfo(status, message) {
  if (status === 400 && message === 'bundle-too-large') {
    return { kind: 'bundle-too-large', retryable: false, message: 'bundle-too-large' };
  }
  const msg = typeof message === 'string' && message.trim() ? message.trim() : `Request failed (HTTP ${status || '?'})`;
  if (status === 400) return { kind: 'provider', retryable: false, message: msg };
  if (status === 504) return { kind: 'timeout', retryable: true, message: msg };
  return { kind: 'transport', retryable: true, message: msg };
}

// ── Bundle size helpers (AC4 #1404) ─────────────────────────────────────────
// Server-side guard is 200 000 chars. Amber fires 20% below that (160 000)
// so the user gets a warning before they hit the hard limit.

export const BUNDLE_AMBER_THRESHOLD = 160_000;
export const BUNDLE_RED_THRESHOLD = 200_000;

/** Character count of the bundle JSON (0 when bundle is null/undefined). */
export function bundleSizeCharCount(bundle) {
  if (bundle == null) return 0;
  try { return JSON.stringify(bundle).length; } catch { return 0; }
}

/** 'ok' | 'amber' | 'red' based on character count against the server guard. */
export function bundleSizeLevel(charCount) {
  if (charCount >= BUNDLE_RED_THRESHOLD) return 'red';
  if (charCount >= BUNDLE_AMBER_THRESHOLD) return 'amber';
  return 'ok';
}

/**
 * A new proposal supersedes every still-actionable one: only the latest
 * assistant card may carry live Apply/Discard buttons — an older bundle would
 * silently drop everything proposed after it.
 */
export function supersedePending(entries) {
  return (Array.isArray(entries) ? entries : []).map(e =>
    (e && e.role === 'assistant' && e.status === 'proposed') ? { ...e, status: 'superseded' } : e);
}

/** The latest assistant entry still awaiting an Apply/Discard decision. */
export function latestProposal(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.role === 'assistant' && e.status === 'proposed') return e;
  }
  return null;
}

// ── chat-history persistence (#1071 item 1) ──────────────────────────────────
// The draft file carries `copilot: { messages: [] }` — storage metadata, never
// part of the portable bundle. The client persists a compact projection of the
// chat (the server normalizes again on write): error rows are transient and
// dropped, proposal bundles are deliberately NOT persisted (they would bloat
// the draft; a reloaded proposal card shows as superseded and the user
// regenerates), and the history is capped to the last N turns.

export const PERSISTED_HISTORY_CAP = 20;

/** The compact, durable projection of the panel's chat entries. */
export function toPersistedMessages(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(e => e && (e.role === 'user' || e.role === 'assistant'))
    .map(e => {
      if (e.role === 'user') return { role: 'user', content: e.content };
      return {
        role: 'assistant',
        ...(e.summary ? { summary: e.summary } : {}),
        ...(Array.isArray(e.changes) && e.changes.length ? { changes: e.changes } : {}),
        ...(Array.isArray(e.lints) && e.lints.length ? { lints: e.lints } : {}),
        ok: !!e.ok,
        status: e.status === 'proposed' ? 'superseded' : (e.status || 'superseded'),
      };
    })
    .slice(-PERSISTED_HISTORY_CAP);
}

/** Rebuild live chat entries from a draft's persisted history. */
export function hydrateMessages(persisted, nextId) {
  const list = persisted && Array.isArray(persisted.messages) ? persisted.messages : [];
  return list
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => (m.role === 'user'
      ? { id: nextId(), role: 'user', content: String(m.content ?? '') }
      : {
        id: nextId(), role: 'assistant',
        summary: typeof m.summary === 'string' ? m.summary : '',
        changes: Array.isArray(m.changes) ? m.changes : [],
        lints: Array.isArray(m.lints) ? m.lints : [],
        ok: !!m.ok,
        // A persisted proposal has no bundle to apply — it can never be
        // actionable again, whatever was stored.
        status: m.status === 'proposed' ? 'superseded' : (m.status || 'superseded'),
        bundle: null, hasPreview: true,
      }));
}

// ── canvas diff-highlighting (#1071 item 2) ──────────────────────────────────
// While a proposal is pending, the preview graph badges the delta vs. the
// current bundle: added nodes green, modified amber, removed listed in the
// banner. Nodes are roles + humans, keyed by id; "modified" is a
// key-order-insensitive deep comparison (mirrors the server's change diff).

function stableStringify(x) {
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(',')}}`;
  }
  return JSON.stringify(x);
}

/**
 * Diff proposed vs. current bundle at node granularity.
 * @returns {{ added: string[], modified: string[], removed: {id, name}[] }}
 */
export function proposalNodeDiff(current, proposed) {
  const nodesOf = (b) => {
    const m = new Map();
    for (const r of (b && Array.isArray(b.roles) ? b.roles : [])) {
      if (r && typeof r.id === 'string' && r.id) m.set(r.id, { entity: r, name: r.displayName || r.id });
    }
    for (const h of (b && Array.isArray(b.humans) ? b.humans : [])) {
      if (h && typeof h.id === 'string' && h.id && !m.has(h.id)) m.set(h.id, { entity: h, name: h.name || h.id });
    }
    return m;
  };
  const before = nodesOf(current);
  const after = nodesOf(proposed);
  const added = [];
  const modified = [];
  const removed = [];
  for (const [id, { entity }] of after) {
    if (!before.has(id)) added.push(id);
    else if (stableStringify(before.get(id).entity) !== stableStringify(entity)) modified.push(id);
  }
  for (const [id, { name }] of before) {
    if (!after.has(id)) removed.push({ id, name });
  }
  return { added, modified, removed };
}

// ── NDJSON progress stream (#1070) ───────────────────────────────────────────
// POST /api/process/copilot streams `{type:'phase'}` lines while the
// generate → validate → repair loop runs, terminated by `{type:'result'}` or
// `{type:'error'}` (the /api/teams/stream mould). Pre-stream failures
// (bad request, no provider) stay plain non-ok JSON and never reach here.

/**
 * The live status line for a phase event. The server's repair budget is 2.
 * While the upstream LLM call streams, the server re-emits the current phase
 * with a `chars` count (the running reply size), so a large generation shows
 * real movement instead of a frozen "Generating…"; the suffix is dropped when
 * no size rode along (the pre-stream phase events, or the post-reply validate).
 */
export function phaseLabel(ev, maxRepairs = 2) {
  const chars = ev && Number.isFinite(ev.chars) ? ev.chars : 0;
  const size = chars > 0 ? ` · ${(chars / 1000).toFixed(1)}k chars` : '';
  if (ev && ev.phase === 'repairing') return `Repairing (${ev.iteration}/${maxRepairs})…${size}`;
  if (ev && ev.phase === 'validating') return 'Validating…';
  return `Generating…${size}`;
}

/**
 * Consume the NDJSON body of an OK copilot response: forward phase events to
 * `onPhase`, resolve with the terminal result payload. Throws (with `.status`
 * when the server reported one) on a terminal error event — and on a stream
 * that ends without a result, which is what a dropped connection looks like;
 * both surface as a retryable transport error row.
 */
export async function consumeCopilotStream(res, onPhase) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let result = null;
  let errorEv = null;
  const handle = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'phase') { if (onPhase) onPhase(ev); }
    else if (ev.type === 'result') result = ev;
    else if (ev.type === 'error') errorEv = ev;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* skip a corrupt line */ }
    }
  }
  // Trailing partial line (defensive — the server always ends with a newline,
  // but a dropped connection mid-line must not crash the parser).
  const tail = buf.trim();
  if (tail) { try { handle(JSON.parse(tail)); } catch { /* ignore */ } }
  if (errorEv) {
    const err = new Error(errorEv.error || `HTTP ${errorEv.status || 502}`);
    err.status = errorEv.status || 502;
    throw err;
  }
  if (!result) throw new Error('Connection lost during generation');
  return result;
}
