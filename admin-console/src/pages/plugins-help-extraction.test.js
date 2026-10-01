import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PLUGINS_HELP_SECTIONS } from './plugins-help-sections.js';
import {
  topicSections,
  sectionSlug,
  OVERLAY_PLUGIN_INSTALL,
  OVERLAY_PLUGIN_UNINSTALL,
} from '../context/page-help-view.js';

// ─── #1986 (epic #1981) Plugins per-surface help guard ───────────────────────
//
// E5 (#1879) gave `/plugins` a topic and REMOVED the standalone /plugin-system
// page, so this one file is the only place the build-a-plugin reference still
// exists in the product — and all of it sat behind a single page-level "?".
// This ticket split it into eight chapters and pointed each surface at the one
// written for it. Four things can rot silently, and none of them throws:
//
//   • a chapter heading reworded out from under the slug a surface names — the
//     panel then just renders the topic from the top, which still *looks* like
//     the "?" worked,
//   • a surface losing its affordance, or gaining a hand-written slug instead
//     of the shared constant,
//   • a confirm dialog losing its published help subject — the "?" still opens
//     the panel, but a ConfirmDialog is the shared Modal at z-index 9999, so the
//     panel opens BEHIND the decision it is explaining, and
//   • the team-assign "?" drifting inside the no-team branch, which is exactly
//     the state whose reader needs the chapter most (the My-Credentials lesson
//     from #1993).
//
// All four are asserted from the real sources here. The JSX is otherwise
// uncovered per the #651 convention — this is a source-text guard, not a render
// test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters, constants and hooks being checked, and would
// otherwise satisfy the matchers they merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const page = sourceOf('Plugins.jsx');
const assign = sourceOf('../components/PluginTeamAssign.jsx');

const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/plugins.md'), 'utf8',
);

test('the stripped sources are still the components, not holes', () => {
  // The deep-dive pointer and both dialog bodies are introduced by comments; a
  // strip that ran away would make every doesNotMatch/absence check below pass
  // for entirely the wrong reason.
  for (const signature of [
    'export default function Plugins()',
    'function InstallDialogBody(',
    'function UninstallDialogBody(',
    'function PluginCard(',
    'const headerAction = usePageActions(',
  ]) {
    assert.ok(page.includes(signature), `comment-stripping removed ${signature}`);
  }
  assert.ok(
    assign.includes('export default function PluginTeamAssign('),
    'comment-stripping removed PluginTeamAssign',
  );
});

