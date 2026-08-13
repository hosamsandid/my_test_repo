import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractContributors,
  encodeContributors,
  decodeContributors,
} from './contributors.js';

test('extractContributors: empty / non-string input yields an empty list (AC6)', () => {
  assert.deepEqual(extractContributors(''), []);
  assert.deepEqual(extractContributors('   \n  \n'), []);
  assert.deepEqual(extractContributors(undefined), []);
  assert.deepEqual(extractContributors(null), []);
  assert.deepEqual(extractContributors(42), []);
});

test('extractContributors: a single contributor appears once', () => {
  assert.deepEqual(
    extractContributors('Moritz Butzmann\tmoritz@example.com'),
    ['Moritz Butzmann'],
  );
});

test('extractContributors: merges name spellings that share an email (AC4)', () => {
  const raw = [
    'Maier, Thorsten A.\tthorsten.a.maier@accenture.com',
    'Thorsten Maier\tthorsten.a.maier@accenture.com',
  ].join('\n');
  // One person; the natural "Firstname Lastname" spelling wins.
  assert.deepEqual(extractContributors(raw), ['Thorsten Maier']);
});

test('extractContributors: merges an id-slug alias with the human name via a shared email (AC4)', () => {
  const raw = [
    'Zyskowski, Karol D.\tk.zyskowski@accenture.com',
    'k-zyskowski_accent\tk.zyskowski@accenture.com',
  ].join('\n');
  // The human-readable spelling beats the slug even though it carries a comma.
  assert.deepEqual(extractContributors(raw), ['Zyskowski, Karol D.']);
});

test('extractContributors: merges multiple emails that share one name (AC4)', () => {
  const raw = [
    'Moritz Butzmann\t71692962+moritzbutzmann@users.noreply.github.com',
    'Moritz Butzmann\tmoritz@example.com',
  ].join('\n');
  assert.deepEqual(extractContributors(raw), ['Moritz Butzmann']);
});

test('extractContributors: de-dups and orders alphabetically, case-insensitively (AC3/AC4/AC5)', () => {
  const raw = [
    'agent-studio-2-0-developer\tagent-studio-2-0-developer@agents.local',
    'Copetchi, Stefan\tstefan.copetchi@accenture.com',
    'Stefan Copetchi\tstefan.copetchi@accenture.com',
    'dependabot[bot]\t49699333+dependabot[bot]@users.noreply.github.com',
    'agent-studio-2-0-developer\tagent-studio-2-0-developer@agents.local',
  ].join('\n');
  assert.deepEqual(extractContributors(raw), [
    'agent-studio-2-0-developer',
    'dependabot[bot]',
    'Stefan Copetchi',
  ]);
});

test('extractContributors: transitively unions email- and name-linked identities', () => {
  // "Sam Quill" (email X) — "sam-q" (email X) — "sam-q" (email Y) form one chain:
  // the first pair links by email, the second by name, so all three collapse and
  // the human-readable spelling wins.
  const raw = [
    'Sam Quill\tshared@example.com',
    'sam-q\tshared@example.com',
    'sam-q\tother@example.com',
  ].join('\n');
  assert.deepEqual(extractContributors(raw), ['Sam Quill']);
});

test('extractContributors: tolerates a line with no email', () => {
  assert.deepEqual(extractContributors('Just A Name'), ['Just A Name']);
});

test('encode/decode round-trips a name list, including punctuation and non-ASCII', () => {
  const names = ['Zyskowski, Karol D.', 'dependabot[bot]', 'Valmaseda Castro, Javier', 'Renée Å'];
  assert.deepEqual(decodeContributors(encodeContributors(names)), names);
});

test('decodeContributors: fails soft to [] on missing / malformed input (AC6)', () => {
  assert.deepEqual(decodeContributors(''), []);
  assert.deepEqual(decodeContributors(undefined), []);
  assert.deepEqual(decodeContributors('not-valid-base64-@@@'), []);
  assert.deepEqual(decodeContributors(encodeContributors('not an array')), []);
});

test('decodeContributors: drops non-string / blank entries', () => {
  const encoded = encodeContributors(['Real Name', '', '   ', 7, null]);
  assert.deepEqual(decodeContributors(encoded), ['Real Name']);
});
