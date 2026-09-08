import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PROVIDER_GUIDANCE_COPY } from './quickstart-view.js';

// Source-reading drift guard for the #2084 provider dead end. The pure
// decisions (lock, role-aware guidance, blocker wording) are unit-tested in
// quickstart-view.test.js; what CANNOT be reached from there is the JSX that
// wires them — and the wiring is where the dead end lived. A `<Link to="/models">`
// rendered outside the `canAddProvider` branch is a dead end again for anyone
// `canAccessCredentialPages` turns away (App.jsx's CredentialRoute silently
// redirects them to /chats), and a field left `disabled={submitting}` re-opens
// the "type a name, then fail on submit" path. Both are one careless edit away
// and neither shows up in any pure test, so they are asserted here (the #651
// convention: JSX stays uncovered, its wiring is guarded by reading it).

const HERE = dirname(fileURLToPath(import.meta.url));

// Comments legitimately quote the copy and the route they explain, so they are
// stripped before any absence assertion — otherwise a comment naming what moved
// reads as the thing still being there.
function sourceWithoutComments(rel) {
  return readFileSync(join(HERE, rel), 'utf8')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const page = sourceWithoutComments('QuickStart.jsx');

// Non-vacuity: if the strip ever runs away (an unanchored comment regex on a
// large file has), every absence assertion below would "pass" by finding
// nothing. Pin that the page's own landmarks survived it.
test('the comment-stripped page is still the page', () => {
  assert.ok(page.length > 8000, `stripped source collapsed to ${page.length} chars`);
  for (const landmark of [
    'export default function QuickStart()',
    'id="quickstart-name"',
    'id="quickstart-llm"',
    'id="quickstart-url"',
    'No model provider configured',
  ]) {
    assert.ok(page.includes(landmark), `stripped source lost "${landmark}"`);
  }
});

test('#2084: the page decides "may add a provider" with the /models route guard', () => {
  // The SAME predicate that gates the route, not a re-derived role check — a
  // second rule here is how the message and the route drift apart, and the
  // ticket asks for a message that is easy to re-point when the policy moves.
  assert.match(
    page,
    /import \{ canAccessCredentialPages \} from '\.\/credential-scope-view'/,
    'the page must import canAccessCredentialPages, the predicate CredentialRoute uses',
  );
  assert.match(
    page,
    /const canAddProvider = canAccessCredentialPages\(user\)/,
    'canAddProvider must come from that predicate applied to the session user',
  );
  assert.match(page, /const \{ user \} = useAuth\(\)/, 'the page needs the session user');
});

test('#2084 AC1: the lock comes from providerLockActive and disables the fields', () => {
  assert.match(
    page,
    /const providerLock = providerLockActive\(\{ llmEndpointsLoading, hasLlmEndpoints \}\)/,
    'the lock must be the pure predicate, which is what keeps the loading state unlocked',
  );
  assert.match(
    page,
    /const fieldsDisabled = submitting \|\| providerLock/,
    'the fields must be disabled by the lock, not only while submitting',
  );
  // Every text/URL/picker input the user could otherwise fill in must honour it.
  // The provider <select> is deliberately excluded: it is already
  // `submitting || !hasLlmEndpoints`, which is a superset of the lock.
  const disabledProps = page.match(/disabled=\{[^}]*\}/g) || [];
  const submittingOnly = disabledProps.filter(p => p === 'disabled={submitting}');
  assert.deepEqual(
    submittingOnly, [],
    'a field still gated on `submitting` alone stays editable while the form is locked',
  );
  assert.ok(
    disabledProps.filter(p => p === 'disabled={fieldsDisabled}').length >= 4,
    `expected the name, URL, SSH-key and token controls to honour the lock, saw ${JSON.stringify(disabledProps)}`,
  );
});

test('#2084 AC2/AC3: the ONLY /models link on the page is inside the canAddProvider branch', () => {
  // This is the assertion the ticket is actually about. AC2 ("never silently
  // redirects a non-privileged user to /chats") is structural rather than a
  // promise only while no unconditional link to a route they may not open
  // exists.
  const links = [...page.matchAll(/to="\/models"/g)];
  assert.equal(links.length, 1, `expected exactly one /models link, found ${links.length}`);

  const open = page.indexOf('{canAddProvider ? (');
  assert.ok(open !== -1, 'the picker hint must branch on canAddProvider');
  const close = page.indexOf(") : 'The agent chats using this provider.'}", open);
  assert.ok(close !== -1, 'the non-privileged arm of the picker hint must offer no link');
  assert.ok(
    links[0].index > open && links[0].index < close,
    'the /models link must sit inside the canAddProvider arm',
  );
});

test('#2084 AC5: all three occurrences render the one shared guidance component', () => {
  // The ticket lists three places that said "Add provider →": the warning card,
  // the no_llm_endpoint submit error and the post-create llmWarning. Routing
  // them through one component is what makes them behave consistently — three
  // hand-written conditionals would be three chances to get the link wrong.
  const uses = page.match(/<ProviderGuidance /g) || [];
  assert.equal(uses.length, 3, `expected 3 <ProviderGuidance> sites, found ${uses.length}`);
  assert.match(page, /function ProviderGuidance\(\{ guidance, withText = true \}\)/);
  // Its link arm is the only place the page may build the affordance, and it is
  // reachable only when the pure decision supplied a link.
  assert.match(
    page,
    /if \(!guidance\.link\) \{\s*return <>\{guidance\.text\}<\/>;/,
    'no link ⇒ the passive text and nothing else',
  );
  assert.match(page, /const guidance = providerGuidance\(\{ canAddProvider \}\)/);
  // The card that used to carry the dead link is now gated on the lock, so it
  // and the lock can never disagree about whether a provider is missing.
  assert.match(page, /\{providerLock && \(/);
});

test('#2084: the page no longer hard-codes the guidance copy', () => {
  // The copy lives in quickstart-view.js as data so it is unit-testable and
  // re-pointable in one place; a literal left behind on the page would be a
  // second, unversioned copy that the role-aware branch does not govern.
  assert.ok(
    !page.includes(PROVIDER_GUIDANCE_COPY.linkLabel),
    `"${PROVIDER_GUIDANCE_COPY.linkLabel}" must come from PROVIDER_GUIDANCE_COPY, not the page`,
  );
  assert.ok(
    !page.includes(PROVIDER_GUIDANCE_COPY.canAdd),
    'the privileged sentence must come from PROVIDER_GUIDANCE_COPY',
  );
  assert.ok(
    !page.includes(PROVIDER_GUIDANCE_COPY.cannotAdd),
    'the passive sentence must come from PROVIDER_GUIDANCE_COPY',
  );
  // The heading stays a page literal on purpose: two help-extraction guards
  // (create-help-extraction.test.js, onboarding-help-copy.test.js) assert this
  // point-of-decision copy has not moved off the page into the help topic.
  assert.ok(page.includes('No model provider configured'));
});
