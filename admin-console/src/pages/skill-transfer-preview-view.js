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

// What to tell the operator about the activation half of a committed transfer
// (#2689). Adopt / move into a team pool activates the skill on that Agent Team
// by default (`activate`), best-effort: the server returns one `activation`
// result per Agent Team it tried. An empty list (no Agent Team reads that pool)
// or no 2xx means the copy landed but is NOT active — say so plainly instead of
// leaving the dialog's "activated by default" promise silently broken.
// Returns { ok, text } or null when activation was not requested.
export function transferActivationNotice(data) {
  if (!data || !data.activate || data.to?.tier !== 'team') return null;
  const results = Array.isArray(data.activation) ? data.activation : [];
  const done = results.filter((r) => r && Number.isInteger(r.status) && r.status >= 200 && r.status < 300);
  const name = data.name || 'The skill';
  if (done.length > 0) {
    return { ok: true, text: `'${name}' was copied into team '${data.to.teamId}' and activated on ${done.map((r) => r.squadId).join(', ')}.` };
  }
  return {
    ok: false,
    text: `'${name}' was copied into team '${data.to.teamId}', but it is not active yet — activate it in the team's Skills tab.`,
  };
}
