// Pure, framework-free helpers for rendering a human-readable summary of what a
// GitHub-event trigger listens for. Shared by the chat Triggers panel
// (`TriggerRow` in TriggersPanel.jsx) and the Flow/Process canvas trigger
// readout (`TemplateReadonly` in NodeInspector.jsx) so the friendly event
// wording has a single source of truth (#778).

// Subset of GitHub Events API event types most useful for agent workflows.
// (The Events API does not emit every webhook action — e.g. pull_request
// has opened/closed/reopened but not synchronize. It also splits closed
// PRs: `closed` for non-merged closes, `merged` for merged ones — so a
// "react to merge" trigger MUST subscribe to `pull_request.merged` even
// though webhooks call it `closed` with `merged: true`.)
export const GITHUB_EVENT_OPTIONS = [
  { value: 'push',                                  label: 'Push' },
  { value: 'pull_request.opened',                   label: 'PR opened' },
  { value: 'pull_request.closed',                   label: 'PR closed (without merge)' },
  { value: 'pull_request.merged',                   label: 'PR merged' },
  { value: 'pull_request.reopened',                 label: 'PR reopened' },
  { value: 'pull_request.labeled',                  label: 'PR labeled' },
  { value: 'pull_request.unlabeled',                label: 'PR unlabeled' },
  { value: 'pull_request_review.submitted',         label: 'PR review submitted' },
  { value: 'pull_request_review_comment.created',   label: 'PR review comment' },
  { value: 'issue_comment.created',                 label: 'Issue / PR comment' },
  { value: 'issues.opened',                         label: 'Issue opened' },
  { value: 'issues.closed',                         label: 'Issue closed' },
  { value: 'issues.labeled',                        label: 'Issue labeled' },
  { value: 'issues.unlabeled',                      label: 'Issue unlabeled' },
  { value: 'release.published',                     label: 'Release published' },
];

// Events that carry a `payload.label.name` GitHub sends — the only ones
// where a label-name filter makes sense. Used by the form to decide
// whether to show the label-name input, and by the card summary to decide
// whether to show the required-label portion.
export const LABEL_FILTERABLE_EVENTS = new Set([
  'issues.labeled',
  'issues.unlabeled',
  'pull_request.labeled',
  'pull_request.unlabeled',
]);

// Event keys the PLATFORM synthesizes, not GitHub (#2032). Deliberately a
// separate map rather than an entry in GITHUB_EVENT_OPTIONS: that array is the
// trigger editor's `<select>`, and a key nobody can subscribe to must never be
// offered there — a `handoff.wake` row is written by
// `POST /internal/wake-agent`, and the consumer's listener is a derived
// `wake-agent` trigger, not a `github-event` one.
export const INTERNAL_EVENT_LABELS = new Map([
  ['handoff.wake', 'direct hand-off'],
  // Jira plan §4B: a plugin broker woke an agent. Written by
  // `POST /internal/plugin-event`; the consumer's listener is a `plugin-event`
  // trigger, not a `github-event` one, so it is never a GITHUB_EVENT_OPTIONS key.
  ['plugin.event', 'plugin event'],
]);

const EVENT_LABELS = new Map(GITHUB_EVENT_OPTIONS.map(o => [o.value, o.label]));

// Friendly label for an event key (e.g. `issues.labeled` → "Issue labeled"),
// falling back to the raw key for keys not in either map so an unknown or
// hand-edited event never renders blank.
export function eventLabel(value) {
  if (!value) return '';
  return EVENT_LABELS.get(value) || INTERNAL_EVENT_LABELS.get(value) || String(value);
}

// Whether any of the given event keys carries a `payload.label.name` that a
// label-name filter can match against — the guard for showing the required
// label on a card even when a stale `labelFilter` value lingers in the data.
export function eventsAreLabelFilterable(events) {
  return (Array.isArray(events) ? events : []).some(e => LABEL_FILTERABLE_EVENTS.has(e));
}

