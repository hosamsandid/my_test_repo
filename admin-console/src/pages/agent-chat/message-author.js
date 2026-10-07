/**
 * Human-message attribution for the Agent Chat transcript (#2065).
 *
 * Until #2065 every non-agent bubble was labelled with the hard-coded string
 * `'YOU'` and right-aligned, because the only thing a message carried was
 * "sender is not the agent". There is exactly one Matrix human identity
 * (`docs/multi-user-concept.md`), so several console users share one sender id
 * and the transcript was unattributable.
 *
 * The fix has two halves, deliberately derived from *different* inputs and kept
 * apart here (D7):
 *
 *   - the **side** answers "is this mine?" and therefore depends on the viewer;
 *   - the **badge** answers "who wrote this?" and therefore never does.
 *
 * The same message shows the same initials to everybody, on opposite sides.
 *
 * The author is stamped server-side onto the message content under
 * `io.aee.author` (see `POST /api/matrix/rooms/:roomId/messages` in
 * `admin-console/api/api.js`) — the browser cannot choose it. Only the stable
 * user id and the login subject are stored; the *name* is resolved at render
 * from the user directory, so a rename is reflected on old messages too (D3).
 *
 * Pure and DOM-free per #651 so it is unit-tested under `node --test`
 * (`admin-console-src` CI job); `Message.jsx` stays a thin renderer.
 */

/** Matrix content key carrying the author stamp. Mirrored in `api/api.js`. */
export const AUTHOR_FIELD = 'io.aee.author';

/** Maximum number of letters in a badge (D2: first letters of the first two words). */
export const MAX_INITIALS = 2;

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalise a raw `io.aee.author` payload into `{ userId, subject }`.
 *
 * Defensive: the value comes off a Matrix event, so anything at all may be
 * there. Returns `null` when nothing usable is present — which is also the
 * shape every pre-#2065 message has, and the one a third-party Matrix client
 * produces.
 *
 * @param {unknown} raw
 * @returns {{userId: string|null, subject: string|null}|null}
 */
export function normalizeAuthor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const userId = trimmedString(raw.userId);
  const subject = trimmedString(raw.subject);
  if (!userId && !subject) return null;
  return { userId: userId || null, subject: subject || null };
}

/**
 * The author stamp for a message the viewer is about to send. Used only on the
 * optimistic stub so the bubble has the same side and the same badge before and
 * after the server confirms it (AC18); the authoritative stamp is the server's.
 *
 * @param {{userId?: string|null, username?: string|null}|null} viewer
 * @returns {{userId: string|null, subject: string|null}|null}
 */
export function authorStampFor(viewer) {
  if (!viewer) return null;
  return normalizeAuthor({ userId: viewer.userId, subject: viewer.username });
}

/**
 * Index a user directory (`GET /api/admin/users`) for name resolution.
 * Built once per transcript, never per row (AC20).
 *
 * @param {Array<{id?: string, subject?: string, displayName?: string}>} users
 * @returns {{byId: Map<string, object>, bySubject: Map<string, object>}}
 */
export function buildAuthorDirectory(users) {
  const byId = new Map();
  const bySubject = new Map();
  if (Array.isArray(users)) {
    for (const u of users) {
      if (!u || typeof u !== 'object') continue;
      const id = trimmedString(u.id);
      const subject = trimmedString(u.subject);
      if (id) byId.set(id, u);
      if (subject) bySubject.set(subject.toLowerCase(), u);
    }
  }
  return { byId, bySubject };
}

/** The empty directory — a stable value so it never breaks `React.memo`. */
export const EMPTY_AUTHOR_DIRECTORY = buildAuthorDirectory([]);

/**
 * Resolve the name to show for an author (D1): the user record's display name,
 * falling back to the login subject when it is empty.
 *
 * A record that no longer exists (deleted author) falls back to the subject
 * stamped on the message itself — truthful, and never a broken name. When
 * neither yields anything the caller gets `''` and renders the neutral icon.
 *
 * @param {{userId: string|null, subject: string|null}|null} author
 * @param {{byId: Map, bySubject: Map}} [directory]
 * @returns {string}
 */
