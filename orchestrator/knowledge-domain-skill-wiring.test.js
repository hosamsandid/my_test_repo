"use strict";

// Source-reading drift guard for the #2592 domain → skill pipeline wiring in
// orchestrator.js. The pure cores (knowledge-domain-skills.js, knowledge-routing.js,
// knowledge-domains.js, knowledge-consolidation.js) are unit-tested; this file guards
// the properties that live ONLY in orchestrator.js's impure half, which cannot be
// `require`d in a unit test (same technique as pool-control-wiring.test.js):
//
//   1. In domain mode the collector runs NO lesson-named step (AC5) — the domain
//      branch is an exclusive arm of the level-3 / level-2 chain and only distils.
//   2. Only converged clusters are routed (AC7).
//   3. Auto-apply is exactly level 3 + an `auto` team>team gate (D1).
//   4. A lesson is only marked promoted through settleCoveredRows (AC8/G6) — in
//      the pipeline and when an operator accepts a domain card.
//   5. Every "skill already exists" path folds the lesson in via
//      _foldIntoExistingSkill rather than claiming it on a name match (G6).
//   6. Growing the domain list at/over budget answers 409 without the confirmation
//      flag (AC10).
//   7. Consolidate folds an accepted domain's pending lessons into its queue (AC11).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FULL_SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}
const SRC = stripComments(FULL_SRC);

