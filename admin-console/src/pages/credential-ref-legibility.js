// #2327 (epic #2325, rule R2 — read-only visibility): decide how to render a
// credential reference (an environment's `githubTokenId`, a repository's
// `sshKeyId`) in its picker, given the options the caller can actually SEE.
//
// A `personal` credential is visible only to its owner (GET /api/{github-tokens,
// ssh-keys} is scope-filtered), so a bound id may have NO matching option in the
// picker. The old <select> then rendered EMPTY, and a plain save cleared the
// reference — the #2326 data loss. This decides when to show a read-only
// "set, but not visible to you" state instead, so the UI is honest and the field
// is never silently blanked. Per the agreed policy, an invisible binding is
// REPLACE-ONLY: the caller may switch to an option they can see, but not clear it
// and not select the invisible one.
//
// Pure (no React, no fetch) so it is unit-tested and shared by the GitHub-token
// and SSH-key pickers. `visibleOptions` is the caller-scoped list the API already
// returned; each option carries at least `{ id }`.
//
// Returns:
//   { mode: 'picker', boundId, visible: true, option }  — normal editable picker
//         (nothing bound → boundId null/option null; or bound to a visible option)
//   { mode: 'readonly-invisible', boundId, visible: false, option: null }
//         — bound to a credential the caller cannot see: render read-only + a
//           replace-only affordance.
export function describeCredentialRef({ boundId, visibleOptions } = {}) {
  const id = boundId || null;
  const options = Array.isArray(visibleOptions) ? visibleOptions : [];
  if (!id) return { mode: 'picker', boundId: null, visible: true, option: null };
  const option = options.find((o) => o && o.id === id) || null;
  if (option) return { mode: 'picker', boundId: id, visible: true, option };
  return { mode: 'readonly-invisible', boundId: id, visible: false, option: null };
}

// True when a save must be prevented from clearing/altering this reference in the
// UI (belt-and-braces with the #2326 server guard): only the read-only-invisible
// state is protected in the picker.
export function isProtectedCredentialRef(ref) {
  return !!ref && ref.mode === 'readonly-invisible';
}
