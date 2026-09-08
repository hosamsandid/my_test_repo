import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHOR_FIELD,
  MAX_INITIALS,
  normalizeAuthor,
  authorStampFor,
  buildAuthorDirectory,
  EMPTY_AUTHOR_DIRECTORY,
  resolveAuthorName,
  initialsOf,
  isOwnAuthor,
  describeMessageAuthor,
  authorBadgeCss,
  AUTHOR_BADGE_CLASS,
  AUTHOR_NAME_CLASS,
} from './message-author.js';

const AGENT = '@agent-x:local';

/* ── the content key and the two-letter rule ─────────────────────────────── */

test('the author stamp travels under the documented io.aee key', () => {
  assert.equal(AUTHOR_FIELD, 'io.aee.author');
  assert.equal(MAX_INITIALS, 2);
});

/* ── normalizeAuthor: defensive against arbitrary event content ──────────── */

test('normalizeAuthor keeps a well-formed stamp', () => {
  assert.deepEqual(normalizeAuthor({ userId: 'u1', subject: 'anna' }), { userId: 'u1', subject: 'anna' });
});

test('normalizeAuthor trims and drops the halves that carry nothing', () => {
  assert.deepEqual(normalizeAuthor({ userId: '  u1 ', subject: '   ' }), { userId: 'u1', subject: null });
  assert.deepEqual(normalizeAuthor({ subject: ' anna ' }), { userId: null, subject: 'anna' });
});

