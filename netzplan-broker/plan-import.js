'use strict';

// ─── Network Plan content migration (plugin #3, epic #1554, Phase 6, #1566) ──
//
// The two things Phase 6 needs, both pure and dependency-free, both built on the
// id-keyed model in plan-doc.js:
//
//   1. `legacyBoardToPlanDoc` — the **positional → id** converter. The board this
//      plugin replaces keys milestone statuses and requirement targets by ARRAY
//      INDEX; the target model keys them by milestone **id** (concept §4). This is
//      the substance of the phase (issue #1566): the conversion must preserve
//      which milestone each status and each requirement target actually referred
//      to — the source's own comments ("index shifted by +1: info gathering added
//      at 0") prove positional bookkeeping has silently drifted before, so the
//      converter is deliberately the ONE place the alignment happens and it fails
//      LOUD on any misalignment (a done-array whose length ≠ its lane's milestone
//      count, a requirement target index out of range) rather than mapping the
//      wrong milestone quietly.
//
//   2. `exportPlanDoc` / `importPlanDoc` — the round-trip pair the board UI drives
//      so migration is a **repeatable operation, not a script anyone keeps**
//      (issue #1566). Both are thin wrappers over `normalizePlanDoc`, which is
//      idempotent, so `importPlanDoc(exportPlanDoc(doc))` deep-equals
//      `exportPlanDoc(doc)` — the concept's "export → import → identical" guarantee
//      lives at the model level, verified in plan-import.test.js.
//
// **No engagement content lives here** (concept §12 non-goal): the plugin ships an
// empty board. The existing plan is converted OFF-repo by whoever owns the streams
// — they feed the source constants (LANE_DATA / ZONE_STYLE / DEFAULTS / ETL_MOCK /
// SP_MOCK …) to `legacyBoardToPlanDoc` once, producing a PlanDoc they import
// through the board UI and keep in their own repo. This module is the tested,
// reusable machinery for that one-off; it carries no specific plan.
//
// The non-swimlane panels (graph / bipartite / blocks) come across as the four §5
// primitives #1564 introduced — a **normalisation** of the old six bespoke
// renderers, not a pixel-identical restoration (concept §5 / §12). That trade is
// by design, acknowledged rather than treated as a defect (issue #1566 AC4).

const { normalizePlanDoc, VERSION } = require('./plan-doc');

class PlanImportError extends Error {}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ── export / import round-trip (the repeatable operation, §12) ────────────────
//
// A board is already one JSON document; export is its canonical (normalized)
// serialization and import is the same normalization on the way back in. Keeping
// both as `normalizePlanDoc` — which preserves finite `createdAt`/`updatedAt` and
// is idempotent — is what makes the round-trip identity hold.

function exportPlanDoc(doc, { now } = {}) {
  return normalizePlanDoc(doc, now == null ? {} : { now });
}

function importPlanDoc(input, { now } = {}) {
  return normalizePlanDoc(input, now == null ? {} : { now });
}

// ── positional → id converter (the substance of the phase, #1566) ─────────────
//
// LegacyBoard — a faithful, engagement-free representation of the source board's
// positional shape. The one-off conversion builds this from the source constants
// and hands it here:
//
//   LegacyBoard {
//     name?, autonomy? (0|1|2),
//     zones:  [ { key, name?, hint?, color?, or?, secondary? } ],   // ZONE_STYLE
//     owners: [ { name, color? } ],                                 // owner colours
//     stepColumns?: [ str ],
//     lanes:  [ {
//       zone,                       // a zones[].key  (positional in the source, a key here)
//       title, sub?, owner?,        // owner is an owners[].name
//       milestones: [ str | { label } ],   // ordered
//       done?: [ bool ]             // DEFAULTS: done[i] ↔ milestones[i]  (positional status)
//     } ],
//     requirements?: [ {
//       label, color?, on?,
//       targets: [ int | null ]     // per-lane, positional by lane: targets[j] = milestone
//                                    // INDEX in lanes[j] (null = this line has no target there)
//     } ],
//     panels?: [ Panel ]            // extra non-swimlane panels already in §5 primitive shape
//   }
//
// The single swimlane the source is (zones + lanes + requirement lines) becomes
// panel `p-1`; any `panels[]` (the stripped graph / bipartite / blocks) follow it.

function labelOf(m) {
  if (isNonEmptyString(m)) return m.trim();
  if (isPlainObject(m) && isNonEmptyString(m.label)) return m.label.trim();
  return '';
}

