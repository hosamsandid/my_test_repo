import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEntries,
  createdAgentDestination,
  entriesByTier,
  entryByKey,
  heroEntry,
  isSingleAgentFormOpen,
  previewToggleLabel,
  ADVANCED_DEFAULT_OPEN,
  CREATE_COPY,
  CREATE_ENTRY_KEYS,
  CREATE_TIERS,
  SINGLE_AGENT_ROUTE,
} from './create-launcher-view.js';

// #2027's ordering, simplest → most advanced. This list is the contract: the
// whole point of the ticket is that the launcher is RANKED, so a reorder has to
// be a deliberate edit here rather than an accident in the entry array.
const ORDER = ['chat', 'template', 'describe', 'build', 'single-agent'];

test('the entries are ordered simplest → most advanced (#2027 AC1)', () => {
  const entries = createEntries();
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((e) => e.key), ORDER);
  assert.deepEqual(CREATE_ENTRY_KEYS, ORDER);
});

test('three tiers: one hero, exactly three flow cards, one advanced (AC1)', () => {
  assert.deepEqual(CREATE_TIERS, ['hero', 'flow', 'advanced']);
  assert.deepEqual(entriesByTier('hero').map((e) => e.key), ['chat']);
  assert.deepEqual(entriesByTier('flow').map((e) => e.key), ['template', 'describe', 'build']);
  assert.deepEqual(entriesByTier('advanced').map((e) => e.key), ['single-agent']);
  // Every entry claims a tier the renderer actually draws — an entry in a
  // fourth tier would silently vanish from the page.
  for (const e of createEntries()) {
    assert.ok(CREATE_TIERS.includes(e.tier), `${e.key} claims unknown tier ${e.tier}`);
  }
  // An unknown tier draws nothing rather than throwing.
  assert.deepEqual(entriesByTier('nope'), []);
  assert.deepEqual(entriesByTier(undefined), []);
});

test('heroEntry is the one primary action, and it is the fast lane (AC1/AC7)', () => {
  const hero = heroEntry();
  assert.equal(hero.key, 'chat');
  assert.equal(hero.tier, 'hero');
  // It is first on the page as well as first in its tier.
  assert.equal(CREATE_ENTRY_KEYS[0], 'chat');
  // AC7 — the hero still runs the existing team-of-one/quickstart path.
  assert.equal(hero.to, '/quickstart');
  // Only the hero carries a button label; a flow card is one of a row of peers.
  assert.equal(hero.action, 'Start chatting');
  for (const e of createEntries().filter((x) => x.key !== 'chat')) {
    assert.ok(!e.action, `${e.key} must not carry a hero button label`);
  }
});

test('AC2 — the two single-agent tiles are consolidated', () => {
  // The easy one is the hero...
  assert.equal(heroEntry().to, '/quickstart');
  // ...and its old wordy title is gone from the launcher entirely.
  const titles = createEntries().map((e) => e.title);
  assert.ok(
    !titles.includes('Just give me one assistant to chat with'),
    'the old fast-lane tile title must not survive alongside the hero',
  );
  assert.ok(
    !titles.includes('Create a single agent'),
    'the specialist path is renamed "Configure an agent manually"',
  );
  // ...and the manual one exists ONLY inside the advanced tier.
  const manual = entryByKey('single-agent');
  assert.equal(manual.title, 'Configure an agent manually');
  assert.equal(manual.tier, 'advanced');
  assert.equal(
    createEntries().filter((e) => e.to === SINGLE_AGENT_ROUTE).length, 1,
    'exactly one entry opens the direct create form',
  );
});