// Compact one-line summary of a `loop` trigger's stop contract, for the
// trigger-row header (`TriggerRow` in TriggersPanel.jsx). Surfaces the three
// loop-defining facts the design calls out (concept §4.5): budget (`≤N iter`,
// optional token cap), stop condition (`until: <cmd>`) and verifier
// (`✓ <role|command>`). Framework-free so it has a single source of truth and
// its own unit tests. Returns a string (never blank — falls back to "loop").
export function summarizeLoopTrigger(trigger) {
  const parts = [];
  const max = trigger?.maxIterations;
  if (Number.isFinite(max) && max > 0) parts.push(`≤${max} iter`);
  const maxTokens = trigger?.maxTokens;
  if (Number.isFinite(maxTokens) && maxTokens > 0) parts.push(`≤${compactTokens(maxTokens)} tok`);
  const untilCmd = trigger?.until && typeof trigger.until === 'object'
    ? trigger.until.command : null;
  if (untilCmd && String(untilCmd).trim()) parts.push(`until: ${String(untilCmd).trim()}`);
  const v = trigger?.verify;
  if (v && typeof v === 'object') {
    if (v.agentId && String(v.agentId).trim()) parts.push(`✓ ${String(v.agentId).trim()}`);
    else if (v.command && String(v.command).trim()) parts.push(`✓ ${String(v.command).trim()}`);
    else if (v.flow === true) parts.push('→ flow');
  }
  return parts.length ? parts.join(' · ') : 'loop';
}