test('every chapter slug the surfaces name is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(PLUGINS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/plugins.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update PLUGINS_HELP_SECTIONS — a stale slug degrades silently '
    + `to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('What a plugin is'), PLUGINS_HELP_SECTIONS.what);
  assert.equal(
    sectionSlug('Install and grant are two different steps'),
    PLUGINS_HELP_SECTIONS.installVsGrant,
  );
  assert.equal(
    sectionSlug('Capabilities and the platform gate'),
    PLUGINS_HELP_SECTIONS.capabilities,
  );
  assert.equal(sectionSlug('Scope granularity and quota'), PLUGINS_HELP_SECTIONS.scope);
  assert.equal(
    sectionSlug('What activating does — and what uninstalling undoes'),
    PLUGINS_HELP_SECTIONS.activating,
  );
  assert.equal(sectionSlug('Plugins with their own UI'), PLUGINS_HELP_SECTIONS.ui);
  assert.equal(
    sectionSlug('Assigning a plugin to a team on this page'),
    PLUGINS_HELP_SECTIONS.teamAssignment,
  );
  assert.equal(
    sectionSlug('Deep dive: how a plugin works, and how to build one'),
    PLUGINS_HELP_SECTIONS.deepDive,
  );
});

test('the eight areas the ticket names are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of Object.keys(PLUGINS_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(PLUGINS_HELP_SECTIONS[key]),
      `"${PLUGINS_HELP_SECTIONS[key]}" must stay a "## " chapter — the panel scrolls `
      + 'to h2/h3, but the ticket asks for one clearly-headed chapter per area',
    );
  }
  assert.equal(h2.length, 8, `expected exactly the eight chapters, got ${h2.join(' · ')}`);
});

test('the three chapters with no "?" keep their own heading', () => {
  // Install-vs-grant, scope granularity and the UI-bearing chapter are reached
  // by scrolling the rendered topic — nothing deep-links to them, so nothing
  // else would notice if one were folded into a neighbour.
  const slugs = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['installVsGrant', 'scope', 'ui']) {
    assert.ok(slugs.includes(PLUGINS_HELP_SECTIONS[key]), `${key} chapter is gone`);
  }
});

test('the deep dive is ONE chapter with sub-headings (open question 1)', () => {
  // Answering the ticket's open question in the guard, not just in prose: the
  // surface table names exactly one deep-dive affordance, so splitting the deep
  // dive in two would leave a chapter no "?" can reach. Its parts stay `###`
  // sub-headings, which the panel can still scroll to if a later ticket wants
  // finer links.
  const sections = topicSections(topicBody);
  const deepAt = sections.findIndex(s => s.slug === PLUGINS_HELP_SECTIONS.deepDive);
  assert.ok(deepAt >= 0, 'the deep-dive chapter is gone');
  const after = sections.slice(deepAt + 1);
  assert.ok(after.length >= 4, 'the deep dive lost its sub-headings');
  assert.ok(
    after.every(s => s.level === 3),
    'everything after the deep-dive heading must be a "### " sub-heading — a "## " '
    + 'there would be a second chapter with no surface pointing at it',
  );
});

test('the page imports the shared registry and the shared button', () => {
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'Plugins.jsx must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ PLUGINS_HELP_SECTIONS \} from '\.\/plugins-help-sections\.js'/.test(page),
    'the slugs must come from the shared registry, never be written out inline',
  );
  assert.ok(
    /import PageHelpButton from '\.\/PageHelpButton'/.test(assign),
    'PluginTeamAssign.jsx must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ PLUGINS_HELP_SECTIONS \} from '\.\.\/pages\/plugins-help-sections\.js'/.test(assign),
    'PluginTeamAssign.jsx must import the shared slug registry',
  );
});

test('every surface in the ticket table renders a deep-linked "?"', () => {
  const buttons = page.match(/<PageHelpButton[\s\S]*?\/>/g) || [];
  assert.equal(
    buttons.length, 4,
    'expected four PageHelpButtons in Plugins.jsx (install dialog, uninstall '
    + `dialog, page header, deep-dive entry point), found ${buttons.length}`,
  );
  const sections = buttons.map((b) => {
    const m = /section=\{PLUGINS_HELP_SECTIONS\.(\w+)\}/.exec(b);
    return m ? m[1] : null;
  });
  assert.ok(
    sections.every(Boolean),
    'every "?" on this page must name its chapter — a section-less button opens '
    + `the topic at the top, which is the bug this ticket closes. Got: ${sections}`,
  );
  // Source order, not reading order: the two dialog bodies are declared before
  // the page component, whose headerAction in turn comes before the deep-dive
  // pointer it renders at the foot of the list.
  assert.deepEqual(
    sections, ['capabilities', 'activating', 'what', 'deepDive'],
    "the surfaces must map to the ticket's table: install dialog → the "
    + 'capability/platform-gate chapter (2/3/4, landing on the middle one), '
    + 'uninstall dialog → what activating and uninstalling do, page header → '
    + 'what a plugin is, deep-dive pointer → the deep dive',
  );
});

test('the team-assign control carries the chapter-7 "?"', () => {
  const buttons = assign.match(/<PageHelpButton[\s\S]*?\/>/g) || [];
  assert.equal(buttons.length, 1, `expected exactly one "?" in PluginTeamAssign, found ${buttons.length}`);
  assert.match(
    buttons[0],
    /section=\{PLUGINS_HELP_SECTIONS\.teamAssignment\}/,
    'the team-assignment control must deep-link to its own chapter',
  );
});

