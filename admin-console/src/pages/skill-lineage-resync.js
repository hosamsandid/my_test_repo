// Skill-lineage resync planning (Lineage tab, Skills Registry).
//
// The Lineage tab lists every known COPY of a skill across tiers with its drift
// state (#632/#629). This pure module turns that copy list into the per-copy
// actions the tab offers and the bulk "update all" fan-out — kept fs/DOM-free so
// it unit-tests with `node --test` and no install step (the #651 pure-view
// convention; the JSX stays uncovered).
//
// Two action classes, mirroring the drift-gated backend (orchestrator.resyncSkill):
//   'update'    an `outdated` copy — the source moved on while the copy stayed
//               put, so re-copying loses nothing. Safe, no confirmation.
//   'overwrite' a `diverged`/`conflict`/`unknown` copy — it carries local edits
//               (or an unprovable anchor) the backend refuses to auto-clobber.
//               The operator may still force it (force:true), DISCARDING those
//               local edits — a destructive act, so the UI confirms first.
// `orphaned` (source deleted — nothing to push) and `in-sync`/no-drift copies get
// no action.

// The action a single copy's drift state affords:
//   'update'     safe resync (outdated)
//   'overwrite'  force-only, destructive (diverged/conflict/unknown)
//   'blocked'    surfaced but not resyncable (orphaned — source gone)
//   null         nothing to do (in-sync / hand-authored / no drift)
export function copyResyncKind(drift) {
  switch (drift) {
    case 'outdated': return 'update';
    case 'diverged':
    case 'conflict':
    case 'unknown': return 'overwrite';
    case 'orphaned': return 'blocked';
    default: return null; // in-sync, null, or an unrecognised state
  }
}

// Reduce a lineage `copies` array into the actionable AGENT copies, grouped by
// action. Only the agent tier is resyncable — the global/team rows are sources,
// not copies to push into. Returns agentId lists so a caller can fan the
// per-agent resync out over exactly the copies it displayed (each call re-checks
// visibility server-side), which also handles a global skill whose copies span
// many teams — there is no single teamId to hand the bulk route.
export function planLineageResync(copies) {
  const list = Array.isArray(copies) ? copies : [];
  const updatable = [];
  const overwritable = [];
  const blocked = [];
  for (const c of list) {
    if (!c || c.tier !== 'agent' || typeof c.agentId !== 'string' || !c.agentId) continue;
    const kind = copyResyncKind(c.drift);
    if (kind === 'update') updatable.push(c.agentId);
    else if (kind === 'overwrite') overwritable.push(c.agentId);
    else if (kind === 'blocked') blocked.push(c.agentId);
  }
  return { updatable, overwritable, blocked };
}

// Fold a set of per-agent resync responses (each the orchestrator's
// { resynced, overwritten, refused, ... } tally, plus a client-side { error })
// into one summary the UI reports after a bulk (or single) fan-out.
export function summarizeResyncResults(results) {
  const list = Array.isArray(results) ? results : [];
  let updated = 0, overwritten = 0, refused = 0, failed = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.error) { failed += 1; continue; }
    updated += Number(r.resynced) || 0;
    overwritten += Number(r.overwritten) || 0;
    refused += Number(r.refused) || 0;
  }
  const parts = [];
  if (updated) parts.push(`${updated} updated`);
  if (overwritten) parts.push(`${overwritten} overwritten`);
  if (refused) parts.push(`${refused} need manual resolution`);
  if (failed) parts.push(`${failed} failed`);
  return {
    updated, overwritten, refused, failed,
    ok: failed === 0 && refused === 0,
    text: parts.length ? parts.join(' · ') : 'already up to date',
  };
}