test('AC7 — every entry still hands off to the route it did before', () => {
  // This is a re-sort, not a rewiring: these five assertions are the whole of
  // "no change to what each path actually does on selection".
  assert.equal(entryByKey('chat').to, '/quickstart');
  assert.equal(entryByKey('template').to, '/team-setup');
  assert.equal(entryByKey('describe').to, '/flows?new=describe');
  assert.equal(entryByKey('build').to, '/flows?new=blank');
  assert.equal(entryByKey('single-agent').to, SINGLE_AGENT_ROUTE);
  assert.match(SINGLE_AGENT_ROUTE, /^\/create\?/);
});

test('AC4 — every visible string matches the binding copy inventory', () => {
  assert.equal(CREATE_COPY.pageTitle, 'What do you want to create?');
  assert.equal(
    CREATE_COPY.pageSubhead,
    'Pick a starting point — you can always grow or change it later.',
  );
  assert.equal(
    CREATE_COPY.headerHelp,
    'Not sure? Start by chatting with one assistant — you can turn it into a team anytime.',
  );
  assert.equal(
    CREATE_COPY.flowHeading,
    'Or build a team of agents that work together (a flow)',
  );
  assert.equal(
    CREATE_COPY.flowIntro,
    'A flow is several agents that hand work off to each other. All three options '
    + 'below end in the same flow — they differ only in how you start.',
  );
  assert.equal(CREATE_COPY.advancedToggle, 'Advanced options');

  const expected = {
    chat: {
      title: 'Chat with one assistant',
      description: 'The fastest way in. Get a single assistant you can talk to right away '
        + "— and grow it into a team whenever you're ready.",
      badge: 'Fastest start',
      outcome: '→ Opens a chat with your assistant',
    },
    template: {
      title: 'Start from a ready-made team',
      description: 'Pick a proven setup and adjust it to fit.',
      badge: 'Recommended',
      outcome: '→ Review the team, then launch it',
    },
    describe: {
      title: 'Describe what you need',
      description: 'Tell us in plain language what you want done; we draft the team for you.',
      badge: undefined,
      outcome: '→ Opens an editable draft on the canvas',
    },
    build: {
      title: 'Design it on the canvas',
      description: 'Lay the agents out visually and connect them yourself.',
      badge: 'Advanced',
      // DEVIATION from the inventory, required by the ticket's own edge case
      // ("must not ship ahead of it") and its open question 1(b). See the
      // dedicated test below.
      outcome: '→ Opens the canvas',
    },
    'single-agent': {
      title: 'Configure an agent manually',
      description: 'Set the id, role, Working Environment and system prompt yourself. '
        + 'For specialists who want full control.',
      badge: 'Advanced',
      outcome: '→ Opens the agent editor',
    },
  };
  for (const [key, want] of Object.entries(expected)) {
    const e = entryByKey(key);
    assert.equal(e.title, want.title, `${key} title`);
    assert.equal(e.description, want.description, `${key} body`);
    assert.equal(e.badge, want.badge, `${key} badge`);
    assert.equal(e.outcome, want.outcome, `${key} outcome`);
  }
});

test('the guided-empty-canvas promise is NOT shipped ahead of the canvas work', () => {
  // The inventory's Card C copy reads "→ Opens the canvas with a guided first
  // step", but the guided empty-canvas state is explicitly out of scope for
  // #2027 and its edge case forbids promising it early. Verified against the
  // code, not assumed: an empty draft renders #1124's centered "This flow is
  // empty" prompt with an "Add agent" CTA — a prompt, not a guided step, and
  // nothing at all is placed on the graph. So the softened copy of open
  // question 1(b) ships, and this test is what makes the softening deliberate:
  // when the guided step lands, this test fails and the copy is restored.
  const build = entryByKey('build');
  assert.equal(build.outcome, '→ Opens the canvas');
  assert.ok(
    !/guided first step/.test(build.outcome),
    'Card C must not promise a guided first step until one exists',
  );
  assert.ok(
    !/guided first step/.test(build.preview.caption),
    'the Card C preview caption must not promise a guided first step either',
  );
  // "never a blank page" is kept, because #1124's prompt makes it literally true.
  assert.match(build.preview.caption, /never a blank page/);
});