test('the team-assign "?" is outside the no-team branch (the ticket edge case)', () => {
  // "The team-assign control shows an empty/no-team state — its '?' still opens
  // the topic, never broken." The branch is `state.noTeams ? (…) : (…)`, so the
  // affordance has to sit in the header row ABOVE it.
  const branchAt = assign.indexOf('state.noTeams ?');
  const buttonAt = assign.indexOf('<PageHelpButton');
  assert.ok(branchAt > 0, 'the no-team branch is gone — re-point this guard');
  assert.ok(
    buttonAt > 0 && buttonAt < branchAt,
    'the "?" moved into (or below) the no-team branch: the reader who is told '
    + 'they have no team to assign to is precisely the one who needs the chapter',
  );
  assert.ok(
    assign.includes('You have no team you can assign this plugin to.'),
    'the no-team explanatory hint must stay — it is not replaced by the "?"',
  );
});

test('both confirm dialogs publish a help subject so the panel opens in front', () => {
  // Without these the "?" inside a ConfirmDialog (the shared Modal, z-index
  // 9999) opens the help panel underneath the decision it explains — a silent,
  // entirely visual failure.
  assert.ok(
    /import \{ useHelpSubject \} from '\.\.\/context\/HelperChatContext'/.test(page),
    'Plugins.jsx must import useHelpSubject',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_PLUGIN_INSTALL \}\)/.test(page),
    'the install confirm must publish OVERLAY_PLUGIN_INSTALL',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_PLUGIN_UNINSTALL \}\)/.test(page),
    'the uninstall confirm must publish OVERLAY_PLUGIN_UNINSTALL',
  );
  // Each subject must be published by the component that owns the dialog body,
  // not by the page: ConfirmDialog renders nothing while closed, which is what
  // makes the subject come and go with the dialog. A page-level subject would
  // stay active with no dialog open and lift the panel above every surface on
  // the route.
  const installAt = page.indexOf('function InstallDialogBody(');
  const uninstallAt = page.indexOf('function UninstallDialogBody(');
  const pageAt = page.indexOf('export default function Plugins()');
  const installSubjectAt = page.indexOf('useHelpSubject({ overlay: OVERLAY_PLUGIN_INSTALL })');
  const uninstallSubjectAt = page.indexOf('useHelpSubject({ overlay: OVERLAY_PLUGIN_UNINSTALL })');
  assert.ok(
    installAt < installSubjectAt && installSubjectAt < uninstallAt,
    'the install subject moved out of InstallDialogBody',
  );
  assert.ok(
    uninstallAt < uninstallSubjectAt && uninstallSubjectAt < pageAt,
    'the uninstall subject moved out of UninstallDialogBody',
  );
  // Both bodies must stay mounted only while their dialog is open — the "?" for
  // a System-Admin-only dialog may not exist when the dialog does not (the
  // ticket's second edge case).
  assert.ok(
    page.includes('message={pending ? <InstallDialogBody row={pending} /> : \'\'}'),
    'the install body must be rendered only while a row is pending',
  );
  assert.ok(
    page.includes('message={removing ? <UninstallDialogBody row={removing} /> : \'\'}'),
    'the uninstall body must be rendered only while a row is being removed',
  );
});

test('the overlay ids the page publishes are the registered constants', () => {
  assert.equal(OVERLAY_PLUGIN_INSTALL, 'modal:plugin-install');
  assert.equal(OVERLAY_PLUGIN_UNINSTALL, 'modal:plugin-uninstall');
  const helpRoutes = readFileSync(
    join(here, '../../api/helper-chat/help-routes.js'), 'utf8',
  );
  for (const key of [OVERLAY_PLUGIN_INSTALL, OVERLAY_PLUGIN_UNINSTALL]) {
    // An unregistered key resolves to no context, so panelZIndex never lifts —
    // the exact failure the subject was published to avoid.
    assert.ok(
      helpRoutes.includes(`'${key}'`),
      `${key} must be registered in help-routes.js (OVERLAY_KEYS + CONTEXT_KEYS)`,
    );
  }
});

