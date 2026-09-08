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
//
// Only the CURRENT context's topics are folded in, not all of them (#2006) — see
// the SYSTEM_PROMPT_CHAR_LIMIT comment below for why, and
// help-registry.js `foldTopicsForContext` for the scoping rule.
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

// Stated in the prompt because the narrowing is a real limit on what the model
// can answer: the topics for OTHER pages are not in front of it, so an honest
// "open that page and ask again" beats an invented answer (the template already
// forbids inventing UI, this tells it when it is short of material).
const HELP_FOLD_NOTE = ' (the current page and the pages it links to — other pages\' topics are not included; say so rather than guessing)';

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
  // answered from the very content the panel shows (§3.2) — scoped to the
  // current context (#2006): this page's topic plus its `seeAlso` neighbours,
  // and the Overview topic plus its neighbours when no route resolves. Empty
  // when no topics exist yet — the docs corpus is then unchanged.
  const helpFold = _helpRegistry.foldForContext(currentRoute);
  const corpus = helpFold
    ? `${docsCorpus}\n\n---\n\n### page-help topics${HELP_FOLD_NOTE}\n\n${helpFold}`
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
// flow-copilot.js's 200 000. Raised 180 000 → 260 000 in #1879 (epic #1870),
// 260 000 → 300 000 in #1889 and 300 000 → 340 000 in #1990 (epic #1981), each
// time because the per-page topics are a deliberate, growing part of this corpus
// and trimming one to fit would degrade the panel too (the topic files are the
// single source both consumers read) — so the budget, not the content, gave.
//
// **#2006 stopped the raising instead of raising it again.** The limit is the same
// 340 000 it was after #1990; what changed is WHAT is measured against it. The
// prompt no longer carries every page's topic, only the current context's plus
// its `seeAlso` neighbours (route-scoped folding — `foldTopicsForContext` in
// help-registry.js), so the two growth sources that used to add up against one
// ceiling now behave differently:
//
//   • a NEW page topic adds a new *candidate* context of its own size, and does
//     not enlarge any existing one unless a topic links to it;
//   • EXPANDING an existing topic (what every #1981 child does) enlarges the
//     contexts of its own page and of the pages that link to it — so it still
//     costs, but against the largest single page's neighbourhood rather than
//     against the sum of all thirteen;
//   • the docs/** corpus still counts in full on every request (CORPUS_FILES is
//     untouched — narrowing that is a separate question).
//
// The number therefore now means "docs corpus + the biggest single page
// neighbourhood", which is what measureWorstCaseSystemPrompt() below measures and
// corpus.test.js asserts. Measured on this branch: the worst context is
// **`/quickstart`** (the Create & Quickstart topic plus its `seeAlso`
// neighbours) at 290 877 of 340 000 — 85.6% used, 49 123 left — against
// 322 243 (94.8%) for the all-topics fold route-scoping replaced. #1930 moved
// the crown here by removing the Agents page: `/flows` lost its `/agents`
// `seeAlso` neighbour and fell to 258 761, the no-route Overview fold dropped
// too, and `create.md` (which claims `/create` and `/quickstart`) links to
// `/chats`, whose topic absorbed the deleted `agents.md` — so the biggest single
// neighbourhood is now the one `/quickstart` sees. It had been the no-route
// fallback at 262 568 since #1996, and stood at 274 479 after #1930; #2027
// re-cut `create.md`'s first chapter for the re-sorted launcher, which lands on
// this figure in full (+1 613) because the crown-holding context IS that topic's,
// and its walkthrough/admin-console.md rewrites add a further +3 254 that lands
// on EVERY context, docs/** being folded in full on every request; #2028's own
// agent-chat.md edit (+347) is in this figure too, having landed on main while
// this branch was open — the two were re-measured together on the merge rather
// than added up, because both grow the same total. #2034 then narrowed the
// launcher's preview to the flow cards, which cost +645 on top of 279 693: +250
// in `create.md` (the crown-holding context IS that topic's, so a paragraph
// there lands on this figure in full) and +395 in admin-console.md +
// walkthrough/01-team-setup.md, which lands on EVERY context. #2031 then added
// the direct-hand-off chapter to `flows.md` (+2 067 measured on this branch;
// re-measured on the merge, with #2035's nav pin already in, that figure was
// 282 691). #2045 removed the one-assistant form's team-of-one footer and its
// repo-URL help text, which grew the figure by +593 rather than shrinking it —
// a page-copy REMOVAL is not a grounding saving, because the facts the copy
// carried have to keep being answerable: +249 in `create.md` (which IS the
// crown-holding context's topic, so it lands in full) for the "where the Grow
// link went" reconciliation, and +348 in walkthrough/01-team-setup.md, which
// lands on EVERY context. #2052 then gave a standalone assistant a real
// **Convert into a team…** action, which voided chapter 2's documented dead end
// ("growing creates a new team, it does not convert this one"): +2 064 on top of
// 284 200, and BOTH halves land in full — +1 229 in `create.md`, the
// crown-holding context's own topic, and +835 in `agent-chat.md`, which that
// topic names as a `seeAlso` neighbour and which is where the action actually
// lives (the row menu). The review of #2052 then caught the same dead end still
// asserted in walkthrough/01-team-setup.md ("growing creates a *new* team rather
// than converting this assistant"), so fixing it to name both grow paths added a
// further +110, and — being in CORPUS_FILES — that lands on EVERY context, taking
// the crown to 286 374 (still 84.2%). Documenting a new action in the page topic
// that hosts it is therefore never free for this context; it is still the right home — worth
// knowing WHY a Flows edit lands on the `/quickstart` figure at all: `create.md`
// lists `/flows` among its `seeAlso`, so the crown-holding neighbourhood
// contains the Flows topic even though the crown is not on `/flows`. Its other
// docs edit (`docs/process-template-format.md`) costs nothing here, that file
// not being in CORPUS_FILES. #2053 then renamed the design → live-team action
// from *Materialize* to **Create team…** everywhere a user reads it, rewriting
// `create.md` (the crown context's own topic), `flows.md` (its `seeAlso`
// neighbour, so it lands here too) and the every-context `walkthrough/04-flows.md`
// + `glossary.md`; re-measured on the merge with #2052's #2060 walkthrough fix
// already in, that took the crown from 286 374 to **288 483** (84.8%, +2 109 —
// stated as one total measured together rather than a per-file sum, since all four
// grow the same crown). #2057 then made a direct hand-off read as
// a consumer on the two read-only wiring surfaces, which voided `agent-chat.md`'s
// `## Outcomes` claim that "the label is what wakes the next agent" (the same
// claim the panel was making): +895 for the two-mechanism table, and it lands in
// full because `create.md` names `/chats` as a `seeAlso` neighbour — 289 378
// (85.1%). #2059 then turned the configured initial user into a first-boot seed
// for a real System-Admin record, voiding the "login falls back to the
// environment's built-in single admin" story in `users.md`, `access-users.md`
// and `docs/admin-console.md` — the last of which is `CORPUS_FILES`, so its
// half lands on EVERY context: +1 499 to **290 877** (85.6%).
// Re-measure rather than trust this comment —
// measureWorstCaseSystemPrompt() sweeps every context and returns which one
// won, so read the `context` it hands back and never assume it is still the
// page you edited.
//
// If this ever gets tight again, the next structural step is the docs corpus
// (route-scoped `CORPUS_FILES`, or splitting the two largest docs), NOT a fourth
// raise and NOT trimming a topic.
//
// The running total the #1981 children used to keep here is retired: a child no
// longer has to measure before writing, because its topic can only enlarge its own
// page's neighbourhood and those of the pages linking to it. If you want the
// number anyway, from admin-console/api:
//   node -e "console.log(require('./helper-chat/corpus').measureWorstCaseSystemPrompt())"
const SYSTEM_PROMPT_CHAR_LIMIT = 340_000;

