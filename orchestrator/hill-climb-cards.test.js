'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CARD_CLASSES,
  validateCard,
  normalizeCard,
  heuristicFindings,
  describeTrigger,
  supersedeVanishedTriggerCards,
  recurringAnomalyIdentities,
  mergeCards,
  buildAnalystDigest,
  redactSecrets,
  cardId,
} = require('./hill-climb-cards');

// A minimally valid card for tweaking in the validator tests.
function goodCard(over = {}) {
  return {
    class: 'trigger-hygiene',
    object: { kind: 'trigger', id: 'dev/nightly' },
    title: 'Trigger never fired',
    targetMetric: 'waste.wasteRuns',
    evidence: [{ type: 'metric', ref: 'metrics.deadConfig.zeroFireTriggers', value: 'dev/nightly' }],
    ...over,
  };
}

// ─── validateCard (AC: a card without a target metric or evidence is rejected) ─

test('validateCard accepts a well-formed card', () => {
  assert.equal(validateCard(goodCard()).ok, true);
});

test('validateCard rejects a card with no target metric', () => {
  const r = validateCard(goodCard({ targetMetric: '' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /targetMetric/);
});

test('validateCard rejects a card missing targetMetric entirely', () => {
  const c = goodCard();
  delete c.targetMetric;
  assert.equal(validateCard(c).ok, false);
});

test('validateCard rejects a card with empty evidence', () => {
  const r = validateCard(goodCard({ evidence: [] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /evidence/);
});

test('validateCard rejects evidence entries with neither ref nor value', () => {
  const r = validateCard(goodCard({ evidence: [{ type: 'metric' }] }));
  assert.equal(r.ok, false);
});

test('validateCard rejects an unknown class', () => {
  assert.equal(validateCard(goodCard({ class: 'refactor' })).ok, false);
});

test('validateCard rejects a card with no object', () => {
  const c = goodCard();
  delete c.object;
  assert.equal(validateCard(c).ok, false);
});

// ─── normalizeCard ───────────────────────────────────────────────────────────

test('normalizeCard fills defaults and produces a valid card', () => {
  const { ok, card } = normalizeCard(goodCard(), { teamId: 'acme', now: 0 });
  assert.equal(ok, true);
  assert.equal(card.status, 'open');
  assert.equal(card.source, 'heuristic');
  assert.equal(card.teamId, 'acme');
  assert.equal(card.riskClass, 'low'); // trigger-hygiene default
  assert.ok(card.applyPath && card.applyPath.via);
  assert.equal(card.id, cardId('acme', 'trigger-hygiene', { kind: 'trigger', id: 'dev/nightly' }));
});

test('normalizeCard id is stable across identical (team,class,object)', () => {
  const a = normalizeCard(goodCard(), { teamId: 'acme' }).card;
  const b = normalizeCard(goodCard({ title: 'different title' }), { teamId: 'acme' }).card;
  assert.equal(a.id, b.id); // content-blind: same object → same id
});

test('normalizeCard rejects a raw card that fails validation', () => {
  assert.equal(normalizeCard(goodCard({ targetMetric: '' })).ok, false);
});

// ─── heuristicFindings (AC: provider-less install still produces cards) ────────

const SNAPSHOT = {
  teamId: 'acme',
  window: { from: '2026-07-27T00:00:00Z', to: '2026-08-03T00:00:00Z', fromMs: Date.parse('2026-07-27T00:00:00Z'), toMs: Date.parse('2026-08-03T00:00:00Z') },
  totalRuns: 40,
  insufficientData: false,
  minRunsPerWindow: 20,
  metrics: {
    runSuccessRate: 0.8,
    reworkRatio: 0.2,
    anomalyRecurrence: 1,
    waste: { wasteRuns: 5, failedRunTokens: 1000, throttleDrops: 0, digestFolds: 0 },
    deadConfig: {
      zeroFireTriggers: [{ agentId: 'dev', triggerId: 'nightly' }, { agentId: 'qa', triggerId: 'stale' }],
      unconsumedEmits: ['needs-triage'],
    },
  },
};

test('heuristicFindings emits deterministic cards with no provider', () => {
  const cards = heuristicFindings(SNAPSHOT, { now: 0 });
  // 2 zero-fire triggers + 1 unconsumed emit + 1 team-level recurrence fallback
  assert.equal(cards.length, 4);
  for (const c of cards) {
    assert.equal(validateCard(c).ok, true, `heuristic card must be valid: ${JSON.stringify(c)}`);
    assert.equal(c.source, 'heuristic');
    assert.ok(c.targetMetric);
    assert.ok(c.evidence.length >= 1);
  }
  const classes = cards.map((c) => c.class).sort();
  assert.deepEqual(classes, ['flow-wiring', 'flow-wiring', 'trigger-hygiene', 'trigger-hygiene']);
});

test('heuristicFindings raises no zero-fire deletion card below the data floor (#2710)', () => {
  const thin = { ...SNAPSHOT, totalRuns: 0, insufficientData: true };
  const cards = heuristicFindings(thin, { now: 0 });
  assert.equal(cards.filter((c) => c.class === 'trigger-hygiene').length, 0);
  // The other dead-config findings are unaffected by the floor.
  assert.ok(cards.some((c) => c.object.kind === 'label'));
});

test('heuristicFindings titles a zero-fire card by agent, event and label (#2710)', () => {
  const snap = { ...SNAPSHOT, metrics: { ...SNAPSHOT.metrics, deadConfig: {
    zeroFireTriggers: [{ agentId: 'acme-rev', triggerId: 't1790817163431', agentName: 'Reviewer',
      type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-for-review' }],
    unconsumedEmits: [],
  } } };
  const card = heuristicFindings(snap, { now: 0 }).find((c) => c.class === 'trigger-hygiene');
  assert.equal(card.title, "Reviewer's listener for 'ready-for-review' (issues.labeled) has not fired this window");
  assert.doesNotMatch(card.title, /t1790817163431/);
  assert.match(card.detail, /t1790817163431/); // the id stays available in the detail
  assert.equal(card.object.id, 'acme-rev/t1790817163431');
});

test('describeTrigger falls back sensibly without a label', () => {
  assert.equal(describeTrigger({ agentId: 'dev', triggerId: 't', events: ['pull_request.opened'] }), "dev's pull_request.opened trigger");
  assert.equal(describeTrigger({ agentId: 'dev', agentName: 'Dev', triggerId: 't', type: 'cron' }), "Dev's scheduled trigger");
  assert.equal(describeTrigger({ agentId: 'dev', triggerId: 't', type: 'http' }), "dev's http trigger");
  assert.equal(describeTrigger({ agentId: 'dev', triggerId: 'nightly' }), "dev's trigger 'nightly'");
});

test('supersedeVanishedTriggerCards retires open cards whose trigger is gone (#2710)', () => {
  const gone = normalizeCard(goodCard(), { teamId: 'acme', now: 1000 }).card;
  const live = normalizeCard(goodCard({ object: { kind: 'trigger', id: 'dev/live' } }), { teamId: 'acme', now: 1000 }).card;
  const applied = normalizeCard(goodCard({ object: { kind: 'trigger', id: 'dev/applied' } }), { teamId: 'acme', now: 1000 }).card;
  applied.status = 'applied';
  const label = normalizeCard(goodCard({ class: 'flow-wiring', object: { kind: 'label', id: 'x' } }), { teamId: 'acme', now: 1000 }).card;
  const cards = [gone, live, applied, label];
  const n = supersedeVanishedTriggerCards(cards, ['dev/live'], { now: 2000 });
  assert.equal(n, 1);
  assert.equal(gone.status, 'superseded');
  assert.equal(gone.updatedAt, new Date(2000).toISOString());
  assert.equal(live.status, 'open');
  assert.equal(applied.status, 'applied'); // terminal history is untouched
  assert.equal(label.status, 'open'); // only trigger objects are checked
  // A superseded card no longer blocks a fresh card for the same object.
  const again = normalizeCard(goodCard(), { teamId: 'acme', now: 3000 }).card;
  const r = mergeCards(cards, [again], { now: 3000 });
  assert.equal(r.added, 1);
});

test('mergeCards refreshes the title of a re-detected open card', () => {
  const first = mergeCards([], [normalizeCard(goodCard({ title: "Trigger 'nightly' has not fired" }), { teamId: 'acme', now: 1000 }).card], { now: 1000 });
  const again = normalizeCard(goodCard({ title: "Dev's scheduled trigger has not fired this window" }), { teamId: 'acme', now: 2000 }).card;
  const second = mergeCards(first.cards, [again], { now: 2000 });
  assert.equal(second.bumped, 1);
  assert.equal(second.cards[0].title, "Dev's scheduled trigger has not fired this window");
});

test('heuristicFindings keys recurrence cards to the object when raw history is given', () => {
  const anomalyHistory = [
    { ts: '2026-07-28T00:00:00Z', anomalies: [{ class: 'dead-end', objectId: 'label:needs-triage' }] },
    { ts: '2026-07-30T00:00:00Z', anomalies: [{ class: 'dead-end', objectId: 'label:needs-triage' }] },
  ];
  const cards = heuristicFindings(SNAPSHOT, { now: 0, anomalyHistory });
  const rec = cards.find((c) => c.object.kind === 'anomaly');
  assert.ok(rec, 'expected an object-keyed anomaly card');
  assert.match(rec.title, /dead-end/);
  assert.equal(rec.targetMetric, 'metrics.anomalyRecurrence');
});

test('recurringAnomalyIdentities needs ≥2 sightings', () => {
  const from = 0;
  const to = Date.parse('2026-08-03T00:00:00Z');
  const once = [{ ts: '2026-07-28T00:00:00Z', anomalies: [{ class: 'x', objectId: 'a' }] }];
  assert.equal(recurringAnomalyIdentities(once, from, to).length, 0);
  const twice = once.concat([{ ts: '2026-07-29T00:00:00Z', anomalies: [{ class: 'x', objectId: 'a' }] }]);
  assert.equal(recurringAnomalyIdentities(twice, from, to).length, 1);
});

// ─── mergeCards (AC: budget + dedup) ───────────────────────────────────────────

function findings(n, cardClass = 'trigger-hygiene') {
  return Array.from({ length: n }, (_, i) => normalizeCard({
    class: cardClass,
    object: { kind: 'trigger', id: `dev/t${i}` },
    title: `trigger t${i}`,
    targetMetric: 'waste.wasteRuns',
    evidence: [{ type: 'metric', ref: 'zeroFire', value: `dev/t${i}` }],
  }, { teamId: 'acme', now: 1000 }).card);
}

test('mergeCards caps new cards at maxCardsPerPass and defers the rest', () => {
  const r = mergeCards([], findings(8), { maxCardsPerPass: 5, now: 1000, windowDays: 7 });
  assert.equal(r.added, 5);
  assert.equal(r.deferredBudget, 3);
  assert.equal(r.deferred, 3);
  assert.equal(r.cards.length, 5);
});

test('mergeCards bumps a re-detected finding instead of duplicating', () => {
  const first = mergeCards([], findings(1), { maxCardsPerPass: 5, now: 1000 });
  assert.equal(first.added, 1);
  // Same object+class again next pass, with a fresh evidence entry.
  const again = normalizeCard({
    class: 'trigger-hygiene',
    object: { kind: 'trigger', id: 'dev/t0' },
    title: 'trigger t0',
    targetMetric: 'waste.wasteRuns',
    evidence: [{ type: 'metric', ref: 'zeroFire', value: 'dev/t0-second-sighting' }],
  }, { teamId: 'acme', now: 2000 }).card;
  const second = mergeCards(first.cards, [again], { maxCardsPerPass: 5, now: 2000 });
  assert.equal(second.added, 0);
  assert.equal(second.bumped, 1);
  assert.equal(second.cards.length, 1);
  assert.equal(second.cards[0].seen, 2);
  assert.equal(second.cards[0].evidence.length, 2); // evidence grew, no dup card
});

test('mergeCards does not duplicate evidence on an identical re-detection', () => {
  const first = mergeCards([], findings(1), { now: 1000 });
  const second = mergeCards(first.cards, findings(1), { now: 2000 });
  assert.equal(second.bumped, 1);
  assert.equal(second.cards[0].evidence.length, 1); // identical evidence deduped
});

test('mergeCards defers a re-detection during an applied cooldown', () => {
  const applied = normalizeCard(goodCard(), { teamId: 'acme', now: 1000 }).card;
  applied.status = 'applied';
  applied.cooldownUntil = new Date(5000).toISOString();
  const inc = normalizeCard(goodCard(), { teamId: 'acme', now: 2000 }).card;
  const r = mergeCards([applied], [inc], { now: 2000 });
  assert.equal(r.added, 0);
  assert.equal(r.bumped, 0);
  assert.equal(r.deferredCooldown, 1);
});

test('mergeCards respects a dismissed card and does not re-raise', () => {
  const dismissed = normalizeCard(goodCard(), { teamId: 'acme', now: 1000 }).card;
  dismissed.status = 'dismissed';
  const inc = normalizeCard(goodCard(), { teamId: 'acme', now: 2000 }).card;
  const r = mergeCards([dismissed], [inc], { now: 2000 });
  assert.equal(r.added, 0);
  assert.equal(r.deferred, 1);
});

test('mergeCards raises a fresh card once the applied cooldown has expired', () => {
  const applied = normalizeCard(goodCard(), { teamId: 'acme', now: 1000 }).card;
  applied.status = 'applied';
  applied.cooldownUntil = new Date(2000).toISOString();
  const inc = normalizeCard(goodCard(), { teamId: 'acme', now: 9000 }).card;
  const r = mergeCards([applied], [inc], { now: 9000 });
  assert.equal(r.added, 1); // cooldown over → loop may raise again
});

test('mergeCards defers a re-detection while a rollback is pending (regressed)', () => {
  const regressed = normalizeCard(goodCard(), { teamId: 'acme', now: 1000 }).card;
  regressed.status = 'regressed';
  const inc = normalizeCard(goodCard(), { teamId: 'acme', now: 2000 }).card;
  const r = mergeCards([regressed], [inc], { now: 2000 });
  assert.equal(r.added, 0, 'a rollback is pending — do not duplicate the finding');
  assert.equal(r.deferredCooldown, 1);
});

test('mergeCards: a rolled-back object re-enters detection only after a fresh window (#1226 AC)', () => {
  const rolledBack = normalizeCard(goodCard(), { teamId: 'acme', now: 1000 }).card;
  rolledBack.status = 'rolled-back';
  rolledBack.cooldownUntil = new Date(5000).toISOString();
  const inc = normalizeCard(goodCard(), { teamId: 'acme', now: 2000 }).card;
  // Within the fresh window → deferred, never re-raised.
  const during = mergeCards([rolledBack], [inc], { now: 2000 });
  assert.equal(during.added, 0);
  assert.equal(during.deferredCooldown, 1);
  // After the fresh window → the object may be detected again.
  const after = mergeCards([rolledBack], [inc], { now: 9000 });
  assert.equal(after.added, 1);
});

// ─── buildAnalystDigest + redactSecrets (AC: input contains no raw secrets) ────

test('redactSecrets scrubs common credential shapes', () => {
  const samples = {
    ghpat: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    fine: 'github_pat_11ABCDE0123456789_abcdefghijklmnopqrstuvwxyz',
    anth: 'sk-ant-api03-abcdef_ghijklmno-pqrstuv',
    bearer: 'Authorization: Bearer abcdef123456789token',
    pw: 'password=SuperSecret123',
    pem: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----',
  };
  for (const [name, s] of Object.entries(samples)) {
    const out = redactSecrets(s);
    assert.match(out, /REDACTED/, `${name} should be redacted`);
  }
  assert.doesNotMatch(redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), /ghp_ABCDEF/);
});

test('buildAnalystDigest carries aggregates and no raw secrets (seeded fixture)', () => {
  const findings = heuristicFindings(SNAPSHOT, { now: 0 });
  const seeded = [
    { ref: 'session:corr-1', text: 'run failed; env had GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and it 403d' },
    { ref: 'session:corr-2', text: 'Authorization: Bearer sk-ant-api03-abcdefghijklmnop was rejected' },
  ];
  const digest = buildAnalystDigest(SNAPSHOT, { findings, evidenceExcerpts: seeded });
  const json = JSON.stringify(digest);
  // aggregates present
  assert.equal(digest.totalRuns, 40);
  assert.ok(digest.metrics.deadConfig);
  assert.ok(digest.findings.length >= 1);
  // no raw secret survives anywhere in the serialized digest
  assert.doesNotMatch(json, /ghp_ABCDEF/);
  assert.doesNotMatch(json, /sk-ant-api03-abcdef/);
  assert.match(json, /REDACTED/);
});

test('buildAnalystDigest honours the token budget by dropping excerpts', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ ref: `e${i}`, text: 'x'.repeat(500) }));
  const digest = buildAnalystDigest(SNAPSHOT, { evidenceExcerpts: big, maxTokens: 500 });
  assert.ok(JSON.stringify(digest).length <= 500 * 4 + 200, 'digest respects the char cap');
});

test('exported card classes match the concept catalog', () => {
  assert.deepEqual(CARD_CLASSES, [
    'prompt-improvement', 'flow-wiring', 'threshold-tuning', 'trigger-hygiene', 'knowledge-handoff',
  ]);
});