test('normalizeAuthor returns null for every un-attributed shape', () => {
  // pre-#2065 history, a third-party Matrix client, and junk content
  for (const raw of [undefined, null, '', 0, false, [], ['u1'], {}, { userId: '' }, { userId: 5 }, { subject: {} }]) {
    assert.equal(normalizeAuthor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('authorStampFor mirrors the viewer identity onto an optimistic send', () => {
  assert.deepEqual(authorStampFor({ userId: 'u1', username: 'anna' }), { userId: 'u1', subject: 'anna' });
  // The env single-admin has no user record — the subject alone still attributes it.
  assert.deepEqual(authorStampFor({ userId: null, username: 'admin' }), { userId: null, subject: 'admin' });
  assert.equal(authorStampFor(null), null);
  assert.equal(authorStampFor({}), null);
});

/* ── initialsOf: D2 ──────────────────────────────────────────────────────── */

test('initialsOf takes the first letters of the first two words', () => {
  assert.equal(initialsOf('Anna Schmidt'), 'AS');
  assert.equal(initialsOf('anna schmidt'), 'AS');
});

test('a one-word name yields exactly one letter — no third letter, no ellipsis', () => {
  assert.equal(initialsOf('Anna'), 'A');
  assert.equal(initialsOf('averyverylongnamewithoutanyspaces'), 'A');
});

test('a third and later word is ignored', () => {
  assert.equal(initialsOf('Anna Maria Schmidt'), 'AM');
  assert.equal(initialsOf('a b c d e'), 'AB');
});

test('leading, trailing and repeated whitespace do not produce empty initials', () => {
  assert.equal(initialsOf('   Anna    Schmidt  '), 'AS');
  assert.equal(initialsOf('\tAnna\nSchmidt'), 'AS');
});

test('a single character name is a single letter', () => {
  assert.equal(initialsOf('x'), 'X');
});

test('diacritics and umlauts keep their mark, composed or decomposed', () => {
  assert.equal(initialsOf('Ödön Ürményi'), 'ÖÜ');
  // NFD: "E" + combining acute — must not lose the accent nor split into two letters
  assert.equal(initialsOf('Élodie Durand'), 'ÉD'.normalize('NFD'));
});

test("German ß does not expand the badge to two letters", () => {
  assert.equal(initialsOf('ßeta'), 'S');
  assert.equal(initialsOf('ßeta ßeta').length, 2);
});

test('non-Latin scripts yield their own leading characters', () => {
  assert.equal(initialsOf('Иван Петров'), 'ИП');
  assert.equal(initialsOf('田中 太郎'), '田太');
  // CJK has no case distinction — uppercasing must be a no-op, not a loss
  assert.equal(initialsOf('田中'), '田');
});

test('an emoji or punctuation leading character does not crash or split', () => {
  assert.equal(initialsOf('🙂 Smith'), '🙂S');
  assert.equal(initialsOf('.hidden name'), '.N');
});

test('initialsOf returns the empty string when nothing is renderable', () => {
  for (const name of ['', '   ', undefined, null, 42, {}]) {
    assert.equal(initialsOf(name), '', `expected '' for ${JSON.stringify(name)}`);
  }
});

test('initialsOf is deterministic — the same name always yields the same letters', () => {
  const runs = new Set();
  for (let i = 0; i < 5; i++) runs.add(initialsOf('Anna Schmidt'));
  assert.equal(runs.size, 1);
});

/* ── name resolution: D1 / D3 ────────────────────────────────────────────── */

const DIRECTORY = buildAuthorDirectory([
  { id: 'u1', subject: 'anna', displayName: 'Anna Schmidt' },
  { id: 'u2', subject: 'Andreas', displayName: '' },
  { id: 'u3', subject: 'nils', displayName: '   ' },
  null,
  'nonsense',
]);

test('buildAuthorDirectory indexes by id and by lower-cased subject, skipping junk', () => {
  assert.equal(DIRECTORY.byId.get('u1').displayName, 'Anna Schmidt');
  assert.equal(DIRECTORY.bySubject.get('andreas').id, 'u2');
  assert.equal(DIRECTORY.byId.size, 3);
  assert.equal(EMPTY_AUTHOR_DIRECTORY.byId.size, 0);
});

test('the display name wins (D1)', () => {
  assert.equal(resolveAuthorName({ userId: 'u1', subject: 'anna' }, DIRECTORY), 'Anna Schmidt');
});

test('an empty or blank display name falls back to the login subject (D1)', () => {
  assert.equal(resolveAuthorName({ userId: 'u2', subject: 'Andreas' }, DIRECTORY), 'Andreas');
  assert.equal(resolveAuthorName({ userId: 'u3', subject: 'nils' }, DIRECTORY), 'nils');
});

test('the record is found by subject when the stamp carries no user id', () => {
  assert.equal(resolveAuthorName({ userId: null, subject: 'ANNA' }, DIRECTORY), 'Anna Schmidt');
});

test('a rename is picked up by messages that already exist (D3)', () => {
  const stamp = { userId: 'u1', subject: 'anna' };
  const renamed = buildAuthorDirectory([{ id: 'u1', subject: 'anna', displayName: 'Anna Meier' }]);
  assert.equal(resolveAuthorName(stamp, DIRECTORY), 'Anna Schmidt');
  assert.equal(resolveAuthorName(stamp, renamed), 'Anna Meier');
});

test('a deleted author falls back to the subject stamped on the message, never a broken name', () => {
  assert.equal(resolveAuthorName({ userId: 'gone', subject: 'anna.old' }, DIRECTORY), 'anna.old');
  assert.equal(resolveAuthorName({ userId: 'gone', subject: null }, DIRECTORY), '');
  assert.equal(resolveAuthorName(null, DIRECTORY), '');
  // A missing directory must not throw — the fetch may still be in flight.
  assert.equal(resolveAuthorName({ userId: 'u1', subject: 'anna' }), 'anna');
  assert.equal(resolveAuthorName({ userId: 'u1', subject: 'anna' }, null), 'anna');
});

/* ── own-message detection: AC13 ─────────────────────────────────────────── */

test('the stable user id identifies the viewer when both sides have one', () => {
  assert.equal(isOwnAuthor({ userId: 'u1', subject: 'anna' }, { userId: 'u1', username: 'anna' }), true);
  assert.equal(isOwnAuthor({ userId: 'u2', subject: 'andreas' }, { userId: 'u1', username: 'anna' }), false);
});

test('a renamed subject does not detach a message from its author', () => {
  // id matches, subject differs -> still mine
  assert.equal(isOwnAuthor({ userId: 'u1', subject: 'old.login' }, { userId: 'u1', username: 'anna' }), true);
});

test('the env single-admin (no user record, no id) is matched on its subject', () => {
  assert.equal(isOwnAuthor({ userId: null, subject: 'admin' }, { userId: null, username: 'admin' }), true);
  assert.equal(isOwnAuthor({ userId: null, subject: 'ADMIN' }, { userId: null, username: 'admin' }), true);
  assert.equal(isOwnAuthor({ userId: null, subject: 'other' }, { userId: null, username: 'admin' }), false);
});

test('two absent user ids are never treated as the same person', () => {
  assert.equal(isOwnAuthor({ userId: null, subject: 'anna' }, { userId: null, username: 'andreas' }), false);
  assert.equal(isOwnAuthor({ userId: null, subject: 'anna' }, { userId: null, username: '' }), false);
  assert.equal(isOwnAuthor({ userId: null, subject: 'anna' }, {}), false);
  assert.equal(isOwnAuthor(null, { userId: 'u1' }), false);
  assert.equal(isOwnAuthor({ userId: 'u1' }, null), false);
});

/* ── describeMessageAuthor: the whole bubble decision ────────────────────── */

const anna = { userId: 'u1', username: 'anna' };
const andreas = { userId: 'u2', username: 'Andreas' };

function describe(message, viewer) {
  return describeMessageAuthor({ message, agentUserId: AGENT, viewer, directory: DIRECTORY });
}

test('the agent stays left with the bot icon and no name (D4)', () => {
  const d = describe({ sender: AGENT, body: 'hi' }, anna);
  assert.equal(d.isAgent, true);
  assert.equal(d.side, 'left');
  assert.deepEqual(d.badge, { kind: 'bot', initials: '', name: '' });
});

test("the agent's side never depends on the viewer", () => {
  assert.equal(describe({ sender: AGENT }, anna).side, 'left');
  assert.equal(describe({ sender: AGENT }, andreas).side, 'left');
  assert.equal(describe({ sender: AGENT }, null).side, 'left');
});

test('my own message is right-aligned and badged with my initials (D7)', () => {
  const d = describe({ sender: '@admin:local', [AUTHOR_FIELD]: { userId: 'u1', subject: 'anna' } }, anna);
  assert.equal(d.own, true);
  assert.equal(d.side, 'right');
  assert.deepEqual(d.badge, { kind: 'initials', initials: 'AS', name: 'Anna Schmidt' });
});

test('the same message renders on opposite sides for two viewers but shows the same initials (AC13)', () => {
  const message = { sender: '@admin:local', [AUTHOR_FIELD]: { userId: 'u1', subject: 'anna' } };
  const mine = describe(message, anna);
  const theirs = describe(message, andreas);
  assert.equal(mine.side, 'right');
  assert.equal(theirs.side, 'left');
  assert.equal(mine.badge.initials, theirs.badge.initials);
  assert.equal(mine.badge.name, theirs.badge.name);
});

test('a message with no recorded author stays right and gets the neutral icon (D8)', () => {
  const d = describe({ sender: '@admin:local', body: 'legacy' }, anna);
  assert.equal(d.isAgent, false);
  assert.equal(d.own, false);
  assert.equal(d.side, 'right');
  assert.deepEqual(d.badge, { kind: 'anonymous', initials: '', name: '' });
});

test('a third-party Matrix sender is treated as un-attributed (AC10/AC16)', () => {
  const d = describe({ sender: '@someone:elsewhere.example' }, anna);
  assert.equal(d.side, 'right');
  assert.equal(d.badge.kind, 'anonymous');
});

test('an attributed author with no renderable name gets the neutral icon, never ? or undefined (AC11)', () => {
  const d = describe({ sender: '@admin:local', [AUTHOR_FIELD]: { userId: 'ghost', subject: '  ' } }, anna);
  assert.equal(d.badge.kind, 'anonymous');
  assert.equal(d.badge.initials, '');
  assert.equal(d.badge.name, '');
});

test('the optimistic stub and the confirmed event agree on side and badge (AC18)', () => {
  const stamp = authorStampFor(anna);
  const optimistic = { sender: '@me:local-optimistic', isOptimistic: true, [AUTHOR_FIELD]: stamp };
  const confirmed = { sender: '@admin:local', [AUTHOR_FIELD]: { userId: 'u1', subject: 'anna' } };
  const a = describe(optimistic, anna);
  const b = describe(confirmed, anna);
  assert.equal(a.side, b.side);
  assert.deepEqual(a.badge, b.badge);
});

test('a viewer without a user record still sees their own messages on the right (AC13)', () => {
  const envAdmin = { userId: null, username: 'admin' };
  const d = describeMessageAuthor({
    message: { sender: '@admin:local', [AUTHOR_FIELD]: { subject: 'admin' } },
    agentUserId: AGENT,
    viewer: envAdmin,
    directory: DIRECTORY,
  });
  assert.equal(d.own, true);
  assert.equal(d.side, 'right');
  assert.deepEqual(d.badge, { kind: 'initials', initials: 'A', name: 'admin' });
});

test('describeMessageAuthor is total — no argument shape throws', () => {
  assert.equal(describeMessageAuthor().side, 'right');
  assert.equal(describeMessageAuthor({}).badge.kind, 'anonymous');
  assert.equal(describeMessageAuthor({ message: {}, agentUserId: '' }).isAgent, false);
});

/* ── the name-reveal stylesheet ──────────────────────────────────────────── */

test('the name is revealed on hover AND on keyboard focus (AC8)', () => {
  const css = authorBadgeCss();
  assert.match(css, new RegExp(`\\.${AUTHOR_BADGE_CLASS}:hover > \\.${AUTHOR_NAME_CLASS}`));
  assert.match(css, new RegExp(`\\.${AUTHOR_BADGE_CLASS}:focus-visible > \\.${AUTHOR_NAME_CLASS}`));
});

test('the reveal is out of flow, so showing it cannot reflow a row (AC9)', () => {
  const css = authorBadgeCss();
  const nameRule = css.slice(css.indexOf(`.${AUTHOR_NAME_CLASS} {`));
  assert.match(nameRule, /position: absolute;/);
  assert.match(nameRule, /visibility: hidden;/);
  assert.match(nameRule, /pointer-events: none;/);
  assert.match(nameRule, /white-space: nowrap;/);
});

test('the badge colours come from theme tokens, never from the person (D5)', () => {
  const css = authorBadgeCss();
  // Every colour is a var(--eb-*) token, so all three themes are covered and
  // nothing is derived per author.
  const colours = (css.match(/(?:^|\s)(?:background|color|border|outline):\s*([^;]+);/g) || [])
    // `outline: none` suppresses the pointer-focus ring; `:focus-visible`
    // re-adds a token-coloured one below.
    .filter(decl => !/:\s*none;$/.test(decl.trim()));
  assert.ok(colours.length > 0);
  for (const decl of colours) {
    assert.match(decl, /var\(--eb-/, `not a theme token: ${decl.trim()}`);
  }
});

test('the literal YOU is gone from the attribution model', () => {
  const rendered = [
    describe({ sender: AGENT }, anna),
    describe({ sender: '@admin:local' }, anna),
    describe({ sender: '@admin:local', [AUTHOR_FIELD]: { userId: 'u1' } }, anna),
  ];
  for (const d of rendered) assert.notEqual(d.badge.initials, 'YOU');
});
