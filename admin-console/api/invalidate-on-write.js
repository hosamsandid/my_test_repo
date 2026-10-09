'use strict';

/*
 * Express middleware factory: clear a response cache when a matching console
 * write SUCCEEDS (#566 roster cache, #571 knowledge-graph cache). Dependency
 * free; the allowlist and the clear are injected.
 *
 * Decided when the HANDLER responds (`res.end`), not on a socket event: a
 * client that disconnects mid-request emits `close` before the handler's write
 * has landed (clearing then lets a concurrent poll re-cache the old state), and
 * the destroyed socket never emits `finish` once it does. `res.end` runs after
 * the write either way. Decided on the real final status: a refused or failed
 * write (`>= 400`) leaves the cache alone. One decision per request — the
 * wrapper restores the original `res.end` before calling it.
 */

// `predicate(method, originalUrl)` → does this request's success invalidate?
function invalidateOnSuccessfulWrite(predicate, invalidate) {
  return function invalidateOnSuccessfulWriteMiddleware(req, res, next) {
    if (!predicate(req.method, req.originalUrl)) return next();
    const end = res.end;
    res.end = function endAndInvalidate(...args) {
      res.end = end;
      if (res.statusCode < 400) invalidate();
      return end.apply(this, args);
    };
    next();
  };
}

module.exports = { invalidateOnSuccessfulWrite };
