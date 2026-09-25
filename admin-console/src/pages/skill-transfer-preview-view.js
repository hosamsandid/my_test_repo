// Pure view helpers for the skill-transfer prompt-injection preview (#2468).
// A skill crosses the only cross-team trust boundary at POST /api/skills/transfer
// (promote / adopt / move). The endpoint runs an advisory two-stage injection
// scan and returns `warnings` (empty when clean); the console shows a preview of
// the target content before committing, and — ONLY when warnings are present —
// requires one extra explicit acknowledgement before the transfer proceeds.
//
// Kept pure (no React, no fetch) so the decision + display shaping is unit-tested
// and the JSX stays a thin renderer, per the #651 colocated-view convention. The
// server re-scans on the real commit and logs the outcome; this is UX only.

// Human label per scan stage — a deterministic pattern hit vs an AI-assisted read.
export const SCAN_STAGE_LABELS = { pattern: 'Pattern scan', llm: 'AI review' };

// Does the preview require the extra explicit confirmation? Only when the scan
// surfaced at least one warning. An empty (or absent) list keeps the common-case
// flow friction-free beyond showing the content (AC3 + the zero-findings edge case).
export function transferPreviewRequiresAck(warnings) {
  return Array.isArray(warnings) && warnings.length > 0;
}

// Shape the raw `warnings` array into stable rows for rendering. Tolerates junk
// entries. Never surfaces more than the scan provided; evidence is already
// clipped server-side.
export function warningRows(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter((w) => w && typeof w === 'object')
    .map((w, i) => ({
      key: `${w.stage || 'x'}:${w.category || 'other'}:${i}`,
      stageLabel: SCAN_STAGE_LABELS[w.stage] || 'Scan',
      category: typeof w.category === 'string' ? w.category : 'other',
      message: typeof w.message === 'string' ? w.message : '',
      evidence: typeof w.evidence === 'string' && w.evidence ? w.evidence : null,
      count: Number.isInteger(w.count) && w.count > 1 ? w.count : null,
    }));
}

// A one-line summary for the dialog header ("2 potential issues found" /
// "No issues found"). Purely cosmetic.
export function warningsSummaryLabel(warnings) {
  const n = Array.isArray(warnings) ? warnings.length : 0;
  if (n === 0) return 'No prompt-injection indicators found';
  return `${n} potential prompt-injection ${n === 1 ? 'indicator' : 'indicators'} found`;
}