export function resolveAuthorName(author, directory = EMPTY_AUTHOR_DIRECTORY) {
  if (!author) return '';
  const { byId, bySubject } = directory || EMPTY_AUTHOR_DIRECTORY;
  let record = null;
  if (author.userId && byId) record = byId.get(author.userId) || null;
  if (!record && author.subject && bySubject) {
    record = bySubject.get(author.subject.toLowerCase()) || null;
  }
  if (record) {
    const displayName = trimmedString(record.displayName);
    if (displayName) return displayName;
    const subject = trimmedString(record.subject);
    if (subject) return subject;
  }
  return author.subject || '';
}

/**
 * The author name the session log shows on a `message.received` row (#2715).
 *
 * The runner records the Matrix `sender` as `from`, but that is the account
 * that physically posted the message — for a console user without a personal
 * Matrix identity it is the shared admin account, i.e. somebody else's handle.
 * So `from` is never used for display. The name comes from the `author` the
 * runner copied off the message's `io.aee.author` stamp and is resolved exactly
 * like the transcript bubble's (AC3). No stamp — every row recorded before the
 * fix, or a message from a third-party Matrix client — yields `''`, and the
 * caller omits the "from" segment instead of showing a wrong name (AC5, AC6).
 *
 * @param {object} event   a session-log row
 * @param {{byId: Map, bySubject: Map}} [directory]
 * @returns {string}
 */
export function receivedMessageAuthorName(event, directory = EMPTY_AUTHOR_DIRECTORY) {
  if (!event || typeof event !== 'object') return '';
  return resolveAuthorName(normalizeAuthor(event.author), directory);
}

/**
 * The leading user-perceived character of a string: one full code point plus
 * any combining marks that belong to it. `u`-flagged `.` keeps a surrogate pair
 * together, `\p{M}*` keeps a decomposed accent attached — dropping the mark
 * would silently turn `É` into `E`.
 *
 * A regex rather than `Intl.Segmenter` on purpose: one code path, identical in
 * every runtime, so the badge is deterministic (AC7). The known limit is a
 * multi-code-point emoji sequence (flag, ZWJ family), of which only the first
 * component is taken — legible, stable, and never a crash.
 */
const LEADING_CHARACTER = /^.\p{M}*/u;

function firstGrapheme(text) {
  const match = LEADING_CHARACTER.exec(text);
  return match ? match[0] : '';
}

/**
 * The first character of a word, upper-cased.
 *
 * `toUpperCase()` (not `toLocaleUpperCase`) keeps the result locale-independent
 * (AC7). Upper-casing can *expand* a character — German `ß → SS` — so the
 * result is reduced to its own leading character again; going back through
 * `firstGrapheme` rather than a code-point slice is what preserves a decomposed
 * accent, whose second code point must be kept.
 */
function firstLetter(word) {
  const head = firstGrapheme(word);
  if (!head) return '';
  return firstGrapheme(head.toUpperCase()) || head;
}

/**
 * Initials for a name (D2): the first letters of the first **two** words. A
 * one-word name yields a **single** letter — no third letter, no ellipsis.
 *
 * Returns `''` when the name carries nothing renderable, so the caller can fall
 * back to the neutral icon rather than print `?` or `undefined` (AC11).
 *
 * @param {string} name
 * @returns {string}
 */
export function initialsOf(name) {
  const words = trimmedString(name).split(/\s+/).filter(Boolean);
  const letters = [];
  // Count letters, not UTF-16 code units: a single emoji initial is two code
  // units and would otherwise fill the whole badge on its own.
  for (const word of words) {
    if (letters.length >= MAX_INITIALS) break;
    const letter = firstLetter(word);
    if (letter) letters.push(letter);
  }
  return letters.join('');
}

/**
 * Is this message the viewing user's own?
 *
 * Matches on the stable user id when both sides have one, otherwise on the
 * login subject — the env single-admin credential has no user record and so no
 * id, but its own messages must still be recognised as its own (AC13).
 * Two absent ids are never treated as a match.
 *
 * @param {{userId: string|null, subject: string|null}|null} author
 * @param {{userId?: string|null, username?: string|null}|null} viewer
 * @returns {boolean}
 */
