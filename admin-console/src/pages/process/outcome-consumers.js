// Derived, read-only consumers of an outcome — the "who listens for this?"
// column shared by the Flow-Editor Routing tab (RoutingSection.jsx, where this
// logic originated in #828) and the Agent-Chat right rail's read-only Outcomes
// tab (#963). Extracted so the two surfaces cannot drift: the rail is meant to
// show exactly what the editor shows, minus the editing.
//
// `peers` are the sibling nodes of the same flow graph — anything with
// `{ id, displayName?, triggers?, channels? }`. Both call sites feed it the
// graph nodes from `GET /api/process/graph` (or the draft-derived equivalent),
// so `labelFilter` / `channels` are already projected.
//
// Pure + framework-free so it is unit-testable under `node --test`.

import { WAKE_EDGE_LEGEND } from './wake-edge-view.js';

// Peers that consume an outcome's signal: they either listen on one of the
// labels the outcome sets, or (openPr / openIssue) consume a PR/issue channel
// from this node.
export function consumersFor(option, node, peers) {
  const names = new Set();
  const actions = Array.isArray(option?.actions) ? option.actions : [];
  const labels = actions.filter(a => a.type === 'setLabel' && a.label).map(a => a.label);
  const opensPr = actions.some(a => a.type === 'openPr');
  const opensIssue = actions.some(a => a.type === 'openIssue');
  for (const p of (Array.isArray(peers) ? peers : [])) {
    if (!p || p.id === node?.id) continue;
    const listensLabel = (p.triggers || []).some(t => typeof t.labelFilter === 'string' && labels.includes(t.labelFilter));
    const chans = Array.isArray(p.channels) ? p.channels : [];
    const consumesPr = opensPr && chans.some(c => c.artifact === 'pr' && c.from === node?.id);
    const consumesIssue = opensIssue && chans.some(c => c.artifact === 'issue' && c.from === node?.id);
    if (listensLabel || consumesPr || consumesIssue) names.add(p.displayName || p.id);
  }
  return [...names];
}

// Peers that listen on a bare label token. The legacy flat-`emits` counterpart
// of consumersFor: an unstructured emit carries no actions, only a label.
export function labelConsumers(label, node, peers) {
  if (typeof label !== 'string' || !label) return [];
  return consumersFor({ actions: [{ type: 'setLabel', label }] }, node, peers);
}

// Named human reviewers of an outcome's artifact (#1001, concept §1 D4): a
// bound human role counts as a consumer of an `openPr`/`openIssue` action when
// the humans registry carries a matching `{artifact: 'pr'|'issue', from:
// thisAgent}` consume — the same binding that draws the delivery edge and
// suppresses `producer-unconsumed` server-side (process-graph.js, #987), so
// the Routing tab and the Flows lint list agree. Returns display names.
// `humans` accepts the raw registry (graph.humans / bundle.humans) or the
// graph's `kind: 'human'` nodes — both carry `consumes` and a name.
export function outcomeHumanReviewers(option, node, humans) {
  const actions = Array.isArray(option?.actions) ? option.actions : [];
  const opensPr = actions.some(a => a && a.type === 'openPr');
  const opensIssue = actions.some(a => a && a.type === 'openIssue');
  if (!opensPr && !opensIssue) return [];
  const names = new Set();
  for (const h of (Array.isArray(humans) ? humans : [])) {
    if (!h || !h.id) continue;
    const consumed = (Array.isArray(h.consumes) ? h.consumes : []).some(c => c
      && c.from === node?.id
      && ((opensPr && c.artifact === 'pr') || (opensIssue && c.artifact === 'issue')));
    if (consumed) names.add(h.displayName || h.name || h.id);
  }
  return [...names];
}

/* ── direct hand-offs (#2057) ─────────────────────────────────────────────────
 *
 * A `wakeAgent` action (#2030) names its consumer in the action itself: the
 * producer runs `aee-wake --to <roleId>`, the orchestrator enqueues the wake and
 * the target's listener is DERIVED (`expandWakeHandoffs`). So — unlike a label,
 * whose consumer has to be found by matching a `labelFilter` across the peers —
 * there is nothing to search for and no way for the relationship to be missing.
 * Both consumer summaries fell through to their "nothing reacts to this" branch
 * simply because neither helper knew the action type, which made a correctly
 * wired hand-off read as a broken flow on both surfaces.
 *
 * The three states are the same three the graph's own lints distinguish
 * (`process-graph.js`, #2032), deliberately by the same rules so the panel and
 * the lint list cannot disagree about one hand-off:
 *
 *   'ok'         — the target is another agent of this flow and can receive it.
 *   'unresolved' — the target is not an agent in this flow (a stale id from an
 *                  import, a role materialised as several members, a person, or
 *                  the producer itself). `buildProcessGraph` draws no edge for
 *                  it and delivery refuses it, so it must never read as a
 *                  consumer — but it must not vanish either (#2057 AC6).
 *   'disabled'   — the target's own `wake-agent` listeners are all switched off,
 *                  so the entry is dequeued and dropped (AC7). Narrower than
 *                  "has no listener" for the same reason `wake-target-disabled`
 *                  is: that listener is derived, so its absence in a draft is
 *                  the reconciler's business, not an authoring error.
 */
