/**
 * password-field-view.js — pure helpers for a masked password input that can
 * be temporarily revealed.
 *
 * Typing a login password or pasting a token blind is a well-known usability
 * trap: the field masks every character, so one fat-fingered keystroke gives no
 * feedback until the submit fails. A "show/hide" reveal toggle (the eye icon
 * every user recognises) lets someone confirm what they entered without
 * weakening the default masked state. The console had a bare `type="password"`
 * on the Login screen and on the admin "Set login password" field with no way
 * to reveal — this module single-sources the two decisions the toggle drives so
 * the control reads and behaves identically wherever it is used.
 *
 * Pure and React-free so it unit-tests without a DOM (per the #651 convention);
 * PasswordField.jsx is the thin renderer over it.
 */

/**
 * The `type` the underlying <input> should carry.
 * Revealed → 'text' (plain, readable); masked → 'password'.
 */
export function passwordInputType(reveal) {
  return reveal ? 'text' : 'password';
}

/**
 * The accessible label / tooltip for the toggle button. It names the action the
 * click performs (not the current state): while masked, the button *shows* the
 * password; while revealed, it *hides* it.
 */
export function revealToggleLabel(reveal) {
  return reveal ? 'Hide password' : 'Show password';
}
