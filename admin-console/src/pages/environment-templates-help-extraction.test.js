import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENVIRONMENT_TEMPLATES_HELP_SECTIONS } from './environment-templates-help-sections.js';
import { topicSections, sectionSlug, OVERLAY_ENVIRONMENT_TEMPLATE_FORM, OVERLAY_TOOLCHAINS } from '../context/page-help-view.js';

// ─── #2170 (epic #2166 A4) Environment Templates help guard ─────────────────
//
// help-topics/environment-templates.md is the new, smaller System-Admin topic
// that replaced help-topics/environments.md when the general-purpose Working
// Environments page was retired. This test reads the real page + topic source
// and asserts they agree — the panel degrades silently (renders the topic from
// the top) when a chapter slug no longer matches a heading, so this guard is
// the only thing that notices.

const here = dirname(fileURLToPath(import.meta.url));

function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const page = sourceOf('EnvironmentTemplates.jsx');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/environment-templates.md'), 'utf8',
);

test('the stripped source is still the page, not a hole', () => {
  for (const signature of [
    'export default function EnvironmentTemplates()',
    'function EnvironmentForm(',
    'function ToolchainRegistryPanel(',
  ]) {
    assert.ok(page.includes(signature), `comment-stripping removed ${signature}`);
  }
});

test('every chapter slug the page names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(ENVIRONMENT_TEMPLATES_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/environment-templates.md no longer has a heading for these chapters. '
    + `Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  assert.equal(sectionSlug('What an Environment Template is'), ENVIRONMENT_TEMPLATES_HELP_SECTIONS.whatIs);
  assert.equal(sectionSlug('Repositories'), ENVIRONMENT_TEMPLATES_HELP_SECTIONS.repositories);
  assert.equal(sectionSlug('Credentials'), ENVIRONMENT_TEMPLATES_HELP_SECTIONS.credentials);
  assert.equal(sectionSlug('MCP server references'), ENVIRONMENT_TEMPLATES_HELP_SECTIONS.mcp);
  assert.equal(sectionSlug('Toolchains'), ENVIRONMENT_TEMPLATES_HELP_SECTIONS.toolchains);
});

test('the five chapters are top-level headings, not sub-sections', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['whatIs', 'repositories', 'credentials', 'mcp', 'toolchains']) {
    assert.ok(h2.includes(ENVIRONMENT_TEMPLATES_HELP_SECTIONS[key]), `"${key}" must stay a "## " chapter`);
  }
  assert.equal(h2.length, 5, `expected exactly five chapters, got ${h2.join(' · ')}`);
});

test('every "?" on the page names its own chapter from the shared registry', () => {
  const buttons = page.match(/<PageHelpButton[\s\S]*?\/>/g) || [];
  assert.ok(buttons.length >= 5, `expected at least five PageHelpButtons, found ${buttons.length}`);
  const sections = buttons.map((b) => {
    const m = /section=\{ENVIRONMENT_TEMPLATES_HELP_SECTIONS\.(\w+)\}/.exec(b);
    return m ? m[1] : null;
  });
  assert.ok(sections.every(Boolean), `every "?" must name its chapter — got: ${sections}`);
});

test('no chapter slug is inlined as a literal', () => {
  assert.ok(
    !/section=\s*(['"]|\{\s*['"])/.test(page),
    'a "?" on this page passes its chapter as a string literal — import it from '
    + 'environment-templates-help-sections.js instead',
  );
});

test('both side panels publish a help subject so the panel opens in front', () => {
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_ENVIRONMENT_TEMPLATE_FORM \}\)/.test(page),
    'the create/edit panel must publish OVERLAY_ENVIRONMENT_TEMPLATE_FORM',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_TOOLCHAINS \}\)/.test(page),
    'the Toolchains panel must publish OVERLAY_TOOLCHAINS',
  );
  assert.equal(OVERLAY_ENVIRONMENT_TEMPLATE_FORM, 'modal:environment-template-form');
  assert.equal(OVERLAY_TOOLCHAINS, 'modal:toolchains');
});

test('the credential-copy notice is present — the whole point of a template', () => {
  assert.match(page, /never/, 'the page must state credentials are never copied');
  assert.match(topicBody, /never copied/i, 'the topic must state the same rule');
});
