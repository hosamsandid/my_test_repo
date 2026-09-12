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
// **`/quickstart`** (the `create.md` topic plus its `seeAlso` neighbours) at
// 324 900 of 340 000 — 95.6% used, 15 100 left. #2179's own +408 — a new
// `team-setup.md` bullet ("Create team" disabled with no model provider
// registered), a `/quickstart` `seeAlso` neighbour via `create.md` — landed on
// an already-stale 324 492 live on `origin/main` (measured directly, not
// carried forward): +2 019 over the 322 473 last stamped here from intervening
// merges (#2175/#2176's credential-resolution doc growth, #2193's undocumented
// system-event rendering) that, per the #2187-cycle convention, earned a
// live-budget check but no restamp at the time, since none of them touched a
// `/quickstart` `seeAlso` topic the way this one does. Against
// 322 243 (94.8%) for the all-topics fold route-scoping replaced. (#2195's own
// +93 — the corpus-vendored `working-environments.md` plus the `/environments`
// and `/mcp` help topics, correcting the ownership-picker-removal description —
// was still unmerged when main's own restamp landed at 322 380; re-measured on
// this merge rather than trusted, per the #1996 lesson. #2175's
// growth of the corpus-vendored `credentials.md` — the SSH-equivalent /
// acting-sender section, counted on EVERY context, not just a seeAlso
// neighbourhood — added the last +1 260 to this crown, cleanly attributable
// since #2168's own +265 (team-setup.md, Working Environment now optional at
// team creation) was the only change between the last restamp (318 602) and
// this one, verified against the immediate pre-#2187 main tip (321 120,
// matching the prior stamp exactly). #2158's
// `working-environments.md` growth — a CORPUS_FILES member, counted on EVERY
// context rather than only a seeAlso neighbourhood — added the last +1 069 to
// this crown, unstamped until now; #2146's *Inline image thumbnails* chapter
// in `agent-chat.md` — the `/chats` topic, which `create.md` names among its
// `seeAlso` — had added +284 before it; #2131's *When a flow is too large to
// generate in one go* chapter in `flows.md`, the `/flows` topic on the same
// `seeAlso` list, had added +674 before it; #2136's *Global providers* chapter
// in `models.md`, the
// `/models` topic on the same `seeAlso` list, had added +3 012 before it;
// #1459's work-plane bullet in `access-users.md` had added +319 before it.
// #2138's orphaned-credential refusal added the last +1 179, mostly through the
// corpus-vendored `credentials.md` — which counts on every context, this crown
// included — plus the `/my-credentials`+`/github-tokens`+`/ssh-keys` help topic.)
//
// **#2170 SHRANK the crown instead of growing it — a rare direction for this
// number to move.** Removing the Working Environments page retired the
// `/environments` help topic (`environments.md`, 349 lines) outright rather
// than folding it whole into a survivor: the material describing a still-live
// surface (repositories, credentials, MCP references, the propagation dialog)
// moved into the existing `agent-chat.md` (+61 net lines, since it now also
// hosts the Working-Environment-section chapter), and the System-Admin-only
// half (Toolchains) moved into a new, small `environment-templates.md` (76
// lines) — which is NOT on `/quickstart`'s `seeAlso` chain (only System Admins
// reach it, from Administration), so it does not fold into this crown at all.
// Net effect measured on the merge (overlaid onto post-#2204/#2206 `main`,
// since this branch was 12 commits behind at review time): the PR's own
// stamp read **314 890 of 340 000 — 92.6% used, 25 110 left**, but
// `measureWorstCaseSystemPrompt()` on the actual post-merge tree
// (commit 36aebb4d4, /quickstart) returns **315 448** — the overlay
// estimate undercounted by 558 chars, not caught by `corpus.test.js`
// (which only asserts `< 340 000`). Re-stamped here to the verified figure:
// **315 448 of 340 000 — 92.8% used, 24 552 left**, down from the
// last-stamped 324 900. Reconciled here + the CLAUDE.md #1872 paragraph +
// `context-help-system-concept.md` §9 — the lesson: an "overlaid onto main"
// estimate is still an estimate; re-measure on the real merge commit before
// stamping, the same rule that already applies to a branch's own self-report.
// #2195 (A3 of epic #2166) removed the ownership/team picker from the
// Working Environments and MCP Servers forms — the corpus-vendored
// `working-environments.md` table row correcting to "derived from the team,
// not chosen here" added +93 (every context), the `/environments` help topic's
// matching correction landing on this crown too since `create.md` names
// `/environments` among its `seeAlso`: 321 120 → **321 213** (94.5%, 18 787 left).
// #1930 moved
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
// full because `create.md` names `/chats` as a `seeAlso` neighbour — 289 378 (85.1%).
// #2065 then gave a human chat message a named badge and a viewer-dependent side,
// which needed a chapter `agent-chat.md` had no equivalent of (who wrote a message,
// why badge and side answer different questions, and what the neutral icon on
// un-attributable history means): +2 572, landing in full for the same `seeAlso`
// reason — **291 950** (85.9%). #2066 then replaced the manual **Sync all agents** button with an offer the
// environment save makes, which raised the crown to **296 639** (87.2%, +4 689):
// worth noting because the ticket only *removed* a control, and yet it is the
// biggest single move in this paragraph. Two reasons, and the second is the
// durable one. The topic had to grow (+3 848) to carry the three change classes,
// the D1 safety rule and the removal warning — copy nothing on the form states
// any more. And `docs/working-environments.md` grew (+1 033) which lands on
// EVERY context, `/quickstart` included, because it is a `CORPUS_FILES` doc; on
// top of that `/quickstart` sees the topic growth in full too, since `create.md`
// names `/environments` as a `seeAlso` neighbour — so both halves hit the same
// crown and the delta on `/environments` itself is identical. #2067 then made a repository attachable to a single
// agent, documented in the two places that own the concept: `agent-chat.md` (the
// surfaces live there, so it lands on this crown in full for that same `seeAlso`
// reason) and the every-context `docs/working-environments.md` + `admin-console.md`.
// Measured as one total on the merge rather than a per-file or per-PR sum, since
// #2065 and #2067 both grow the same crown: **301 270** (88.6%, 38 730 left — the three
// individual deltas +2 572, +4 689 and +4 631 sum to the measurement exactly, which
// is how you know every branch's own number was right and only the chain was wrong). Two things worth
// carrying forward. A feature whose surfaces sit on `/chats` pays this crown twice
// over — once through the `seeAlso` link and once through whichever CORPUS_FILES
// reference doc has to agree with it. And when two PRs append to THIS paragraph in
// parallel, the auto-merge keeps both entries and leaves one figure with two
// successors: re-chain them in ticket order and re-measure, rather than trusting
// either branch's number.
// #2068 then made flow drafts private-by-default and shareable with equal rights,
// which needed an eleventh `flows.md` chapter (*Sharing a draft*) — the panel is
// where the irreversibility of sharing has to be readable. `create.md` names
// `/flows` among its `seeAlso`, so that chapter lands on this crown in full: +2 673.
// Re-measured on the merge, not summed on a stale base: main's post-#2067 crown of
// **301 270** → **303 943** (89.4%).
// The whole #2068 delta is topic-side; nothing in `CORPUS_FILES` changed here, so
// #2068 itself moved no OTHER context.
// #2081 (self-service team creation) then corrected `access-users.md` — creating
// a scope is retired, and a team can never be left without an admin — plus one
// paragraph in `users.md`: +1 082 on main's post-#2102/#1459 crown of 309 444 →
// **310 526** (91.3%). Worth knowing WHY an Access-page edit lands on the
// `/chats` crown at all: `agent-chat.md` names `/teams` among its `seeAlso`, so
// the crown-holding neighbourhood contains the Access topic even though the
// crown is not on `/teams` (whose own context is 270 418). The `users.md` half
// costs this crown nothing — `/users` is not in that neighbourhood — and nothing
// in `CORPUS_FILES` changed, so no other context moved either.
// #2085 (epic #2076 P6, D10) then dissolved the Access page: `access-users.md` was
// folded into `users.md`, `/teams` became a redirect, and the seven topics that
// named *Access* in their `seeAlso` were re-pointed at `/users` — except
// `agent-chat.md` and `team-setup.md`, where the link was DROPPED rather than
// re-pointed, because the successor surface for what it promised (adding somebody
// to a team) is the **Share…** dialog on the reader's own page and Administration
// is System-Admin-only, so re-pointing would have linked an ordinary reader at a
// page they cannot open. That is what moved the crown, and it moved it DOWN:
// `/chats` lost its `/teams` neighbour outright and fell out of first place, so
// the worst context is **`/quickstart`** again at **312 384** of 340 000 (91.9%,
// 27 616 left) — down from `/chats`' 314 511, even though this ticket's own
// `admin-console.md` + `glossary.md` rewrites (+1 038) land on EVERY context. The merged `users.md` is ~9 000
// characters bigger than either half was, but it now lands only on contexts that
// still name `/users`, none of which was near the crown. The durable point is the
// same one #1996 recorded from the other direction: a `seeAlso` edit moves the
// worst case more than the topic edit does, so read the `context` the measurement
// hands back and never assume the crown stayed where you left it.
// Re-measure rather than trust this comment —
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