// The assembled prompt for one context (default: the no-route fallback). Kept
// arg-compatible with its pre-#2006 no-argument form.
function measureSystemPrompt(currentRoute = null) {
  return buildSystemPrompt(null, currentRoute).length;
}

// The largest prompt the route-scoped mechanism can actually assemble, as
// `{ context, length }`: the docs corpus plus the biggest page neighbourhood, over
// every context a topic claims AND the no-route fallback (which is the Overview
// topic plus its neighbours — the panel's own documented fallback, deliberately
// NOT every topic, since an all-topics fallback would keep the worst case exactly
// where it was and make every new topic move it by its full size again).
//
// The context key doubles as the route label so the "currently on the …" sentence
// is included; that sentence is a bounded few dozen characters, so the reported
// worst case is the assembled prompt to within a rounding error of the real label.
function measureWorstCaseSystemPrompt() {
  let worst = { context: null, length: -1 };
  for (const context of helpRegistry.groundingContexts(_helpRegistry)) {
    const length = buildSystemPrompt(context || null, context).length;
    if (length > worst.length) worst = { context, length };
  }
  return worst;
}

module.exports = {
  buildSystemPrompt,
  measureSystemPrompt,
  measureWorstCaseSystemPrompt,
  SYSTEM_PROMPT_CHAR_LIMIT,
  CORPUS_FILES,
};
