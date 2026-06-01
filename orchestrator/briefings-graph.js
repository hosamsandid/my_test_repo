'use strict';

// ============================================================
// Briefings-graph transformation (pure)
// ------------------------------------------------------------
// Turns bp-explorer's /api/briefings response (a list of parsed brief.md
// frontmatter objects) into the map shape `bp-event-router.findAffectedBps()`
// expects:
//
//   { <bpHash>: { 'depends-on': [...], artifacts: [...], is_parent, status, ... }, ... }
//
// Key renames:
//   - depends_on (underscore, bp-explorer's JSON-friendly name)
//     → 'depends-on' (hyphen, matching the YAML frontmatter key the
//     router was originally written against)
//
// `is_parent` is inferred from `children.length > 0` when bp-explorer doesn't
// set it explicitly.
//
// Kept pure so the unit test can drive it with synthetic fixtures.
// ============================================================

function bpsToBriefingsMap(bps) {
  const briefings = {};
  if (!Array.isArray(bps)) return briefings;
  for (const bp of bps) {
    if (!bp || typeof bp.id !== 'string' || !bp.id) continue;
    const childrenIsArray = Array.isArray(bp.children);
    briefings[bp.id] = {
      'depends-on': Array.isArray(bp.depends_on) ? bp.depends_on : [],
      artifacts: Array.isArray(bp.artifacts) ? bp.artifacts : [],
      is_parent: bp.is_parent === true || (childrenIsArray && bp.children.length > 0),
      status: typeof bp.status === 'string' ? bp.status : '',
      slug: typeof bp.slug === 'string' ? bp.slug : '',
    };
  }
  return briefings;
}

module.exports = { bpsToBriefingsMap };
