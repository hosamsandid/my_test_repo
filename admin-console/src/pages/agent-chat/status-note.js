// Pure helpers for the runner's chat status notes (#2841, #651 convention):
// while `aee-wait-ci` waits, the runner posts one `m.notice` carrying
// `io.aee.status-note` ("Pull request #N is open — waiting for CI…"). It is a
// progress note inside a running turn, never the turn's reply.

export const STATUS_NOTE_FIELD = 'io.aee.status-note';

export function isStatusNote(message) {
  const meta = message?.[STATUS_NOTE_FIELD];
  return !!message && message.msgtype === 'm.notice' && !!meta && typeof meta === 'object';
}

/**
 * The message that decides whether the agent is still working: the last one
 * that is not a status note. A status note posted mid-turn must not read as
 * the agent's answer and hide the thinking indicator.
 */
export function lastTurnMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isStatusNote(messages[i])) return messages[i];
  }
  return undefined;
}

/**
 * Markdown for the chat bubble: the plain-text `#N (url)` other Matrix
 * clients show becomes a `[#N](url)` link. Any other body passes through.
 */
export function statusNoteMarkdown(message) {
  const body = typeof message?.body === 'string' ? message.body : '';
  return body.replace(/#(\d+) \((https:\/\/[^\s()]+\/pull\/\1)\)/, '[#$1]($2)');
}