test('no chapter slug is inlined as a literal', () => {
  for (const [name, slug] of Object.entries(PLUGINS_HELP_SECTIONS)) {
    for (const [file, src] of [['Plugins.jsx', page], ['PluginTeamAssign.jsx', assign]]) {
      assert.ok(
        !src.includes(`'${slug}'`) && !src.includes(`"${slug}"`),
        `${name}'s slug is inlined in ${file} — import it from `
        + 'plugins-help-sections.js so the drift guard above can see it',
      );
    }
  }
});

test('the page keeps exactly one page-level "?" in its header slot', () => {
  // A second entry point in the header would compete with the one the epic
  // standardised on; the other three buttons live inside the two dialogs and at
  // the foot of the list, not in the page-action slot.
  const header = page.slice(page.indexOf('const headerAction = usePageActions('));
  const headerEnd = header.indexOf('return (');
  assert.ok(headerEnd > 0, 'could not delimit the header slot');
  assert.equal(
    (header.slice(0, headerEnd).match(/<PageHelpButton/g) || []).length, 1,
    'expected exactly one page-level "?" in the page-action header slot',
  );
});

test('the deep-dive entry point is on the page, not only in the topic', () => {
  // E5 removed the "Learn about plugins" link along with /plugin-system, which
  // is why the ticket's surface table asks for one back. A "?" with no visible
  // pointer beside it is not an entry point.
  assert.match(
    page,
    /Building your own plugin\?/,
    'the deep-dive pointer text is gone — the chapter-8 "?" would then be an '
    + 'unlabelled icon at the foot of the page',
  );
});

test('no point-of-decision microcopy was traded for a "?"', () => {
  // Scope — out: the ticket expands the topic and adds "?" links. Every hint
  // below sits at the moment a decision is made and must stay on the page.
  const kept = [
    // the install dialog's lead, its per-capability risk cards and its quota line
    'Starts a broker with the privileges below — it grants the plugin to no agent.',
    'This plugin requests no host privileges.',
    '{row.quota}',
    '<CapabilityCard key={c.id} cap={c} />',
    // the uninstall dialog's grants-stay-in-place lead
    'The broker stops. Existing grants stay in place and seed nothing until you reinstall.',
    // the card's own privilege summary and its no-privilege counterpart
    "Privileges this plugin's broker receives",
    'Requests no host privileges.',
    // the read-only-viewer explanation of the install/grant split
    'You can see the registry, but only a System Admin can install or remove plugins.',
    // the Global UI badge tooltip
    'Team activation is still the only way its agent CLI is granted.',
    // the empty states
    'No plugins installed.',
    'Nothing further in the pool.',
  ];
  for (const phrase of kept) {
    assert.ok(page.includes(phrase), `"${phrase}" is point-of-decision copy and must stay on the page`);
  }
  for (const phrase of [
    'You have no team you can assign this plugin to.',
    'Assign to teams',
  ]) {
    assert.ok(assign.includes(phrase), `"${phrase}" must stay in PluginTeamAssign`);
  }
});

test('the topic keeps the two things this page cannot say for itself', () => {
  // The install/grant split and the platform gate are the page's two recurring
  // support questions, and both are now stated only in the topic.
  assert.match(
    topicBody,
    /not available on this stack/,
    'the topic must keep the platform-gate wording the card shows',
  );
  assert.match(
    topicBody,
    /uninstalling revokes\s+nothing/i,
    'the topic must keep saying that uninstalling revokes nothing — it is the '
    + 'half of the install/grant split the uninstall dialog does not state',
  );
});
