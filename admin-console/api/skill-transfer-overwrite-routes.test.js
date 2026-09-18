'use strict';

// #2315 — publishing/promoting a skill onto a destination that ALREADY carries
// its own version history must CONTINUE that history (prev+1) and snapshot the
// pre-overwrite state, not reset the destination to v1 and silently discard it.
//
// The pure decision is proven in skill-transfer.test.js (planTransferStamp) and
// the chain-continuation mechanism in skill-manifest.test.js. What those unit
// tests cannot see is whether POST /api/skills/transfer + the shared write core
// actually WIRE that behaviour up: api.js boots two listeners on require and
// cannot be exercised directly (#651), so — the draft-routes-access.test.js /
// skill-plugin-team-admin-routes.test.js technique — its source is read and the
// specific gate sliced out. This is the regression that was invisible: the
// endpoint returned the right content to everyone while quietly clobbering the
// destination's version chain on every overwrite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** The comments here quote the very ACs under test, so strip them first. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice one route's body out, so a match elsewhere in the multi-thousand-line
 *  file cannot stand in for the gate that is actually missing. */
function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

/** Slice one named function's body out (commitSkillWrite is the shared write
 *  core the endpoint delegates the stamp to). */
function fn(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `function ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of function ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

/* ─── POST /api/skills/transfer — overwrite-continuation + snapshot ──────── */

test('transfer route: consults the shared planTransferStamp decision on the destination', () => {
  const src = route("app.post('/api/skills/transfer',");
  assert.match(src, /skillManifest\.readManifest\(dst\.dir\)/,
    'must read the destination manifest BEFORE the overwrite so its chain can be continued');
  assert.match(src, /skillTransfer\.planTransferStamp\(/,
    'must route the overwrite/fresh decision through the pure planner, not an inline ad-hoc check');
  assert.match(src, /destManifestReadable/,
    'must pass the destination-manifest-readable fact (corrupt → fresh v1 fallback)');
});

test('transfer route: snapshots the destination via the SAME archive mechanism guarded deletion uses', () => {
  const src = route("app.post('/api/skills/transfer',");
  // Guarded deletion archives via archiveDeletedSkill (archive-meta.json sidecar),
  // NOT the meta-less move-side archiveSkillDir — the ticket asks for the former
  // so the snapshot is listed/restorable exactly like an archived deletion.
  assert.match(src, /if\s*\(\s*stampPlan\.archive\s*\)/,
    'the snapshot must be gated by the planner decision, not written unconditionally');
  assert.match(src, /archiveDeletedSkill\(\s*dst\.dir\s*,\s*plan\.to\s*,\s*destName/,
    'must snapshot the DESTINATION dir (dst.dir), tiered by the destination ref (plan.to)');
});

test('transfer route: hands the preserved chain to the write core only when continuing', () => {
  const src = route("app.post('/api/skills/transfer',");
  assert.match(src, /const continueFrom = stampPlan\.continueChain \? destManifest : null;/,
    'continueFrom is the preserved destination manifest ONLY when the planner says to continue');
  assert.match(src, /continueFrom: continueFrom \|\| undefined/,
    'must pass continueFrom into commitSkillWrite so the write core continues the chain');
});

/* ─── commitSkillWrite — the shared stamp core ───────────────────────────── */

test('commitSkillWrite: a continueFrom copy re-seeds the destination chain + chain-stamps, never a bare v1 reset', () => {
  const src = fn('function commitSkillWrite(');
  assert.match(src, /stamp\.continueFrom && typeof stamp\.continueFrom === 'object'/,
    'must branch on a supplied continueFrom manifest');
  assert.match(src, /skillManifest\.writeManifest\(destDir, stamp\.continueFrom\)/,
    'must re-seed the preserved destination manifest over the source-dragged one');
  assert.match(src, /stampSkill\(destDir, \{ \.\.\.s, forceHistory: true \}\)/,
    'must chain-stamp (forceHistory) so the transfer action is always recorded on the continued chain');
  // The fresh-landing path (and the re-seed failure fallback) still stamp a v1 copy.
  assert.match(src, /stampSkillCopy\(destDir, s\)/,
    'a fresh landing must still start a fresh v1 chain via stampSkillCopy');
});