export function isOwnAuthor(author, viewer) {
  if (!author || !viewer) return false;
  const viewerId = trimmedString(viewer.userId);
  if (author.userId && viewerId) return author.userId === viewerId;
  const viewerSubject = trimmedString(viewer.username);
  if (author.subject && viewerSubject) {
    return author.subject.toLowerCase() === viewerSubject.toLowerCase();
  }
  return false;
}

/**
 * The complete avatar/alignment decision for one message bubble.
 *
 * @param {object} params
 * @param {object} params.message          the transcript message object
 * @param {string} params.agentUserId      the agent's Matrix user id
 * @param {{userId?: string|null, username?: string|null}|null} [params.viewer]
 * @param {{byId: Map, bySubject: Map}} [params.directory]
 * @returns {{
 *   isAgent: boolean,
 *   own: boolean,
 *   side: 'left'|'right',
 *   badge: {kind: 'bot'|'anonymous'|'initials', initials: string, name: string},
 * }}
 */
/** Class names for the badge's name reveal. Shared by the stylesheet below and
 *  by `Message.jsx`, so the two can never drift apart. */
export const AUTHOR_BADGE_CLASS = 'agent-chat-author';
export const AUTHOR_NAME_CLASS = 'agent-chat-author-name';

/**
 * Stylesheet for the hover/keyboard reveal of the author's full name (AC8).
 *
 * `title=` alone is the chat's convention for revealing truncated text, but no
 * browser shows it on keyboard focus — hence the real element, hidden until
 * `:hover` or `:focus-visible`. It is absolutely positioned out of flow, so
 * revealing it can never move a row or reflow a bubble (AC9).
 *
 * Generated here (pure, unit-tested) and injected once at the document level by
 * `Message.jsx`, mirroring `ensureAgentChatMdCss` / `ensureThinkingDotsCss`.
 *
 * @returns {string}
 */
export function authorBadgeCss() {
  return `
.${AUTHOR_BADGE_CLASS} { position: relative; display: flex; flex-shrink: 0; }
.${AUTHOR_BADGE_CLASS}:focus { outline: none; }
.${AUTHOR_NAME_CLASS} {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 6px;
  border-radius: var(--eb-radius-sm, 4px);
  background: var(--eb-bg-elevated);
  color: var(--eb-text-primary);
  border: 1px solid var(--eb-border-default);
  font-size: var(--eb-text-xs);
  font-weight: var(--eb-font-normal, 400);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
.${AUTHOR_BADGE_CLASS}:hover > .${AUTHOR_NAME_CLASS},
.${AUTHOR_BADGE_CLASS}:focus-visible > .${AUTHOR_NAME_CLASS} {
  opacity: 1;
  visibility: visible;
}
.${AUTHOR_BADGE_CLASS}:focus-visible {
  outline: 2px solid var(--eb-accent-primary);
  outline-offset: 2px;
  border-radius: 50%;
}
`.trim();
}

export function describeMessageAuthor({ message, agentUserId, viewer = null, directory } = {}) {
  const isAgent = !!(message && agentUserId && message.sender === agentUserId);
  if (isAgent) {
    // D4: the agent side is unchanged — left, bot icon, no name, no hover.
    return { isAgent: true, own: false, side: 'left', badge: { kind: 'bot', initials: '', name: '' } };
  }

  const author = normalizeAuthor(message && message[AUTHOR_FIELD]);
  // D8: a message with no recorded author keeps today's right-hand side, so
  // existing transcripts do not visually reshuffle, and gets a neutral icon —
  // it is never attributed to a person.
  if (!author) {
    return { isAgent: false, own: false, side: 'right', badge: { kind: 'anonymous', initials: '', name: '' } };
  }

  const own = isOwnAuthor(author, viewer);
  const name = resolveAuthorName(author, directory);
  const initials = initialsOf(name);
  return {
    isAgent: false,
    own,
    // D7: right = mine, left = any other human. Viewer-dependent by design.
    side: own ? 'right' : 'left',
    badge: initials
      ? { kind: 'initials', initials, name }
      : { kind: 'anonymous', initials: '', name: '' },
  };
}
