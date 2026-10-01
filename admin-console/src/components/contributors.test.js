import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractContributors,
  isHumanIdentity,
  encodeContributors,
  decodeContributors,
} from './contributors.js';

test('extractContributors: empty / non-string input yields an empty list (AC9)', () => {
  assert.deepEqual(extractContributors(''), []);
  assert.deepEqual(extractContributors('   \n  \n'), []);
  assert.deepEqual(extractContributors(undefined), []);
  assert.deepEqual(extractContributors(null), []);
  assert.deepEqual(extractContributors(42), []);
});

test('extractContributors: a single human contributor appears once', () => {
  assert.deepEqual(
    extractContributors('Moritz Butzmann\tmoritz@example.com'),
    ['Moritz Butzmann'],
  );
});

// --- classification (#1778, AC1/AC2) ----------------------------------------

test('isHumanIdentity: excludes internal agent domains and [bot] names, keeps real ones', () => {
  // Agent / technical identities -> excluded.
  assert.equal(isHumanIdentity({ name: 'agent-studio-2-0-developer', email: 'agent-studio-2-0-developer@agents.local' }), false);
  assert.equal(isHumanIdentity({ name: 'Documentation Sync', email: 'agent-studio-2-0-documentation-sync@agent' }), false);
  assert.equal(isHumanIdentity({ name: 'claw-agent', email: 'claw-agent@local' }), false);
  assert.equal(isHumanIdentity({ name: 'Agent Studio', email: 'knowledge@agents.local' }), false);
  assert.equal(isHumanIdentity({ name: 'gcp-test-developer', email: 'gcp-test-developer@agents.local' }), false);
  // Bot by display name, even under a real (github-noreply) domain.
  assert.equal(isHumanIdentity({ name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' }), false);
  // Humans -> kept.
  assert.equal(isHumanIdentity({ name: 'Maier, Thorsten A.', email: 'thorsten.a.maier@accenture.com' }), true);
  assert.equal(isHumanIdentity({ name: 'Moritz Butzmann', email: '71692962+moritzbutzmann@users.noreply.github.com' }), true);
});

test('extractContributors: drops agent / bot / service identities (AC1/AC2)', () => {
  const raw = [
    'agent-studio-2-0-developer\tagent-studio-2-0-developer@agents.local',
    'Backend Engineer\tdb-accessio-sdlc-harris-v0-2-draft-backend-engineer@agents.local',
    'Documentation Sync\tagent-studio-2-0-documentation-sync@agent',
    'claw-agent\tclaw-agent@local',
    'dependabot[bot]\t49699333+dependabot[bot]@users.noreply.github.com',
    'gcp-test-developer\tgcp-test-developer@agents.local',
    'Stefan Copetchi\tstefan.copetchi@accenture.com',
  ].join('\n');
  // Only the human survives.
  assert.deepEqual(extractContributors(raw), ['Stefan Copetchi']);
});

test('isHumanIdentity: the whole .local / .local.test family is non-human (#2698)', () => {
  // Identities that used to slip through the fixed host list.
  assert.equal(isHumanIdentity({ name: 'Documentation Sync', email: 'documentation-sync@agent-studio.local' }), false);
  assert.equal(isHumanIdentity({ name: 'agent-studio-2-0-reworker', email: 'reworker@agent.local' }), false);
  assert.equal(isHumanIdentity({ name: 'r', email: 'r@a.local' }), false);
  assert.equal(isHumanIdentity({ name: 'merger-test', email: 'merger@local.test' }), false);
  assert.equal(isHumanIdentity({ name: 'agent-repo-synced', email: 'agent-repo-synced@agents.local' }), false);
  assert.equal(isHumanIdentity({ name: 'x', email: 'x@sub.local.test' }), false);
  assert.equal(isHumanIdentity({ name: 'X', email: 'X@AGENT.LOCAL' }), false);
  // Anchored: a real domain that merely contains "local" stays human.
  assert.equal(isHumanIdentity({ name: 'Lo Cal', email: 'lo.cal@localhost-corp.com' }), true);
  assert.equal(isHumanIdentity({ name: 'Local Person', email: 'local@accenture.com' }), true);
  assert.equal(isHumanIdentity({ name: 'Stefan Copetchi', email: 'stefan.copetchi@accenture.com' }), true);
  assert.equal(isHumanIdentity({ name: 'Moritz Butzmann', email: 'moritz@example.com' }), true);
});

test('extractContributors: .local-family agents no longer appear as people (#2698)', () => {
  const raw = [
    '144\tagent-studio-2-0-reworker\tagent-studio-2-0-reworker@agents.local',
    '3\tagent-studio-2-0-reworker\treworker@agent.local',
    '7\tDocumentation Sync\tdocumentation-sync@agent-studio.local',
    '1\tr\tr@a.local',
    '2\tmerger-test\tmerger@local.test',
    '5\tagent-repo-synced\tagent-repo-synced@agents.local',
    '10\tStefan Copetchi\tstefan.copetchi@accenture.com',
    '4\tPolychronakis, Harris\tharris.polychronakis@accenture.com',
  ].join('\n');
  assert.deepEqual(extractContributors(raw), ['Stefan Copetchi', 'Polychronakis, Harris']);
});

// --- de-duplication (AC5) ----------------------------------------------------

test('extractContributors: merges name spellings that share an email (AC5)', () => {
  const raw = [
    'Maier, Thorsten A.\tthorsten.a.maier@accenture.com',
    'Thorsten Maier\tthorsten.a.maier@accenture.com',
  ].join('\n');
  // One person; the natural "Firstname Lastname" spelling wins.
  assert.deepEqual(extractContributors(raw), ['Thorsten Maier']);
});

test('extractContributors: merges an id-slug alias with the human name via a shared email (AC5)', () => {
  const raw = [
    'Zyskowski, Karol D.\tk.zyskowski@accenture.com',
    'k-zyskowski_accent\tk.zyskowski@accenture.com',
  ].join('\n');
  // The human-readable spelling beats the slug even though it carries a comma.
  assert.deepEqual(extractContributors(raw), ['Zyskowski, Karol D.']);
});

test('extractContributors: merges multiple emails that share one name (AC5)', () => {
  const raw = [
    'Moritz Butzmann\t71692962+moritzbutzmann@users.noreply.github.com',
    'Moritz Butzmann\tmoritz@example.com',
  ].join('\n');
  assert.deepEqual(extractContributors(raw), ['Moritz Butzmann']);
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

// --- ordering by commit count (AC4/AC6/AC7) ---------------------------------

test('extractContributors: orders by descending commit count (per-commit lines, AC4)', () => {
  // One line per commit; occurrence count drives the order.
  const raw = [
    'Cara\tcara@accenture.com',
    'Bela\tbela@accenture.com',
    'Bela\tbela@accenture.com',
    'Bela\tbela@accenture.com',
    'Ada\tada@accenture.com',
    'Ada\tada@accenture.com',
  ].join('\n');
  // Bela 3, Ada 2, Cara 1.
  assert.deepEqual(extractContributors(raw), ['Bela', 'Ada', 'Cara']);
});

test('extractContributors: sums a person\'s merged identities for the sort key (AC5/AC4)', () => {
  const raw = [
    // Dana: 1 + 1 across two identities = 2 total.
    'Dana\tdana@accenture.com',
    'dana-slug\tdana@accenture.com',
    // Evan: 2 under one identity.
    'Evan\tevan@accenture.com',
    'Evan\tevan@accenture.com',
    // Finn: 3, most.
    'Finn\tfinn@accenture.com',
    'Finn\tfinn@accenture.com',
    'Finn\tfinn@accenture.com',
  ].join('\n');
  // Finn 3 > (Dana 2 == Evan 2, alphabetical) — Dana before Evan.
  assert.deepEqual(extractContributors(raw), ['Finn', 'Dana', 'Evan']);
});

test('extractContributors: breaks commit-count ties alphabetically, case-insensitively (AC6)', () => {
  const raw = [
    'charlie\tcharlie@accenture.com',
    'Bravo\tbravo@accenture.com',
    'alpha\talpha@accenture.com',
  ].join('\n');
  // All tied at 1 -> alphabetical, case-insensitive.
  assert.deepEqual(extractContributors(raw), ['alpha', 'Bravo', 'charlie']);
});

test('extractContributors: accepts pre-aggregated <count>\\t<name>\\t<email> lines (Docker build path)', () => {
  // The Makefile collapses the log with `sort | uniq -c` to keep the build arg
  // small; each line carries an explicit leading commit count.
  const raw = [
    '5\tGita\tgita@accenture.com',
    '9\tHana\thana@accenture.com',
    '9\tagent-studio-2-0-developer\tagent-studio-2-0-developer@agents.local',
  ].join('\n');
  // Agent dropped; Hana (9) before Gita (5).
  assert.deepEqual(extractContributors(raw), ['Hana', 'Gita']);
});

test('extractContributors: counted lines still merge identities and sum counts', () => {
  const raw = [
    '4\tZyskowski, Karol D.\tk.zyskowski@accenture.com',
    '10\tk-zyskowski_accent\tk.zyskowski@accenture.com',
    '7\tSolo\tsolo@accenture.com',
  ].join('\n');
  // Karol = 4 + 10 = 14 (merged) > Solo 7.
  assert.deepEqual(extractContributors(raw), ['Zyskowski, Karol D.', 'Solo']);
});

test('extractContributors: an all-agent history filters down to an empty list (AC9)', () => {
  const raw = [
    'agent-studio-2-0-developer\tagent-studio-2-0-developer@agents.local',
    'dependabot[bot]\t49699333+dependabot[bot]@users.noreply.github.com',
  ].join('\n');
  assert.deepEqual(extractContributors(raw), []);
});

test('extractContributors: tolerates a line with no email (kept as human)', () => {
  assert.deepEqual(extractContributors('Just A Name'), ['Just A Name']);
});

// --- base64 <-> string[] interchange ----------------------------------------

test('encode/decode round-trips a name list, including punctuation and non-ASCII', () => {
  const names = ['Zyskowski, Karol D.', 'Valmaseda Castro, Javier', 'Renée Å'];
  assert.deepEqual(decodeContributors(encodeContributors(names)), names);
});

test('decodeContributors: fails soft to [] on missing / malformed input (AC9)', () => {
  assert.deepEqual(decodeContributors(''), []);
  assert.deepEqual(decodeContributors(undefined), []);
  assert.deepEqual(decodeContributors('not-valid-base64-@@@'), []);
  assert.deepEqual(decodeContributors(encodeContributors('not an array')), []);
});

test('decodeContributors: drops non-string / blank entries', () => {
  const encoded = encodeContributors(['Real Name', '', '   ', 7, null]);
  assert.deepEqual(decodeContributors(encoded), ['Real Name']);
});
