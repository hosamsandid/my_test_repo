'use strict';

// One trigger event key per GitHub moment (#2536). Trigger `events` are written
// in the WEBHOOK vocabulary the trigger editor offers (`GITHUB_EVENT_OPTIONS` in
// admin-console/src/pages/agent-chat/trigger-summary.js), but the poller reads
// the Events API, which names some actions differently. A submitted review is
// `pull_request_review.submitted` as a webhook and `pull_request_review.created`
// in the Events API — compared verbatim, a "PR review submitted" trigger never
// fires. Every other editor option uses the same action in both APIs
// (`pull_request.merged` is already the Events-API name).
//
// Each alias maps to the key the trigger editor offers. The poller canonicalises
// the key it builds (`eventKey`), and every matcher compares through
// `listensTo`, so triggers stored with either form keep working with no data
// change, and a trigger that lists both forms still matches — and wakes — once.
const EVENT_KEY_ALIASES = Object.freeze({
  'pull_request_review.created': 'pull_request_review.submitted',
});

function canonicalEventKey(key) {
  if (typeof key !== 'string') return key;
  return Object.prototype.hasOwnProperty.call(EVENT_KEY_ALIASES, key) ? EVENT_KEY_ALIASES[key] : key;
}

// Does a trigger's event list (array or Set, as stored or as the poller's
// subscriber set) contain `key`, in either of its forms?
function listensTo(events, key) {
  if (!key || events == null || typeof events === 'string') return false;
  if (typeof events[Symbol.iterator] !== 'function') return false;
  const want = canonicalEventKey(key);
  for (const e of events) {
    if (canonicalEventKey(e) === want) return true;
  }
  return false;
}

module.exports = { EVENT_KEY_ALIASES, canonicalEventKey, listensTo };
