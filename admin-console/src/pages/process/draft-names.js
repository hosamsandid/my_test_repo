// Pure naming decisions for Flows drafts (#2662).
//
// Pure and React-free so it unit-tests without a DOM (per the #651 convention).

/** The name the server also falls back to for an unnamed draft. */
export const UNTITLED_FLOW = 'Untitled flow';

/** Shown under the rename field while it is blank. */
export const BLANK_RENAME_HINT = 'Enter a name.';

/** A rename can only be submitted with a non-blank name. The server would fall
 *  back to the default for a blank one, so the dialog refuses it up front
 *  instead of silently ignoring the click. */
export function canSubmitRename(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** The default name for a new draft: "Untitled flow" while no draft is called
 *  that, else the lowest free "Untitled flow N" (N ≥ 2). Two New-flow clicks
 *  would otherwise leave two identical rail rows. Names compare trimmed and
 *  case-insensitively, the way they read in the rail. */
export function nextUntitledName(drafts) {
  const taken = new Set(
    (Array.isArray(drafts) ? drafts : [])
      .map(d => (d && typeof d.name === 'string' ? d.name.trim().toLowerCase() : ''))
      .filter(Boolean),
  );
  if (!taken.has(UNTITLED_FLOW.toLowerCase())) return UNTITLED_FLOW;
  for (let n = 2; ; n += 1) {
    const candidate = `${UNTITLED_FLOW} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
