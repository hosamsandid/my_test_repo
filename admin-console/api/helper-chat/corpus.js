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

const helpRegistry = require('./help-registry');

const DOCS_DIR = path.join(__dirname, 'docs');
const PROMPT_FILE = path.join(__dirname, 'system-prompt.md');

// The context-help topics (#1872) are the SINGLE SOURCE folded into the chat
// grounding here — the very same files GET /api/helper/page-help serves the
// panel, so there is no vendoring/parity test to maintain (unlike the docs/**
// copies above). Loaded once at module init (fail-soft: a missing dir yields an
// empty registry and the corpus is unchanged).
const _helpRegistry = helpRegistry.loadRegistry();

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

function buildSystemPrompt(currentRouteLabel, currentRoute) {
  const promptTemplate = fs.readFileSync(PROMPT_FILE, 'utf8');
  const docsCorpus = CORPUS_FILES
    .map(f => {
      const full = path.join(DOCS_DIR, f);
      const content = fs.readFileSync(full, 'utf8');
      return `### ${f}\n\n${content}`;
    })
    .join('\n\n---\n\n');

  // Append the curated per-page help topics so a page-specific question is
  // answered from the very content the panel shows (§3.2). Empty when no topics
  // exist yet — the docs corpus is then unchanged.
  const helpFold = _helpRegistry.foldTopics();
  const corpus = helpFold
    ? `${docsCorpus}\n\n---\n\n### page-help topics\n\n${helpFold}`
    : docsCorpus;

  const routeContext = currentRouteLabel
    ? `\n\nThe user is currently on the **${currentRouteLabel}** page.\n`
    : '';
  // Point the model at the current page's help topic when one resolves.
  const routePointer = helpRegistry.routeGroundingPointer(_helpRegistry, currentRoute);

  return promptTemplate.replace('[corpus is appended here at runtime]', corpus) + routeContext + routePointer;
}

// Guard on the assembled grounding prompt (docs corpus + the folded page-help
// topics), ~75 000 tokens at the common 4-chars/token heuristic — same order as
// flow-copilot.js's 200 000. Raised 180 000 → 260 000 in #1879 (epic #1870) and
// 260 000 → 300 000 in #1889: the per-page topics are a deliberate, growing part
// of this corpus, and E5 alone added the whole build-a-plugin reference because
// it DELETED the standalone /plugin-system page that used to carry it. Trimming
// a topic to fit would degrade the panel too — the topic files are the single
// source both the panel and this prompt read — so the budget, not the content,
// is what gives.
//
// Raised a THIRD time, 300 000 → 340 000 in #1990 (epic #1981).
//
// **The "it stops growing here" note that used to end this comment was wrong.**
// #1889 was the last topic of epic #1870, but epic #1981 re-opened every one of
// them: each of its 13 children expands one page's topic into a per-surface
// reference, so the fold grows once per child ticket. And it is not only the
// topics — the docs/** corpus grows on its own: #1990's Skills topic alone fit
// under 300 000 (297 864), and it was #1956's unrelated docs/admin-console.md
// additions landing on main in the same window that took the assembled prompt to
// 301 679. Two independent growth sources against one ceiling.
//
// Do NOT answer that by trimming a topic: the topic files are the single source
// both the panel and this prompt read, so a trim degrades the panel too. The
// structural fix is to fold only the current route's topic plus its `seeAlso`
// neighbours instead of all of them (route-scoped folding — a separable ticket,
// since it changes what the assistant can answer about *other* pages, not just
// the size of the prompt).
//
// 340 000 is a STOP-GAP sized for roughly the next handful of #1981 children, not
// for all twelve. If you are the child ticket that hits it again, the right move
// is to open the route-scoped-folding ticket rather than to raise this a fourth
// time.
const SYSTEM_PROMPT_CHAR_LIMIT = 340_000;

function measureSystemPrompt() {
  return buildSystemPrompt(null).length;
}

module.exports = { buildSystemPrompt, measureSystemPrompt, SYSTEM_PROMPT_CHAR_LIMIT, CORPUS_FILES };
