// Pure, framework-free helpers for rendering a human-readable summary of what a
// GitHub-event trigger listens for. Shared by the chat Triggers panel
// (`TriggerRow` in TriggersPanel.jsx) and the Flow/Process canvas trigger
// readout (`TemplateReadonly` in NodeInspector.jsx) so the friendly event
// wording has a single source of truth (#778).

import { parseBranchFilter } from './branch-filter.js';

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
  // #2754: a person released an orphaned `:wip` claim from the Flow Control
  // board. Written by `orchestrator/flow-claim-release.js` (CLAIM_RELEASED_EVENT).
  ['flow-control.claim-released', 'claim released (Flow Control)'],
  // #2693: the provisioning sweep removed (or tried to remove) an orphaned
  // instance. Written by `orchestrator/orchestrator.js` with
  // `provisioning-sweep.js` PROVISIONING_SWEEP_KEY.
  ['provisioning.reaped', 'orphaned instance cleaned up'],
]);

// Display-only names for the remaining keys the GitHub poller can write to the
// Event Log (#2535): its `TYPE_KEY` event types × the Events API's actions,
// plus the few event types it has no `TYPE_KEY` entry for but still keys by
// their lower-cased type (`member`, `public`, `gollum`). Deliberately NOT part
// of GITHUB_EVENT_OPTIONS, for the same reason as INTERNAL_EVENT_LABELS: that
// array is the trigger editor's `<select>`, and reading an event's name must
// never silently add it to what a trigger can subscribe to.
export const DISPLAY_EVENT_LABELS = new Map([
  // The Events API reports a submitted review as `created`; webhooks (and the
  // trigger editor) call the same action `submitted`.
  ['pull_request_review.created',          'PR review submitted'],
  ['pull_request.edited',                  'PR edited'],
  ['pull_request.synchronize',             'PR updated with new commits'],
  ['pull_request.assigned',                'PR assigned'],
  ['pull_request.unassigned',              'PR unassigned'],
  ['pull_request.review_requested',        'PR review requested'],
  ['pull_request.review_request_removed',  'PR review request removed'],
  ['issue_comment.edited',                 'Issue / PR comment edited'],
  ['issue_comment.deleted',                'Issue / PR comment deleted'],
  ['issues.reopened',                      'Issue reopened'],
  ['issues.edited',                        'Issue edited'],
  ['issues.assigned',                      'Issue assigned'],
  ['issues.unassigned',                    'Issue unassigned'],
  ['create',                               'Branch or tag created'],
  ['delete',                               'Branch or tag deleted'],
  ['fork',                                 'Repository forked'],
  ['watch.started',                        'Repository starred'],
  ['commit_comment.created',               'Commit comment'],
  ['release.created',                      'Release created'],
  ['release.edited',                       'Release edited'],
  ['release.prereleased',                  'Pre-release published'],
  ['release.released',                     'Release released'],
  ['release.unpublished',                  'Release unpublished'],
  ['release.deleted',                      'Release deleted'],
  ['member.added',                         'Collaborator added'],
  ['public',                               'Repository made public'],
  ['gollum',                               'Wiki updated'],
]);

const EVENT_LABELS = new Map(GITHUB_EVENT_OPTIONS.map(o => [o.value, o.label]));

// Friendly label for an event key (e.g. `issues.labeled` → "Issue labeled"),
// falling back to the raw key for keys not in any map so an unknown or
// hand-edited event never renders blank.
export function eventLabel(value) {
  if (!value) return '';
  return EVENT_LABELS.get(value)
    || INTERNAL_EVENT_LABELS.get(value)
    || DISPLAY_EVENT_LABELS.get(value)
    || String(value);
}

// Search text for an event key (#2442): the friendly name the Event column
// shows, plus the raw key so an operator who knows the API vocabulary still
// finds the row. Never repeats the key when it is its own fallback label.
export function eventFilterText(value) {
  const raw = typeof value === 'string' ? value : '';
  const friendly = eventLabel(value);
  return [...new Set([friendly, raw].filter(Boolean))].join(' ');
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
  // #2570: the push branch filter only applies to the `push` event, so it is
  // shown only when the trigger listens on push. null = every branch.
  const branchList = raw.includes('push') ? parseBranchFilter(trigger?.branchFilter) : [];
  const branches = branchList.length ? branchList.join(', ') : null;
  return { events, label, branches };
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

// The optional "pushed by agent" producer filter on a push trigger (#2571), as
// a clean id list — `[]` when unset (= any push).
export function pushedByIds(trigger) {
  const raw = Array.isArray(trigger?.pushedBy) ? trigger.pushedBy : [];
  return [...new Set(raw.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))];
}

// The `pushedBy` field for a saved trigger body (#2571). Pure mirror of the
// TriggerForm decision:
//   - not (or no longer) a push trigger → `null` on edit when a filter was
//     stored (the backend rejects a filter on a non-push trigger), else omitted;
//   - agents picked → that list;
//   - nothing picked → `[]` (explicit "any push") when a filter was stored or
//     the trigger is a data-flow hand-off, so the reconciler / start-up
//     migration never silently re-adds a filter the author removed; a plain
//     push trigger with no filter stays field-less.
// Returns the value to assign to `body.pushedBy`, or undefined to omit it.
export function pushedByBodyFor({ isPush, isDataFlow, selected, isEdit, priorPushedBy }) {
  const hadField = Array.isArray(priorPushedBy);
  if (!isPush) return (isEdit && hadField) ? null : undefined;
  const ids = pushedByIds({ pushedBy: selected });
  if (ids.length) return ids;
  if (isDataFlow || (isEdit && hadField)) return [];
  return undefined;
}

// Card schedule for a push trigger (#2571 AC9): "wakes on push from Specifier
// to owner/repo". `nameOf(id)` resolves a display name (falls back to the id).
export function summarizePushSchedule(trigger, nameOf = (id) => id) {
  const names = pushedByIds(trigger).map(id => nameOf(id) || id);
  const from = names.length ? ` from ${names.join(', ')}` : '';
  return `wakes on push${from} to ${trigger?.repo || 'the team repo'}`;
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
