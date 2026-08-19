// Turn an error thrown by `apiCall` (or a raw fetch rejection) into a
// human-readable message for the Materialize-as-team dialog (#1552).
//
// A failed materialization (`POST /api/teams`) used to render whatever the
// error carried — and when the backend returns a gateway/proxy error with no
// JSON body (a 502 while the orchestrator is slow to clone, restarts, or times
// out) `apiCall` falls back to the bare status string, so the user saw exactly
// "HTTP 502": neither descriptive nor actionable.
//
// This pure mapper distinguishes the failure classes the client can actually
// tell apart and returns `{ message, detail }`:
//   • message — the primary, human-readable line shown to the user;
//   • detail  — optional secondary text (the raw status, in parentheses) kept
//               for support/debugging, never the primary message.
//
// `apiCall` stamps `err.status` (the HTTP status, absent on a network failure)
// and `err.serverMessage` (the structured `error`/`message` the backend
// returned, when there was one). Everything here derives from those two.

export function describeMaterializeError(err, opts = {}) {
  const action = opts.action || 'complete the request';
  const status = err && typeof err.status === 'number' ? err.status : null;
  const serverMessage =
    err && typeof err.serverMessage === 'string' && err.serverMessage.trim()
      ? err.serverMessage.trim()
      : null;

  // 1. No status came back at all — the request never reached (or never got a
  //    reply from) the server: offline, DNS failure, connection refused, a
  //    client-side timeout/abort. `apiCall`'s `fetch` rejected before it could
  //    stamp a status.
  if (status == null) {
    return {
      message: `Could not reach the server to ${action}. Check your connection and try again in a moment.`,
      detail: null,
    };
  }

  // 2. The backend returned a structured error body — trust it and show it
  //    verbatim (duplicate teamId, invalid slug, …). No decoration so the
  //    specific message reads exactly as the server wrote it.
  if (serverMessage) {
    return { message: serverMessage, detail: null };
  }

  // 3. Gateway / server error (5xx) with no usable body — the classic bare
  //    "HTTP 502". Say what happened in plain language and what to try next;
  //    keep the raw status as secondary detail.
  if (status >= 500) {
    return {
      message: `The server could not ${action} — it may be busy cloning a repository, restarting, or timing out. Try again in a moment; if it keeps failing, check the working environment's repository and credentials.`,
      detail: `HTTP ${status}`,
    };
  }

  // 4. A 4xx with no JSON body (e.g. a 404/409 without a message) — still
  //    readable rather than a bare code, with the status inline.
  if (status >= 400) {
    return {
      message: `The request to ${action} was rejected by the server (HTTP ${status}).`,
      detail: null,
    };
  }

  // Fallback for any other thrown status — never surface "undefined".
  return { message: `The request to ${action} failed (HTTP ${status}).`, detail: null };
}
