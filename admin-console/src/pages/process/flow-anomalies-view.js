// Pure view helpers for the Flow-anomalies panel (#959). Dependency-free so it
// unit-tests under `node --test` (the JSX panel cannot be imported there).
//
// The detector (`orchestrator/flow-anomaly-detector.js`) returns anomalies as
// `{ class, severity, label, object:{kind,number,url,title,state}, agentId,
// consumers, since, ageMs, message, evidence }`. This module maps that to
// render-ready view data: per-class presentation, node badge counts, and a
// short age label.

// Per-class presentation. Colors use the design-token CSS vars so light/dark
// parity comes free. `warning` classes use the warning token; the gate nudge is
// informational.
const ANOMALY_CLASSES = {
  'wake-not-claimed': {
    title: 'Wake not claimed',
    blurb: 'A wake label has waited past its threshold with no claim and no run — the wake may have been lost, or the run crashed before claiming.',
    severity: 'warning',
  },
  'claim-stalled': {
    title: 'Claim stalled',
    blurb: 'A claimed item shows no branch/PR/commit activity and no running session — the run likely died silently.',
    severity: 'warning',
  },
  'output-missing': {
    title: 'Output missing',
    blurb: 'A consumer ran but its declared outgoing label or PR never appeared — the chain dead-ended.',
    severity: 'warning',
  },
  'gate-idle': {
    title: 'Gate idle',
    blurb: 'A human gate has been pending past its threshold — a nudge, never an auto-approval.',
    severity: 'info',
  },
};

function classInfo(cls) {
  return ANOMALY_CLASSES[cls] || { title: cls, blurb: '', severity: 'info' };
}

// CSS var for a severity dot/border — matches the process-graph lint palette.
function severityColor(severity) {
  return severity === 'warning'
    ? 'var(--eb-status-warning, #d97706)'
    : 'var(--eb-text-secondary, #6b7280)';
}

// Short, human age from milliseconds (mirrors the detector's `humanizeAge`).
function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// A one-line render view of a single anomaly.
function anomalyView(a) {
  const info = classInfo(a.class);
  const obj = a.object || {};
  return {
    class: a.class,
    title: info.title,
    severity: a.severity || info.severity,
    color: severityColor(a.severity || info.severity),
    message: a.message || info.blurb,
    // The generic one-sentence explanation of this anomaly *class*, always
    // present so the row can show it as a subtitle even when the detector
    // supplied its own instance-specific `message` (#1123).
    blurb: info.blurb,
    label: a.label || null,
    objectRef: obj.number != null ? `${obj.kind === 'pr' ? 'PR' : 'issue'} #${obj.number}` : null,
    objectUrl: obj.url || null,
    objectTitle: obj.title || null,
    agentId: a.agentId || null,
    age: formatAge(a.ageMs),
    evidence: Array.isArray(a.evidence) ? a.evidence : [],
  };
}

// Count anomalies per node id (agentId) for the on-canvas badge. Anomalies with
// no responsible agent (gate-idle) are not attributed to a node. `roleOf`
// (#2814) maps an auto-scaled pool instance id to its role's id — instances
// are not canvas nodes, so their anomalies count on the role's node.
function anomalyCountByNode(anomalies, roleOf = {}) {
  const out = {};
  for (const a of Array.isArray(anomalies) ? anomalies : []) {
    if (!a || !a.agentId) continue;
    const id = (roleOf && roleOf[a.agentId]) || a.agentId;
    out[id] = (out[id] || 0) + 1;
  }
  return out;
}

// Aggregate counts by class + total, for the panel header/summary.
function summarize(anomalies) {
  const byClass = {};
  let total = 0;
  for (const a of Array.isArray(anomalies) ? anomalies : []) {
    if (!a || !a.class) continue;
    byClass[a.class] = (byClass[a.class] || 0) + 1;
    total += 1;
  }
  return { total, byClass };
}

export {
  ANOMALY_CLASSES,
  classInfo,
  severityColor,
  formatAge,
  anomalyView,
  anomalyCountByNode,
  summarize,
};