test('AC6 — the badges rank the entries: hero, recommended, and two advanced', () => {
  assert.equal(entryByKey('chat').badge, 'Fastest start');
  assert.equal(entryByKey('template').badge, 'Recommended');
  assert.equal(entryByKey('build').badge, 'Advanced');
  assert.equal(entryByKey('single-agent').badge, 'Advanced');
  // Card B carries none on purpose: it is the middle of the flow group, and a
  // badge on every card would rank nothing.
  assert.equal(entryByKey('describe').badge, undefined);
});

test('AC5 — every entry carries an outcome line and a "what you get" preview', () => {
  for (const e of createEntries()) {
    assert.match(e.outcome, /^→ /, `${e.key}'s outcome must read as a destination`);
    assert.equal(typeof e.preview.schematic, 'string');
    assert.ok(e.preview.schematic.length > 0, `${e.key} names no schematic`);
    assert.equal(typeof e.preview.caption, 'string');
    assert.ok(e.preview.caption.length > 0, `${e.key} has no preview caption`);
    // The schematic promises the KIND of destination, never a specific state —
    // so no caption may claim a particular agent, environment or reuse.
    assert.ok(
      !/\breus(e|ed|ing)\b/i.test(e.preview.caption),
      `${e.key}'s caption implies a specific reused resource: ${e.preview.caption}`,
    );
  }
  // Each entry gets its own schematic — a shared one would promise the wrong
  // destination for at least one of them.
  const schematics = createEntries().map((e) => e.preview.schematic);
  assert.equal(new Set(schematics).size, schematics.length);
  assert.deepEqual(
    createEntries().map((e) => e.preview.caption),
    [
      "You'll land in a chat window, talking to your assistant.",
      "You'll see a ready-made flow of agents to review, then launch.",
      'You type a sentence; we turn it into an editable draft flow.',
      "You'll start on the canvas with a prompt to add your first agent — never a blank page.",
      "You'll fill in an agent's details in a short form.",
    ],
  );
});

test('the preview control names its entry and its own state (touch a11y edge case)', () => {
  const build = entryByKey('build');
  assert.equal(previewToggleLabel(build), 'Show what you get: Design it on the canvas');
  assert.equal(previewToggleLabel(build, true), 'Hide what you get: Design it on the canvas');
  // Never an unlabelled control, whatever it is handed.
  assert.equal(previewToggleLabel(null), 'Show what you get: this option');
  assert.equal(previewToggleLabel({}), 'Show what you get: this option');
  assert.equal(previewToggleLabel({ title: '  ' }), 'Show what you get: this option');
});

test('the Advanced disclosure is collapsed for every user, on every load', () => {
  // Open question 3, answered: collapsed always, state not persisted. A
  // truthy default here would put the specialist path back on the first screen.
  assert.equal(ADVANCED_DEFAULT_OPEN, false);
});

test('#1667 Phase D — the hero keeps the "grow it into a team" framing (AC3)', () => {
  // #2027 moved the "team of one" reasoning into the help topic and replaced
  // the tile's wording with the inventory's, but the promise it protected —
  // that one assistant is not a dead end — has to survive on the page.
  assert.match(heroEntry().description, /grow it into a team/i);
  // No entry may re-introduce a forced up-front agent-vs-team choice.
  const forced = /\b(agent vs team|single agent vs team|choose (a )?(type|size)|which one)\b/i;
  for (const e of createEntries()) {
    assert.ok(
      !forced.test(e.description),
      `${e.key} description forces a mode choice: ${e.description}`,
    );
  }
});

test('AC3 — the flow group names the concept and says the three options converge', () => {
  assert.match(CREATE_COPY.flowHeading, /\(a flow\)/);
  assert.match(CREATE_COPY.flowIntro, /A flow is several agents/);
  assert.match(CREATE_COPY.flowIntro, /end in the same flow/);
});