function fn(name, { async: isAsync = false } = {}) {
  const marker = `${isAsync ? "async " : ""}function ${name}(`;
  const start = SRC.indexOf(marker);
  assert.ok(start > 0, `function ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  const end = nextFn === -1 ? SRC.length : start + 1 + nextFn;
  return SRC.slice(start, end);
}

// The body of an `if (req.method === ... && req.url === '<url>')` internal route.
function route(url) {
  const start = SRC.indexOf(`req.url === '${url}'`);
  assert.ok(start > 0, `route ${url} not found — this guard needs re-pointing`);
  const next = SRC.indexOf("if (req.method ===", start + 1);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

test("the guard is not vacuous: every function under test survives the comment strip", () => {
  assert.ok(fn("_runDomainSkillPipeline", { async: true }).length > 1000);
  assert.ok(fn("_foldIntoExistingSkill").length > 200);
  assert.ok(route("/internal/knowledge/consolidation").length > 1000);
});

test("domain mode is an exclusive arm: no lesson-named promote/extend/raise step runs (AC5)", () => {
  const i = SRC.indexOf("if (domainMode) {");
  assert.ok(i > 0, "the domain-mode branch must exist");
  const l3 = SRC.indexOf("} else if (level >= 3) {", i);
  const l2 = SRC.indexOf("} else if (level >= 2) {", i);
  assert.ok(l3 > i && l2 > l3, "level-3 and level-2 lesson paths must be else-arms of the domain branch");
  const domainArm = SRC.slice(i, l3);
  for (const step of ["autoPromoteStep", "autoExtendStep", "autoPromoteThemesStep", "raiseRelatedSuggestions", "planNewSuggestions"]) {
    assert.ok(!domainArm.includes(step), `${step} must not run in domain mode`);
  }
  assert.match(domainArm, /autoDistillStep\(/, "distillation still runs in domain mode (AC9)");
});

test("the pipeline routes only converged clusters (AC7)", () => {
  const src = fn("_runDomainSkillPipeline", { async: true });
  assert.match(src, /\.filter\(\(c\) => c && knowledgeConvergence\.crossesConvergence\(c, convergenceThreshold\)\)/);
});

test("auto-apply is level 3 + an auto team>team gate, otherwise one card per domain (D1)", () => {
  const src = fn("_runDomainSkillPipeline", { async: true });
  assert.match(src, /const autoApply = level >= 3 && gates\["team>team"\] === "auto";/);
  assert.match(src, /knowledgeDomainSkills\.planDomainSkillWork\(/);
  assert.match(src, /knowledgeDomainSkills\.reconcileDomainCards\(/);
  assert.match(src, /threshold: domainSkillThreshold/, "the per-team first-skill threshold is honoured (AC12)");
});

test("lessons are settled only through provenance coverage (AC8, G6)", () => {
  const src = fn("_runDomainSkillPipeline", { async: true });
  assert.match(src, /knowledgeDomainSkills\.settleCoveredRows\(readKnowledgeCandidates\(teamId\), item\.bundle\.lessonIds, res\.entryIds/);
  assert.ok(!/status: ["']promoted["']/.test(src), "the pipeline never sets promoted directly");
  assert.match(SRC, /knowledgeDomainSkills\.settleCoveredRows\(next, card\.lessonIds, provIds/, "accepting a domain card settles by provenance");
});

test("an existing same-named skill is folded into, never claimed by name (G6)", () => {
  for (const name of ["autoPromoteStep", "autoPromoteThemesStep", "autoExtendStep"]) {
    const isAsync = SRC.includes(`async function ${name}(`);
    assert.match(fn(name, { async: isAsync }), /_foldIntoExistingSkill\(/, `${name} must fold into an existing skill`);
  }
  assert.match(fn("_foldIntoExistingSkill"), /knowledgeDomainSkills\.foldIntoSkill\(/);
});

test("growing the domain list at/over budget needs the confirmation flag (AC10)", () => {
  const src = route("/internal/knowledge/domains");
  const guard = src.indexOf("if (p.overBudgetConfirmed !== true) {");
  assert.ok(guard > 0, "the unconfirmed path must be gated");
  const gate = src.slice(guard, guard + 600);
  assert.match(gate, /knowledgeDomains\.domainGrowthNeedsConfirmation\(doc, op, p, budgetOf\(\)\)/);
  assert.match(gate, /res\.writeHead\(409/);
  assert.match(gate, /error: 'over-budget'/);
  assert.match(gate, /return;/, "nothing is written without confirmation");
});

test("Consolidate: accepting a domain queues its pending lessons and ignores non-lesson rows (AC11)", () => {
  const src = route("/internal/knowledge/consolidation");
  assert.match(src, /!CONSOLIDATION_NON_LESSON_SOURCES\.has\(c\.source\)/, "buildPlan skips domain cards / proposals / decay");
  assert.match(src, /stepStatus === 'accepted' && dom && Array\.isArray\(dom\.candidateIds\)/);
  assert.match(src, /knowledgeDomainSkills\.queuedRow\(r, \{ domainId: dom\.domainId, via: 'consolidation', now \}\)/);
  assert.match(src, /runConvergenceCollector\(teamId, null, \{ force: true \}\)/);
  assert.match(SRC, /const CONSOLIDATION_NON_LESSON_SOURCES = new Set\(\[knowledgeDomainSkills\.DOMAIN_CARD_SOURCE, 'domain-proposal', 'decay'\]\);/);
});

test("in domain mode the digest gate does not run and the pipeline sees every converged cluster (review B1)", () => {
  const collector = SRC.slice(SRC.indexOf("let domainMode = false;"), SRC.indexOf("const themeClusters ="));
  assert.match(collector, /domainMode = domains\.length > 0;/);
  assert.match(collector, /if \(digestRouting && !domainMode\) \{/, "planDigestRouting is skipped in domain mode");
  assert.ok(collector.indexOf("domainMode = domains.length > 0;") < collector.indexOf("planDigestRouting("),
    "domains are resolved before the digest gate");
  assert.match(collector, /_runDomainSkillPipeline\(teamId, env, domains, eligibleClusters, \{/,
    "the pipeline gets eligibleClusters, not the digest-filtered candidateClusters");
});

test("a grown cluster replaces its older pending row in the pipeline (review B2)", () => {
  const src = fn("_runDomainSkillPipeline", { async: true });
  assert.match(src, /for \(const g of inputs\.regrown\) \{\s*byId\.set\(g\.candidate\.id, knowledgeDomainSkills\.queuedRow\(g\.candidate, \{ domainId: g\.domainId, via: g\.via, now \}\)\);/);
  assert.match(src, /for \(const s of inputs\.supersede\) \{[\s\S]*?status: "superseded", supersededBy: s\.supersededBy/);
});
