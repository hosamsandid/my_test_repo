import { useEffect, useRef, useState } from 'react';

/**
 * Generic SSE consumer with auto-reconnect (exponential backoff, 1 s start, 15 s cap).
 *
 * The native EventSource handles its own reconnection, but we wrap it so we can:
 *   - report a status to the caller (`connecting | open | reconnecting | closed`)
 *   - cap backoff so a flapping endpoint doesn't hammer the server
 *   - re-open when the URL changes (e.g. switching DM rooms)
 *   - parse JSON in one place; surface parse errors via `onError`
 *
 * Server emits `data: <json>\n\n`. EventSource hands us the raw `data` string;
 * we JSON.parse before calling `onEvent`. Heartbeat lines (`: ping`) are
 * filtered by the spec — they never reach `onmessage`.
 *
 * @param {string|null} url           SSE endpoint. If null/empty or `enabled=false`, no connection is opened.
 * @param {object} options
 * @param {(ev:any)=>void} options.onEvent    Called once per parsed event.
 * @param {()=>void}       [options.onOpen]   Called when the connection (re)opens.
 * @param {(err:any)=>void}[options.onError]  Called on parse/network errors.
 * @param {boolean}        [options.enabled]  Defaults to true.
 *
 * @returns {{ status: 'connecting'|'open'|'reconnecting'|'closed', close: () => void }}
 */
export function useSSE(url, { onEvent, onOpen, onError, enabled = true } = {}) {
  const [status, setStatus] = useState('closed');

  // Stash the latest callbacks in refs so we don't re-open the connection on
  // every render just because the parent passed new function identities.
  const onEventRef = useRef(onEvent);
  const onOpenRef  = useRef(onOpen);
  const onErrorRef = useRef(onError);
  onEventRef.current = onEvent;
  onOpenRef.current  = onOpen;
  onErrorRef.current = onError;

  const esRef       = useRef(null);
  const closedRef   = useRef(false);
  const backoffRef  = useRef(1000);
  const retryTimer  = useRef(null);

  useEffect(() => {
    if (!enabled || !url) {
      setStatus('closed');
      return;
    }

    closedRef.current = false;
    backoffRef.current = 1000;

    function connect() {
      if (closedRef.current) return;
      setStatus(prev => (prev === 'open' ? 'reconnecting' : 'connecting'));
      try {
        const es = new EventSource(url);
        esRef.current = es;

        es.onopen = () => {
          if (closedRef.current) return;
          backoffRef.current = 1000;
          setStatus('open');
          try { onOpenRef.current?.(); } catch { /* ignore handler throw */ }
        };

        es.onmessage = (ev) => {
          if (closedRef.current) return;
          if (!ev.data) return;
          let parsed;
          try {
            parsed = JSON.parse(ev.data);
          } catch (err) {
            try { onErrorRef.current?.(err); } catch { /* ignore handler throw */ }
            return;
          }
          try { onEventRef.current?.(parsed); } catch { /* ignore handler throw */ }
        };

        es.onerror = (err) => {
          if (closedRef.current) return;
          try { onErrorRef.current?.(err); } catch { /* ignore handler throw */ }
          // EventSource will retry on its own, but we close + reopen to drive
          // our own backoff and to make status transitions deterministic.
          try { es.close(); } catch { /* noop */ }
          if (closedRef.current) return;
          setStatus('reconnecting');
          const delay = backoffRef.current;
          backoffRef.current = Math.min(backoffRef.current * 2, 15000);
          retryTimer.current = setTimeout(connect, delay);
        };
      } catch (err) {
        try { onErrorRef.current?.(err); } catch { /* ignore */ }
        if (closedRef.current) return;
        setStatus('reconnecting');
        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, 15000);
        retryTimer.current = setTimeout(connect, delay);
      }
    }

    connect();

    return () => {
      closedRef.current = true;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      if (esRef.current) {
        try { esRef.current.close(); } catch { /* noop */ }
        esRef.current = null;
      }
      setStatus('closed');
    };
  }, [url, enabled]);

  function close() {
    closedRef.current = true;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* noop */ }
      esRef.current = null;
    }
    setStatus('closed');
  }

  return { status, close };
}

export default useSSE;