test('#1665 AC7 (jargon-free titles) is superseded on purpose, not by accident', () => {
  // AC7 said the titles must let a first-timer choose without knowing the words
  // agent / team / flow / template — which is why the old ones talked around
  // them. #2027 AC3 requires the opposite for one of those words: the flow
  // heading must NAME and define "a flow", because talking around it is what
  // left three of the five paths unidentifiable as the same thing. The old
  // guard is therefore deleted; this asserts the REVERSAL is real, so nobody
  // "restores" AC7 by rewording the heading back into a euphemism.
  assert.match(CREATE_COPY.flowHeading, /\bagents\b/);
  assert.match(CREATE_COPY.flowHeading, /\bteam\b/);
  assert.match(entryByKey('template').title, /\bteam\b/);
  // What survives of AC7: nobody has to ARRIVE knowing the vocabulary, so the
  // heading that uses it defines it immediately...
  assert.match(CREATE_COPY.flowIntro, /^A flow is /);
  // ...and the two words with no plain-language meaning at all stay out of
  // every title, heading and body a newcomer reads.
  const opaque = /\b(template|orchestrator)s?\b/i;
  for (const text of [
    ...Object.values(CREATE_COPY),
    ...createEntries().flatMap((e) => [e.title, e.description, e.outcome, e.preview.caption]),
  ]) {
    assert.ok(!opaque.test(text), `internal vocabulary leaked into launcher copy: ${text}`);
  }
});

test('every entry has an icon and a route', () => {
  for (const e of createEntries()) {
    assert.equal(typeof e.icon, 'string');
    assert.ok(e.icon.length > 0);
    assert.equal(typeof e.to, 'string');
    assert.ok(e.to.startsWith('/'));
  }
});

test('#1956 — the single-agent panel opens only on its own query param', () => {
  assert.equal(isSingleAgentFormOpen(SINGLE_AGENT_ROUTE.split('?')[1]), true);
  assert.equal(isSingleAgentFormOpen('?form=agent'), true);
  assert.equal(isSingleAgentFormOpen(new URLSearchParams('form=agent')), true);
  // Anything else leaves the launcher as it was.
  assert.equal(isSingleAgentFormOpen(''), false);
  assert.equal(isSingleAgentFormOpen(undefined), false);
  assert.equal(isSingleAgentFormOpen('?form=team'), false);
  assert.equal(isSingleAgentFormOpen('?other=agent'), false);
  assert.equal(isSingleAgentFormOpen({}), false);
});

test('#1956 — a created agent lands on its own chat, except a team (which has none)', () => {
  assert.equal(createdAgentDestination({ id: 'cobol-agent', role: 'agent' }), '/chats/cobol-agent');
  // An orchestrator does have a DM room of its own.
  assert.equal(createdAgentDestination({ id: 'omega', role: 'orchestrator' }), '/chats/omega');
  // A `team` agent hosts no chat — it is a prompt template plus a rail group
  // header — so deep-linking to it would drop the user on an empty chat.
  assert.equal(createdAgentDestination({ id: 'alpha', role: 'team' }), '/chats');
  // Never a broken URL when the response is thinner than expected.
  assert.equal(createdAgentDestination({ role: 'agent' }), '/chats');
  assert.equal(createdAgentDestination(null), '/chats');
  assert.equal(createdAgentDestination({ id: 'a b/c', role: 'agent' }), '/chats/a%20b%2Fc');
});

test('entryByKey returns null for an unknown key, and hands out deep copies', () => {
  assert.equal(entryByKey('nope'), null);
  const a = entryByKey('describe');
  a.title = 'mutated';
  a.preview.caption = 'mutated';
  const fresh = createEntries().find((e) => e.key === 'describe');
  assert.notEqual(fresh.title, 'mutated');
  assert.notEqual(fresh.preview.caption, 'mutated');
});