function legacyBoardToPlanDoc(legacy, { now } = {}) {
  if (!isPlainObject(legacy)) throw new PlanImportError('legacy board must be an object');

  // owners: name → id (colour preserved). Referenced by id from every lane (§4:
  // renaming a person or their colour is one edit).
  const owners = [];
  const ownerIdByName = new Map();
  (Array.isArray(legacy.owners) ? legacy.owners : []).forEach((o, i) => {
    const name = isPlainObject(o) ? String(o.name || '') : String(o || '');
    const id = `o${i + 1}`;
    owners.push({ id, name, color: isPlainObject(o) && o.color ? String(o.color) : undefined });
    if (isNonEmptyString(name)) ownerIdByName.set(name.trim(), id);
  });

  // zones: key → id (OR / secondary / colour preserved).
  const zones = [];
  const zoneIdByKey = new Map();
  (Array.isArray(legacy.zones) ? legacy.zones : []).forEach((z, i) => {
    const zz = isPlainObject(z) ? z : {};
    const id = `z${i + 1}`;
    const key = isNonEmptyString(zz.key) ? zz.key.trim() : (isNonEmptyString(zz.name) ? zz.name.trim() : id);
    zones.push({
      id,
      name: String(zz.name || key),
      hint: zz.hint != null ? String(zz.hint) : '',
      color: zz.color ? String(zz.color) : undefined,
      or: zz.or === true,
      secondary: zz.secondary === true,
    });
    zoneIdByKey.set(key, id);
  });

  const rawLanes = Array.isArray(legacy.lanes) ? legacy.lanes : [];
  const laneCount = rawLanes.length;
  // (laneIndex, milestoneIndex) → milestone id, so the positional requirement
  // targets can be resolved to ids after every lane is built.
  const milestoneIdAt = [];
  const laneIds = [];

  const lanes = rawLanes.map((l, li) => {
    const ll = isPlainObject(l) ? l : {};
    const laneId = `l${li + 1}`;
    laneIds.push(laneId);
    const title = String(ll.title || '');

    // zone: a lane's zone key must resolve — a dangling zone would silently
    // un-zone the lane (and lose its OR behaviour), exactly the kind of quiet
    // positional drift #1566 warns about.
    let zoneId = null;
    if (isNonEmptyString(ll.zone)) {
      const key = ll.zone.trim();
      if (!zoneIdByKey.has(key)) {
        throw new PlanImportError(`lane "${title || laneId}" references unknown zone "${key}"`);
      }
      zoneId = zoneIdByKey.get(key);
    }

    // owner: absent/blank is fine (unowned); a NON-blank owner that isn't in the
    // owner list is loud — a typo would silently drop the colour.
    let ownerId = null;
    if (isNonEmptyString(ll.owner)) {
      const name = ll.owner.trim();
      if (!ownerIdByName.has(name)) {
        throw new PlanImportError(`lane "${title || laneId}" references unknown owner "${name}"`);
      }
      ownerId = ownerIdByName.get(name);
    }

    const rawMs = Array.isArray(ll.milestones) ? ll.milestones : [];
    const done = ll.done;
    if (done != null) {
      if (!Array.isArray(done) || done.length !== rawMs.length) {
        // The off-by-one guard: the source's DEFAULTS were index-arithmetic'd by
        // hand ("shifted by +1"). Here the done array MUST line up 1:1 with the
        // milestone array — refuse anything else instead of misattributing a
        // status to the wrong milestone.
        throw new PlanImportError(
          `lane "${title || laneId}" has ${rawMs.length} milestones but ${Array.isArray(done) ? done.length : 'a non-array'} done-flags — positional status would misalign`,
        );
      }
    }

    const idsForLane = [];
    const milestones = rawMs.map((m, mi) => {
      const id = `${laneId}m${mi + 1}`;
      idsForLane.push(id);
      return { id, label: labelOf(m), order: mi, done: Array.isArray(done) ? done[mi] === true : false };
    });
    milestoneIdAt.push(idsForLane);

    return { id: laneId, zoneId, title, sub: ll.sub != null ? String(ll.sub) : '', ownerId, order: li, milestones };
  });

  // requirements: positional per-lane target index → { laneId: milestoneId }.
  const requirements = (Array.isArray(legacy.requirements) ? legacy.requirements : []).map((r, ri) => {
    const rr = isPlainObject(r) ? r : {};
    const rawTargets = Array.isArray(rr.targets) ? rr.targets : [];
    if (rawTargets.length && rawTargets.length !== laneCount) {
      throw new PlanImportError(
        `requirement "${rr.label || `r${ri + 1}`}" has ${rawTargets.length} targets but the board has ${laneCount} lanes — positional targets would misalign`,
      );
    }
    const targets = {};
    rawTargets.forEach((idx, laneIndex) => {
      if (idx == null) return; // this line has no target in this lane
      const perLane = milestoneIdAt[laneIndex] || [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= perLane.length) {
        throw new PlanImportError(
          `requirement "${rr.label || `r${ri + 1}`}" target for lane "${laneIds[laneIndex] || laneIndex}" is index ${idx}, out of range (0..${perLane.length - 1})`,
        );
      }
      targets[laneIds[laneIndex]] = perLane[idx];
    });
    return {
      id: `r${ri + 1}`,
      label: String(rr.label || ''),
      color: rr.color ? String(rr.color) : undefined,
      on: rr.on !== false,
      targets,
    };
  });

  const swimlane = {
    id: 'p1',
    kind: 'swimlane',
    title: String(legacy.title || ''),
    zones,
    lanes,
    stepColumns: Array.isArray(legacy.stepColumns) ? legacy.stepColumns.map((s) => String(s)) : [],
    requirements,
  };

  // Extra non-swimlane panels (the stripped renderers, mapped to §5 primitives by
  // the one-off) ride along after the swimlane, in board order.
  const extraPanels = Array.isArray(legacy.panels) ? legacy.panels : [];

  const built = {
    version: VERSION,
    name: String(legacy.name || ''),
    settings: { agentAutonomy: legacy.autonomy },
    owners,
    panels: [swimlane, ...extraPanels],
  };
  if (Number.isFinite(legacy.createdAt)) built.createdAt = legacy.createdAt;

  // normalize finalizes ids/orders and enforces referential soundness. Because
  // every id and reference the converter emits is internally consistent, nothing
  // is dropped here — the loud throws above already rejected the misalignments
  // that normalize would otherwise repair silently.
  return normalizePlanDoc(built, now == null ? {} : { now });
}

module.exports = { legacyBoardToPlanDoc, exportPlanDoc, importPlanDoc, PlanImportError };