// Compact a token budget for a badge: 2000000 → "2M", 500000 → "500k",
// 750 → "750". Shared by the trigger-row and canvas loop summaries.
function compactTokens(n) {
  return n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}k`
      : String(n);
}

// Compact one-line summary of a `loop` self-edge for the Flows-canvas
// stop-contract badge (#936). It takes the *graph-edge* loop summary emitted by
// `process-graph.js` (`buildProcessGraph` → `unified-graph`), which redacts the
// verifier internals: `verify` here is `{ mode, agentId? }` (never the command
// string), not the raw trigger's `{ command | agentId | selfGraded }`. Surfaces
// the three loop-defining facts (concept §4.5): budget (`≤N iter`, optional
// token cap), stop condition (`until: <cmd>`) and verifier (`✓ <role>` for an
// agent verifier, `✓ check` for a command verifier, `✓ self` when self-graded,
// `→ flow` when verification is delegated to the downstream QS chain).
// Returns a string (never blank — falls back to "loop").
export function summarizeLoopEdge(loop) {
  if (!loop || typeof loop !== 'object') return 'loop';
  const parts = [];
  const max = loop.maxIterations;
  if (Number.isFinite(max) && max > 0) parts.push(`≤${max} iter`);
  const maxTokens = loop.maxTokens;
  if (Number.isFinite(maxTokens) && maxTokens > 0) parts.push(`≤${compactTokens(maxTokens)} tok`);
  const untilCmd = loop.until && typeof loop.until === 'object' ? loop.until.command : null;
  if (untilCmd && String(untilCmd).trim()) parts.push(`until: ${String(untilCmd).trim()}`);
  const v = loop.verify;
  if (v && typeof v === 'object') {
    if (v.mode === 'agent' && v.agentId && String(v.agentId).trim()) parts.push(`✓ ${String(v.agentId).trim()}`);
    else if (v.mode === 'command') parts.push('✓ check');
    else if (v.mode === 'self-graded') parts.push('✓ self');
    else if (v.mode === 'flow') parts.push('→ flow');
  }
  return parts.length ? parts.join(' · ') : 'loop';
}

// ── claim labels (#958, concept §3.4–§3.5) ───────────────────────────────────
// A label listener's claim is what it TAKES OVER when it wakes: the runtime swaps
// the wake label for `<wake>:wip` before the Claude call, so a stalled run is
// visible on GitHub. These helpers are the single source of the editor's claim
// wording, mirroring summarizeLoopEdge above (pure, unit-tested, no JSX).

// The glyph used for the claim badge on a listener edge. Deliberately one
// character wide: it is appended to an already-crowded edge chip.
export const CLAIM_MARKER = '⇥';

// Whether a claim blob is well-formed enough to render.
export function hasClaim(claim) {
  return !!(claim && typeof claim === 'object'
    && typeof claim.remove === 'string' && claim.remove.trim()
    && typeof claim.add === 'string' && claim.add.trim());
}

// Compact edge-badge text, e.g. `⇥ wip`. Kept short so the chip stays readable —
// the full swap goes in the tooltip via claimTooltip().
export function summarizeClaimEdge(claim) {
  if (!hasClaim(claim)) return '';
  const add = claim.add.trim();
  const remove = claim.remove.trim();
  // `ready` → `ready:wip` is the convention, so show only the distinguishing
  // suffix; a hand-authored claim that doesn't extend the wake label is shown
  // whole rather than mis-abbreviated.
  const suffix = add.startsWith(`${remove}:`) ? add.slice(remove.length + 1) : add;
  return `${CLAIM_MARKER} ${suffix}`;
}

// Full, human-readable claim for a tooltip / read-only readout.
export function claimTooltip(claim) {
  if (!hasClaim(claim)) return '';
  return `Claims the label when it wakes: ${claim.remove.trim()} → ${claim.add.trim()}`;
}

// Structured, human-readable summary of a github-event trigger's firing
// condition. Returns `{ events: string[] (friendly labels), label: string|null }`.
// The label is present only when a `labelFilter` is set AND at least one of the
// trigger's events is label-filterable (AC2/AC4/AC5).
export function summarizeGithubEventTrigger(trigger) {
  const raw = Array.isArray(trigger?.events) ? trigger.events : [];
  const events = raw.map(eventLabel).filter(Boolean);
  const label = trigger?.labelFilter && eventsAreLabelFilterable(raw)
    ? String(trigger.labelFilter)
    : null;
  return { events, label };
}

// The claim payload a TriggersPanel save carries (#1006): the raw layer follows
// the same `<wake>:wip` convention as the engine paths. Returns the claim
// object when the listener is a claimed `.labeled` label listener, `null` to
// clear a stored claim on edit, and `undefined` (field omitted) on an
// unclaimed create. Pure — unit-tested against the server-side validator's
// expectations.
export function claimBodyFor({ labelFilter, events, claimOn, isEdit }) {
  const lf = String(labelFilter || '').trim();
  const labeled = (Array.isArray(events) ? events : [])
    .some(e => e === 'issues.labeled' || e === 'pull_request.labeled');
  if (lf && labeled && claimOn) return { remove: lf, add: `${lf}:wip` };
  return isEdit ? null : undefined;
}

// Delivery-transport field for a saved github-event trigger body (#1189). Pure
// mirror of the TriggerForm decision so it is unit-testable:
//   - a label listener (`showTransport`) writes an EXPLICIT value — 'github'
//     too, never omitted, so toggling internal → github clears a stored
//     'internal' on the PUT `{...prev, ...body}` merge;
//   - a trigger that is not (or no longer) a label listener but carried a stale
//     transport gets it cleared to 'github' on edit;
//   - a plain non-label trigger keeps no transport key (undefined drops).
// Returns the value to assign to `body.transport`, or undefined to omit it.
export function transportBodyFor({ showTransport, transport, isEdit, priorTransport }) {
  if (showTransport) return transport === 'internal' ? 'internal' : 'github';
  if (isEdit && priorTransport) return 'github';
  return undefined;
}

// A chat-launched loop (#1020): a one-off "run until done" started from the
// composer, not a standing subscription. It is a `loop`-type trigger tagged
// `launched: true` while it runs (the runtime removes it on any terminal
// outcome). Pure predicate — used to reflect the composer's running state.
export function isLaunchedLoop(trigger) {
  return !!trigger && trigger.type === 'loop' && !!trigger.launched;
}

// Whether a trigger belongs in the chat Triggers list (#1020 AC4). A loop is a
// launched run, not a standing subscription, so it never appears there — the
// list holds only cron / once / http / github-event / data-flow. Loops are
// authored from the composer (chat-launched) or the Flows canvas (declarative).
export function isStandingSubscription(trigger) {
  return !!trigger && trigger.type !== 'loop';
}
