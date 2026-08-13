/**
 * submit-hint.js — Pure helper (React-free, #651) for explaining WHY a form's
 * primary submit button is disabled.
 *
 * A greyed-out "Create" button with no explanation is a classic "the app is
 * not self-explanatory" complaint: a first-time user fills in some fields, the
 * button stays disabled, and nothing tells them which required field is still
 * missing. Feed the form's required fields (each with a `filled` flag derived
 * from the same predicate that gates submission) to `missingFieldsHint()` and
 * use the returned sentence as the button's `title` tooltip — native `title`
 * tooltips are shown even on disabled buttons.
 */

/**
 * Join a list of labels into readable English: "A", "A and B", "A, B and C".
 * @param {string[]} items
 * @returns {string}
 */
export function joinList(items) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * Build the disabled-submit reason sentence from a form's required fields.
 *
 * @param {Array<{label: string, filled: boolean}>} fields — required fields in
 *        the order they appear in the form; `filled` is truthy once the field
 *        has an acceptable value.
 * @returns {string} '' when every field is filled (button should be enabled,
 *        so no reason tooltip is needed), otherwise e.g.
 *        "Fill in Display Name and System Prompt to continue."
 */
export function missingFieldsHint(fields) {
  const missing = (fields || [])
    .filter((f) => f && !f.filled)
    .map((f) => f.label)
    .filter(Boolean);
  if (missing.length === 0) return '';
  return `Fill in ${joinList(missing)} to continue.`;
}
