'use strict';

// ─── Helper Chat corpus loader (#1733, spec docs/helper-chat-concept.md) ──────
//
// Assembles the system prompt the Helper Chat assistant is grounded on: the
// curated system-prompt.md template with the vendored product-documentation
// corpus spliced in at the `[corpus is appended here at runtime]` marker.
//
// The docs live next to this module (admin-console/api/helper-chat/docs/) as
// byte-identical copies of the repo-root docs/ files — the runtime image's
// build context is admin-console/, so it cannot reach repo-root docs/. The
// parity test in corpus.test.js is the drift guard: change a source doc and the
// vendored copy in the same commit.
//
// This module is pure I/O + string assembly (mirrors flow-copilot.js grounding
// layer) — the LLM transport lives in the route that consumes buildSystemPrompt.

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, 'docs');
const PROMPT_FILE = path.join(__dirname, 'system-prompt.md');

// List of files in the order they are concatenated (importance-ordered)
const CORPUS_FILES = [
  'glossary.md',               // concept disambiguation first
  'admin-console.md',          // page reference
  'agent-roles.md',
  'working-environments.md',
  'triggers.md',
  'skills-system.md',
  'model-providers.md',
  'credentials.md',
  'agent-chat-troubleshooting.md',
  'collaboration-mode-faq.md',
  'walkthrough/01-team-setup.md',
  'walkthrough/02-working-with-agents.md',
  'walkthrough/03-triggers.md',
  'walkthrough/04-flows.md',
  'walkthrough/05-agent-templates.md',
  'walkthrough/06-knowledge.md',
];

function buildSystemPrompt(currentRouteLabel) {
  const promptTemplate = fs.readFileSync(PROMPT_FILE, 'utf8');
  const corpus = CORPUS_FILES
    .map(f => {
      const full = path.join(DOCS_DIR, f);
      const content = fs.readFileSync(full, 'utf8');
      return `### ${f}\n\n${content}`;
    })
    .join('\n\n---\n\n');

  const routeContext = currentRouteLabel
    ? `\n\nThe user is currently on the **${currentRouteLabel}** page.\n`
    : '';

  return promptTemplate.replace('[corpus is appended here at runtime]', corpus) + routeContext;
}

const SYSTEM_PROMPT_CHAR_LIMIT = 180_000; // same limit as flow-copilot.js

function measureSystemPrompt() {
  return buildSystemPrompt(null).length;
}

module.exports = { buildSystemPrompt, measureSystemPrompt, SYSTEM_PROMPT_CHAR_LIMIT, CORPUS_FILES };
