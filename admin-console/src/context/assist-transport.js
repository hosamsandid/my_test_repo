// Module-level bridge between the React ModelSelectionProvider and the
// non-React transport layer (#1212, concept §4.5). `apiCall()` and the two raw
// copilot streaming `fetch` call sites can't reach React context, so the
// provider pushes the current selection here and the transport reads it — one
// getter, no prop-threading through every caller.

import { selectionHeaderValue } from './assist-model-selection.js';

let currentSelection = null;
let errorHandlers = { onForbidden: null, onNotSelected: null };

// Fed by ModelSelectionProvider whenever the selection changes (or clears).
export function setAssistSelection(sel) {
  currentSelection = (sel && sel.endpointId && sel.modelId) ? sel : null;
}

// The header stanza to spread into a fetch's `headers`. Empty object when
// nothing is selected — non-assist routes ignore the header, so it is free to
// send on every request (§4.5), and absent when there is no selection yet.
export function assistHeaders() {
  const value = selectionHeaderValue(currentSelection);
  return value ? { 'X-Assist-Model': value } : {};
}

// The provider registers its picker-nudge handlers here; returns an unregister
// fn for effect cleanup. Only one provider is mounted, so last registration
// wins.
export function registerAssistErrorHandlers({ onForbidden, onNotSelected } = {}) {
  errorHandlers = { onForbidden: onForbidden || null, onNotSelected: onNotSelected || null };
  return () => { errorHandlers = { onForbidden: null, onNotSelected: null }; };
}

// Drop-in `fetch` for the raw assist call sites that don't go through apiCall
// (the copilot NDJSON streams and the Knowledge/Skills draft fetches). Adds the
// `X-Assist-Model` header and, on a 400/403, peeks at a cloned body for the
// selection error code to nudge the picker — without consuming the response the
// caller still reads.
export async function assistFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), ...assistHeaders() },
  });
  if (!res.ok && (res.status === 400 || res.status === 403)) {
    try {
      const body = await res.clone().json();
      if (body && body.code) notifyAssistError(body.code);
    } catch { /* non-JSON body — nothing to nudge on */ }
  }
  return res;
}

// Called by the transport when an assist route rejects the selection. 403
// `assist-endpoint-not-permitted` → drop the stale selection, refetch options,
// open the picker; 400 `assist-model-not-selected` → open the picker in its
// attention state. Returns true when the code was an assist-selection error so
// callers know the picker was nudged (they still surface the message).
export function notifyAssistError(code) {
  if (code === 'assist-endpoint-not-permitted') { errorHandlers.onForbidden?.(); return true; }
  if (code === 'assist-model-not-selected') { errorHandlers.onNotSelected?.(); return true; }
  return false;
}
