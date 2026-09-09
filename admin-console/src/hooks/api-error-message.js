// A raw JavaScript engine error must never be shown to an operator as if it
// were an explanation (#2135 AC9).
//
// The orchestrator's catch-all turns any uncaught throw into
// `500 {"error": err.message}`, and `proxyAdmin` forwards status and body
// verbatim, so a `ReferenceError` reached the New-user dialog as the bare
// sentence "orchestrator is not defined" — which tells the operator nothing
// they can act on and, worse, reads like a statement about *their* input.
//
// The rule is deliberately narrow, because widening it would be worse than the
// bug: a 5xx whose message is a *human* sentence ("Team 'x' still owns 3
// agents") is exactly what the operator needs, and blanketing every 500 with a
// generic string would hide the domain errors this console relies on. So we
// only rewrite a 5xx whose message has the shape of an engine error, and the
// technical string is kept — on the Error object as `technicalMessage`, and in
// the browser console — so a report still carries it.

// The shapes V8 produces for the mistakes that reach a handler: a scoping bug,
// a missing method, a property read through undefined/null, a bad JSON body.
// Matched anchored at the end so a human sentence that happens to contain one
// of these words is not caught by it.
const ENGINE_ERROR_PATTERNS = [
  /^[\w$.[\]'"]+ is not defined$/,
  /^[\w$.[\]'"()]+ is not a function$/,
  /^[\w$.[\]'"()]+ is not iterable$/,
  // V8 changed this wording, and both forms are still in the wild depending on
  // the Node the orchestrator runs — so both are listed rather than one loose
  // pattern that would also swallow a human sentence.
  /^Cannot (?:read|set) properties of (?:undefined|null) \((?:reading|setting) '[^']*'\)$/,
  /^Cannot (?:read|set) property '[^']*' of (?:undefined|null)$/,
  /^Cannot access '[^']*' before initialization$/,
  /^Assignment to constant variable\.$/,
  /^(?:Unexpected|Invalid) token .*/,
  /^[\w$.[\]'"()]+ is not a constructor$/,
];

// Is this message a raw engine error rather than something written for a human?
export function isEngineErrorMessage(message) {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (!text) return false;
  return ENGINE_ERROR_PATTERNS.some((re) => re.test(text));
}

// What the operator should be told instead. Names the class of problem and
// where the detail is, rather than pretending nothing happened.
export const GENERIC_SERVER_ERROR =
  'The server hit an unexpected internal error. The action may or may not have '
  + 'been applied — reload the page to check, and report this if it persists.';

// Decide the message an api error carries. Returns the message to show plus the
// technical string to keep, so the caller does not have to re-derive either.
//
// A 4xx is never rewritten: those messages are the domain's own refusals, and
// the store's 409s in particular ARE the instruction (see the D4 hand-over).
export function apiErrorMessage(status, serverMessage) {
  const isServerFault = typeof status === 'number' && status >= 500;
  if (isServerFault && isEngineErrorMessage(serverMessage)) {
    return { message: GENERIC_SERVER_ERROR, technicalMessage: serverMessage };
  }
  return { message: serverMessage || `HTTP ${status}`, technicalMessage: null };
}
