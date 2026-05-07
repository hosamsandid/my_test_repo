'use strict';

// ============================================================
// BP-event router (pure helpers)
// ------------------------------------------------------------
// Given a BP event (e.g. "bp:revised abc123") and a parsed .index.json,
// computes the set of dependent BPs that should be notified:
//
//   1. Direct depends-on dependents — any BP listing the event's BP in
//      its `depends-on` array.
//
//   2. File-artifact dependents — any BP whose `artifacts[]` (with
//      direction=input) references a path that the event's BP declares
//      as a `direction=output` artifact. This catches the case where a
//      downstream BP consumes a file produced by the changed BP, even
//      without an explicit depends-on edge.
//
// The router is deliberately stateless and side-effect free — it only
// reads .index.json and returns a routing plan. The orchestrator then
// decides what to do with the plan (enable agents, fan out triggers).
//
// .index.json schema reminder (built by ACE scripts/build-index.py):
//   { "briefings": { "<bpHash>": { artifacts: [...], "depends-on": [...], ... }, ... } }
// ============================================================

const fs = require('fs');

function loadIndex(indexPath) {
  let raw;
  try {
    raw = fs.readFileSync(indexPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read .index.json at ${indexPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed .index.json at ${indexPath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.briefings) {
    throw new Error(`Unexpected .index.json shape at ${indexPath}`);
  }
  return parsed.briefings;
}

// Return the set of paths declared as outputs by the given BP. Used to
// match against the input-paths of every other BP.
function outputsOf(bpEntry) {
  if (!bpEntry || !Array.isArray(bpEntry.artifacts)) return new Set();
  const out = new Set();
  for (const a of bpEntry.artifacts) {
    if (a && a.direction === 'output' && typeof a.path === 'string' && a.path) {
      out.add(a.path);
    }
  }
  return out;
}

function inputsOf(bpEntry) {
  if (!bpEntry || !Array.isArray(bpEntry.artifacts)) return [];
  return bpEntry.artifacts.filter(
    (a) => a && a.direction === 'input' && typeof a.path === 'string' && a.path
  );
}

// Compute affected BPs for a single source-BP. Returns
//   { dependsOn: [<hash>], inputArtifact: [{ bp: <hash>, paths: [...] }] }
// `dependsOn` and `inputArtifact` are disjoint by construction — a BP that
// already lists the source in its depends-on is reported only via dependsOn.
function findAffectedBps(briefings, sourceBpHash) {
  if (!briefings || typeof briefings !== 'object') {
    return { dependsOn: [], inputArtifact: [] };
  }
  const source = briefings[sourceBpHash];
  if (!source) {
    return { dependsOn: [], inputArtifact: [], unknownSource: true };
  }

  const dependsOn = [];
  const dependsOnSet = new Set();
  const sourceOutputs = outputsOf(source);
  const inputArtifact = [];

  for (const [hash, entry] of Object.entries(briefings)) {
    if (hash === sourceBpHash) continue;
    if (!entry) continue;
    // Skip parent BPs — only leaf BPs are units of work that can react.
    if (entry.is_parent) continue;

    const deps = Array.isArray(entry['depends-on']) ? entry['depends-on'] : [];
    if (deps.includes(sourceBpHash)) {
      dependsOn.push(hash);
      dependsOnSet.add(hash);
      continue;
    }

    if (sourceOutputs.size === 0) continue;
    const matchedPaths = [];
    for (const inp of inputsOf(entry)) {
      if (sourceOutputs.has(inp.path)) matchedPaths.push(inp.path);
    }
    if (matchedPaths.length > 0) {
      inputArtifact.push({ bp: hash, paths: matchedPaths });
    }
  }

  return { dependsOn, inputArtifact };
}

// Given a set of events with BP hashes, merge them into a per-affected-BP
// notification list — so an agent that's downstream of several changed BPs
// receives one consolidated batch instead of N separate triggers.
//
//   events:    [{ type, bp, details? }, ...]
//   resolveAffected: (bpHash) => { dependsOn, inputArtifact, unknownSource }
//
// returns:
//   {
//     perAffectedBp: Map<affectedBpHash, [
//       { reason: 'depends-on' | 'input-artifact', source: bpHash, event: {...}, paths?: [...] }
//     ]>,
//     unknownSources: [bpHash, ...]
//   }
function batchEventsByAffected(events, resolveAffected) {
  const perAffectedBp = new Map();
  const unknownSources = [];

  for (const ev of events) {
    if (!ev || typeof ev.bp !== 'string') continue;
    const result = resolveAffected(ev.bp);
    if (result.unknownSource) {
      unknownSources.push(ev.bp);
      continue;
    }
    for (const dep of result.dependsOn) {
      if (!perAffectedBp.has(dep)) perAffectedBp.set(dep, []);
      perAffectedBp.get(dep).push({
        reason: 'depends-on',
        source: ev.bp,
        event: ev,
      });
    }
    for (const ia of result.inputArtifact) {
      if (!perAffectedBp.has(ia.bp)) perAffectedBp.set(ia.bp, []);
      perAffectedBp.get(ia.bp).push({
        reason: 'input-artifact',
        source: ev.bp,
        event: ev,
        paths: ia.paths,
      });
    }
  }

  return { perAffectedBp, unknownSources };
}

module.exports = {
  loadIndex,
  findAffectedBps,
  batchEventsByAffected,
};
