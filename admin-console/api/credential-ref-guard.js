'use strict';

// R1 of the credentials-legibility epic (#2325), the data-loss fix in #2326.
//
// A shared resource (a Working Environment) references a credential by id — its
// `githubTokenId`, a repository's `sshKeyId`. The edit form only offers the
// credentials the caller can SEE (GET /api/github-tokens / /api/ssh-keys are
// scope-filtered by `visibleCredential`), and a `personal` credential is visible
// ONLY to its owner (no `scope.all` bypass). So when a Team Admin binds their
// personal token and another admin later opens the same environment, that admin's
// token picker renders EMPTY — and a plain save then submits an empty field,
// nulling the reference. The GitHub automation dies and it is almost impossible
// to work out why. That is the exact incident #2326 was filed for.
//
// This is the pure decision that stops it: a credential reference the caller
// cannot see is NEVER blind-overwritten. It may only be REPLACED by a credential
// the caller can actually see — never blanked, never swapped to another one the
// caller also cannot see. A reference the caller CAN see (or an empty one) is
// unprotected and follows the normal validation. Visibility is resolved by the
// caller (via `visibleCredential`) and passed in, so this stays dependency-free.
//
// Returns { ok: true } to allow the change, or
// { ok: false, status, code, error } to reject it.
function guardCredentialRefChange({ prev, next, prevVisible, nextVisible, kind = 'credential' } = {}) {
  const p = prev || null;
  const n = next || null;
  if (p === n) return { ok: true };            // no change at all
  if (!p || prevVisible) return { ok: true };  // nothing bound, or the caller can see what is bound

  // A credential IS bound and the caller CANNOT see it → it is protected.
  if (!n) {
    return {
      ok: false,
      status: 409,
      code: 'protected_credential_clear',
      error: `This environment has a ${kind} set that is not visible to you. `
        + `You cannot clear it — only replace it with a ${kind} available to you.`,
    };
  }
  if (!nextVisible) {
    return {
      ok: false,
      status: 409,
      code: 'protected_credential_swap',
      error: `This environment has a ${kind} set that is not visible to you. `
        + `You cannot replace it with another ${kind} you cannot see.`,
    };
  }
  return { ok: true }; // a deliberate replace with a credential the caller can see
}

module.exports = { guardCredentialRefChange };
