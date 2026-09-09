import { useState, useEffect, useCallback, useRef } from 'react';
import { UNAUTHORIZED_EVENT } from '../auth/AuthContext';
import { assistHeaders, notifyAssistError } from '../context/assist-transport.js';
import { apiErrorMessage } from './api-error-message.js';

// A 401 means the session expired or was cleared — notify the AuthProvider so
// the console drops back to the login screen instead of showing broken pages.
function notifyIfUnauthorized(status) {
  if (status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export function useApi(url) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Track whether data was ever successfully loaded for this URL.
  // On refetch we skip the loading=true flip so mounted components (e.g.
  // OrchestratorCard) are not unmounted and don't lose their local state.
  const hasData = useRef(false);

  const fetchData = useCallback(async () => {
    // A falsy URL means "nothing to fetch" — callers use this to skip a request
    // for scopes whose data is derived client-side (e.g. drafts/imports).
    if (!url) { setData(null); setError(null); setLoading(false); return; }
    if (!hasData.current) setLoading(true);
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        notifyIfUnauthorized(res.status);
        throw new Error(`HTTP ${res.status}`);
      }
      hasData.current = true;
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    hasData.current = false;
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export async function apiCall(method, url, body) {
  // Assist model selection (#1212): attach `X-Assist-Model: <endpointId>:<modelId>`
  // when a selection is set. Non-assist routes ignore it, so it is free to send
  // on every request and any future assist route inherits it for free.
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...assistHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    notifyIfUnauthorized(res.status);
    const err = await res.json().catch(() => ({}));
    // 400 assist-model-not-selected / 403 assist-endpoint-not-permitted nudge
    // the header picker open (and clear+refetch on 403) — see assist-transport.
    if (err && err.code) notifyAssistError(err.code);
    // A structured body carries a human message under `error` (or `message`);
    // when the body is missing or non-JSON we fall back to the bare status.
    // `serverMessage` records whether the message came from the server so
    // callers can tell a real error apart from the "HTTP <status>" fallback
    // (see describeMaterializeError, #1552) — existing callers read `.message`
    // and `.status` exactly as before.
    const serverMessage = err && typeof (err.error || err.message) === 'string'
      ? (err.error || err.message)
      : null;
    // A 5xx whose message is a raw JavaScript engine error ("x is not defined")
    // is a bug report, not an explanation, and must not be rendered verbatim in
    // a dialog (#2135 AC9). Only that narrow shape is rewritten — a 5xx with a
    // human sentence, and every 4xx, still says exactly what the server said.
    // `serverMessage` keeps the raw string either way, so `describeMaterializeError`
    // (#1552) and any other consumer of it are unaffected.
    const { message, technicalMessage } = apiErrorMessage(res.status, serverMessage);
    const e = new Error(message);
    e.status = res.status;
    if (serverMessage) e.serverMessage = serverMessage;
    if (technicalMessage) {
      e.technicalMessage = technicalMessage;
      // Keep the detail reachable: the operator no longer sees it, so it has to
      // land somewhere a bug report can quote it from.
      console.error(`[api] ${method} ${url} → ${res.status}: ${technicalMessage}`);
    }
    if (err && err.code) e.code = err.code;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}