export const HANDOFF_OK = 'ok';
export const HANDOFF_UNRESOLVED = 'unresolved';
export const HANDOFF_DISABLED = 'disabled';

/**
 * The direct hand-offs one outcome carries, in action order:
 * `[{ to, name, state }]`. `peers` is the same flow-node list `consumersFor`
 * takes; `node` is the producer (a self-hand-off is `unresolved`, never a
 * consumer). Deduplicated by target, mirroring `outcomeWakePairs`.
 */
export function outcomeHandoffs(option, node, peers) {
  const agents = new Map();
  for (const p of (Array.isArray(peers) ? peers : [])) {
    // Positively `agent` (the `consumerCandidates` rule): the live graph's node
    // list also carries human roles and the `@github`/`@external`/`@timer`
    // actor pseudo-nodes, and a hand-off to any of them is refused on delivery.
    if (p && p.id && (p.kind || 'agent') === 'agent') agents.set(p.id, p);
  }
  const out = [];
  const seen = new Set();
  for (const a of (Array.isArray(option?.actions) ? option.actions : [])) {
    if (!a || a.type !== 'wakeAgent') continue;
    const to = typeof a.to === 'string' ? a.to.trim() : '';
    // A `to`-less hand-off is dropped by the Routing tab on Save and refused by
    // the server, so it should never persist; if one is reached defensively it
    // names nobody, and inventing a consumer for it is the one thing this
    // module must not do.
    if (!to || seen.has(to)) continue;
    seen.add(to);
    const target = to === node?.id ? null : agents.get(to);
    if (!target) { out.push({ to, name: to, state: HANDOFF_UNRESOLVED }); continue; }
    const listeners = (Array.isArray(target.triggers) ? target.triggers : [])
      .filter(t => t && t.type === 'wake-agent');
    const state = listeners.length && listeners.every(t => t.enabled === false)
      ? HANDOFF_DISABLED
      : HANDOFF_OK;
    out.push({ to, name: target.displayName || to, state });
  }
  return out;
}

/**
 * The consumer statement for one hand-off, as `{ tone, text }` — shared by both
 * surfaces (#2057 AC13) so the Outcomes tab and the Routing tab cannot drift in
 * either wording or severity.
 *
 * The healthy wording answers the same question a label hand-off's does ("who
 * continues the work?") in the same words, with the mechanism as a parenthetical
 * (#2057 D1) — reusing `WAKE_EDGE_LEGEND`, which the canvas legend and the event
 * log's Event column already carry, rather than introducing a fourth phrasing.
 * A broken target states the fact only and leaves the explanation to the
 * `wake-target-unresolved` / `wake-target-disabled` lints (D4).
 */
export function handoffStatement(handoff) {
  const name = (handoff && (handoff.name || handoff.to)) || '';
  if (handoff && handoff.state === HANDOFF_UNRESOLVED) {
    return { tone: 'warning', text: `hands off directly to ${name} — target unresolved` };
  }
  if (handoff && handoff.state === HANDOFF_DISABLED) {
    return { tone: 'warning', text: `hands off directly to ${name} — target's hand-off input is disabled` };
  }
  return { tone: 'neutral', text: `wakes ${name} (${WAKE_EDGE_LEGEND})` };
}

// Does this outcome hand off to a PERSON (#981)? True when any of its setLabel
// actions sets a brake-flagged label (`labels` = the graph's label registry,
// [{ name, humanGate, brake }]). A brake is the agent pausing the flow for a
// human decision — a consumer by design, so "no consumer" warnings must not
// fire for it. Gate labels don't count: an agent may not set those at all
// (that is a validation error, not a hand-off).
export function outcomeHandsOffToHuman(option, labels) {
  const regs = Array.isArray(labels) ? labels : [];
  const actions = Array.isArray(option?.actions) ? option.actions : [];
  return actions.some(a => a && a.type === 'setLabel' && typeof a.label === 'string'
    && regs.some(l => l && typeof l.name === 'string'
      && l.name.trim() === a.label.trim() && l.brake && !l.humanGate));
}
