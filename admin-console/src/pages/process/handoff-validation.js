// Save-time checks for the Flow editor's hand-off / trigger dialogs (#2665):
// the label name a hand-off listens on, and the wake instruction it is woken
// with. Pure (React-free) so it can be unit-tested with `node --test`.

// Mirror of READY_LABEL_RE in admin-console/api/api.js (the Flow Control label
// rule): 1–50 chars, no whitespace, quotes, backticks, braces or angle brackets.
// src cannot import the CJS api module, so the literal is duplicated here and
// api/handoff-label-parity.test.js pins it to the api regex.
export const HANDOFF_LABEL_RE = /^[^\s`"'{}<>][^\s`"'{}<>]{0,49}$/;

// Why a label name can't be saved, or null when it can. A comma gets its own
// message: `gh issue edit --add-label "a, b"` splits it into two labels, so a
// hand-off on it could never fire.
export function labelNameError(name) {
  const v = typeof name === 'string' ? name.trim() : '';
  if (!v) return 'Enter the label name.';
  if (v.includes(',')) {
    return 'Label names can\'t contain commas — GitHub tools split "a, b" into two labels, so this hand-off would never fire.';
  }
  if (!HANDOFF_LABEL_RE.test(v)) {
    return 'Label names can\'t contain spaces, quotes, backticks, braces or angle brackets, and are at most 50 characters.';
  }
  return null;
}

// The placeholders the dialogs' default wake instructions carry until the
// operator fills them in: `<Describe what X should do.>` and the `<repo>` /
// `<label>` / `<event>` stand-ins for values that were not known yet.
const PROMPT_PLACEHOLDER_RE = /<(?:Describe what [^<>\n]*should do\.|repo|label|event)>/;

// Why a wake instruction can't be saved, or null when it can. An empty prompt
// is left to the caller (the edit dialog deliberately allows saving one).
export function promptPlaceholderError(prompt) {
  const m = typeof prompt === 'string' ? prompt.match(PROMPT_PLACEHOLDER_RE) : null;
  if (!m) return null;
  return `Replace ${m[0]} in the wake instruction — the agent would be woken with the placeholder as its instruction.`;
}
