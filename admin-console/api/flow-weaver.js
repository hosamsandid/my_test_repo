'use strict';

// ─── Flow-Weaver (#421) ──────────────────────────────────────────────────────
//
// Deterministic, pure wiring engine: turns *ordered stages + selected roles*
// into a complete, gap-free `processTemplateVersion: 1` bundle. Deliberately
// NOT an LLM — wiring must be reproducible and guaranteeable; LLM assistance is
// limited to prompts/suggestions (#423).
//
// Input roles are catalog templates (or template-shaped inline roles, #423)
// carrying the catalog-v2 surface (#420): `patternRole`, `ports`, `intrinsic`
// trigger flags. The weaver binds the abstract slots to concrete partners and
// generates the labels, channels and triggers:
//
//   stage chain    exit of stage n (hand-over issue) → entry of stage n+1,
//                  via an issue channel labelled `<prefix(n)>:approved` with a
//                  human gate by default (opt-out per producing stage).
//   intra-stage    Scout → `<prefix>:author-go` → Author → PR channel →
//                  Companion; escalation Author → `<prefix>:escalate` →
//                  Companion → `<prefix>:author-go`.
//   gap rules      no companion → review/feedback/escalation/stage-exit duties
//                  merge into the Author (wiring-notes block); no scout →
//                  readiness check becomes the Author's step 1; passive stages
//                  (standalone roles only) are skipped by the chain.
//
// Contract: the woven bundle validates (validateProcessTemplate) and renders
// with ZERO error and ZERO warning lints (info allowed) — asserted in
// flow-weaver.test.js. Every applied gap rule is reported in `notes` so the
// wizard (#422) can explain what was auto-compensated.

const { normalizeTemplatePorts, intrinsicTriggers } = require('./catalog-ports');
const { validateProcessTemplate } = require('./process-template');

const GENERIC_PATTERN_IDS = { scout: 'scout', 'stage-author': 'author', 'stage-companion': 'companion' };

const WEAVER_MARK_START = '<!-- weaver:start -->';
const WEAVER_MARK_END = '<!-- weaver:end -->';

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Replace weave-time tokens ({{stageName}}, {{stagePrefix}}). Materialise-time
// tokens ({{teamName}}, {{repoFullName}}, …) stay untouched for POST /api/teams.
function renderStageVars(text, vars) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\{\{stageName\}\}/g, vars.stageName)
    .replace(/\{\{stagePrefix\}\}/g, vars.stagePrefix);
}

function stripWeaverBlock(text) {
  if (typeof text !== 'string' || !text.includes(WEAVER_MARK_START)) return typeof text === 'string' ? text : '';
  return text.replace(new RegExp(`\\n*${WEAVER_MARK_START}[\\s\\S]*?${WEAVER_MARK_END}\\n*`, 'g'), '').trimEnd();
}

function weaverBlock(lines) {
  if (!lines.length) return '';
  return `${WEAVER_MARK_START}\n\n## Wiring notes\n\n${lines.map(l => `- ${l}`).join('\n')}\n\n${WEAVER_MARK_END}`;
}

// ── generated trigger prompts ───────────────────────────────────────────────

function authorWakePrompt(stageName, { authorGo, escalate }) {
  const blocked = escalate
    ? `4. If you are blocked (contradictory input, missing decisions above your authority): apply \`${escalate}\` to the issue, describe the blocker in a comment, stop.`
    : '4. If you are blocked (contradictory input, missing decisions above your authority): describe the blocker in an issue comment and ask the humans directly — this stage has no escalation broker.';
  return [
    `The label \`${authorGo}\` was added to an issue in \`{{repoFullName}}\` (payload above) — the ${stageName} stage's work on it is released to you.`,
    '',
    "1. `git pull`, read the issue, its acceptance criteria and any 'Evidence' comment.",
    `2. Produce the ${stageName} stage's work product on a feature branch.`,
    '3. Commit via `gh-as-agent commit`, push, and open a PR referencing the issue (write the body to a file, `gh-as-agent stamp <file>`, then `gh pr create`).',
    blocked,
    '',
    'Reply `[PASS]` if there is nothing to do.',
  ].join('\n');
}

function reworkPrompt(stageName) {
  return [
    `A review was submitted on a PR in \`{{repoFullName}}\` (payload above). If it is not one of YOUR ${stageName} PRs, reply \`[PASS]\`.`,
    '',
    '1. `git pull`, check out the PR branch, read every review comment.',
    '2. Address each point: fix the work, or reply explaining why not.',
    '3. Commit via `gh-as-agent commit`, push, and summarise what changed in a PR comment.',
    '',
    'Reply `[PASS]` if there is nothing to do.',
  ].join('\n');
}

function escalateWakePrompt(stageName, { authorGo, escalate }) {
  return [
    `The label \`${escalate}\` was added to an issue in \`{{repoFullName}}\` (payload above) — the ${stageName} Author is blocked.`,
    '',
    '1. Read the blocker description on the issue.',
    '2. Gather what is needed to unblock: ask the humans concrete questions in the issue, propose options with a recommendation.',
    `3. Once the decision is clear, summarise it in a comment, remove \`${escalate}\`, and re-apply \`${authorGo}\` so the Author continues.`,
    '',
    'Use `gh-as-agent` for all GitHub actions. Reply `[PASS]` if there is nothing to do.',
  ].join('\n');
}

function humanFeedbackPrompt(stageName, { authorGo }) {
  return [
    `A human commented / reviewed / edited something in \`{{repoFullName}}\` (payload above). Only act if it concerns the ${stageName} stage's issues or PRs — otherwise reply \`[PASS]\`.`,
    '',
    '1. Read the feedback in context.',
    `2. If the work must change: distil the feedback into concrete work items in a comment and re-apply \`${authorGo}\` to the issue.`,
    '3. If it is a question: answer it in a comment.',
    '4. If it is merely informational: acknowledge briefly or `[PASS]`.',
    '',
    'Use `gh-as-agent` for all GitHub actions.',
  ].join('\n');
}

// ── input normalisation ─────────────────────────────────────────────────────

function normalizeInput({ name, stages, options }) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('name required');
  if (!Array.isArray(stages) || stages.length === 0) throw new Error('stages must be a non-empty array');
  const seenStages = new Set();
  const seenPrefixes = new Set();
  const out = stages.map((s, i) => {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) throw new Error(`stage ${i}: name required`);
    const stageName = s.name.trim();
    if (seenStages.has(stageName)) throw new Error(`duplicate stage name: ${stageName}`);
    seenStages.add(stageName);
    let prefix = typeof s.prefix === 'string' && s.prefix.trim() ? slugify(s.prefix) : slugify(stageName);
    if (!prefix) prefix = `stage-${i + 1}`;
    while (seenPrefixes.has(prefix)) prefix = `${prefix}-${i + 1}`;
    seenPrefixes.add(prefix);
    if (!Array.isArray(s.roles)) throw new Error(`stage ${stageName}: roles must be an array`);
    return { name: stageName, prefix, roles: s.roles };
  });
  const humanGates = options && options.humanGates !== undefined ? options.humanGates : true;
  return { name: name.trim(), stages: out, humanGates };
}

function gateEnabled(humanGates, producingStageName) {
  if (humanGates === false) return false;
  if (humanGates && typeof humanGates === 'object') {
    return humanGates[producingStageName] !== false;
  }
  return true;
}

// ── the weaver ───────────────────────────────────────────────────────────────

/**
 * Weave ordered stages + selected roles into a process-template bundle.
 *
 * @param {object} input
 * @param {string} input.name - process name
 * @param {Array}  input.stages - [{ name, prefix?, roles: [templateObject|inlineRole] }].
 *   Roles are template-shaped objects (the caller resolves catalog ids); inline
 *   roles (#423) carry `inline: true` so ALL their triggers are kept.
 * @param {object} [input.options] - { humanGates: true|false|{ [producingStageName]: boolean } }
 * @returns {{ bundle: object, notes: Array<{stage, rule, message}> }}
 */
function weaveProcess(input) {
  const { name, stages, humanGates } = normalizeInput(input || {});
  const notes = [];
  const note = (stage, rule, message) => notes.push({ stage, rule, message });

  // 1. Normalise every role: id assignment, ports, kept triggers, base prompt.
  const usedIds = new Set();
  const woven = stages.map(stage => {
    const vars = { stageName: stage.name, stagePrefix: stage.prefix };
    const roles = stage.roles.map(tpl => {
      if (!tpl || typeof tpl !== 'object' || typeof tpl.id !== 'string' || !tpl.id) {
        throw new Error(`stage ${stage.name}: each role needs a template object with an id`);
      }
      const v2 = normalizeTemplatePorts(tpl);
      // Generic pattern templates get stage-scoped ids (design-scout, …);
      // concrete roles keep their id unless it collides across stages.
      let id = GENERIC_PATTERN_IDS[tpl.id] ? `${stage.prefix}-${GENERIC_PATTERN_IDS[tpl.id]}` : tpl.id;
      if (usedIds.has(id)) id = `${stage.prefix}-${id}`;
      let n = 2;
      while (usedIds.has(id)) id = `${id}-${n++}`;
      usedIds.add(id);
      const kept = (tpl.inline === true ? (tpl.triggers || []) : intrinsicTriggers(tpl)).map(tr => ({
        id: tr.id,
        type: tr.type,
        enabled: tr.enabled !== false,
        ...(tr.type === 'github-event' ? {
          events: Array.isArray(tr.events) ? tr.events.slice() : [],
          // Default the origin filter so a kept trigger can never be an
          // unguarded self-trigger (lint contract).
          from: tr.from || 'any-except-self',
          ...(tr.labelFilter ? { labelFilter: renderStageVars(tr.labelFilter, vars) } : {}),
        } : {}),
        ...(tr.type === 'cron' ? { cron: tr.cron } : {}),
        ...(tr.type === 'once' ? { at: tr.at } : {}),
        ...(Array.isArray(tr.emits) && tr.emits.length ? { emits: tr.emits.map(e => renderStageVars(e, vars)) } : {}),
        ...(tr.description ? { description: tr.description } : {}),
        prompt: renderStageVars(tr.prompt || tr.promptTemplate || '', vars),
      }));
      return {
        id,
        displayName: renderStageVars(tpl.displayName || tpl.id, vars) || id,
        role: 'team-member',
        sessionPolicy: tpl.sessionPolicy === 'per-invocation' ? 'per-invocation' : 'persistent',
        stage: stage.name,
        patternRole: v2.patternRole,
        produces: { ...v2.ports.produces },
        basePrompt: renderStageVars(stripWeaverBlock(tpl.promptTemplate || tpl.systemPrompt || ''), vars),
        wiring: [],
        emits: Array.isArray(tpl.emits) ? tpl.emits.map(e => renderStageVars(e, vars)) : [],
        channels: [],
        triggers: kept,
      };
    });
    return {
      ...stage,
      roles,
      scouts: roles.filter(r => r.patternRole === 'scout'),
      authors: roles.filter(r => r.patternRole === 'author'),
      companions: roles.filter(r => r.patternRole === 'companion'),
      intakes: roles.filter(r => r.patternRole === 'intake'),
    };
  });

  const addTrigger = (role, trigger) => {
    let id = trigger.id;
    let n = 2;
    while (role.triggers.some(t => t.id === id)) id = `${trigger.id}-${n++}`;
    role.triggers.push({ ...trigger, id });
  };

  const labelRegistry = new Map(); // name -> humanGate
  const noteLabel = (label, humanGate = false) => {
    if (!labelRegistry.has(label) || humanGate) labelRegistry.set(label, humanGate);
  };

  // 2. Intra-stage wiring: Scout → author-go → Author → PR → Companion,
  //    escalation Author → escalate → Companion → author-go.
  for (const stage of woven) {
    const { scouts, authors, companions } = stage;
    if (!authors.length && !scouts.length && !companions.length) continue; // intake/standalone-only stage
    const authorGo = `${stage.prefix}:author-go`;
    const escalate = `${stage.prefix}:escalate`;
    const authorNames = authors.map(a => `**${a.displayName}**`).join(' / ') || 'the Author';

    if (!authors.length) {
      note(stage.name, 'no-author',
        `Stage "${stage.name}" has ${scouts.length ? 'a Scout' : 'a Companion'} but no Author — nothing produces the stage's work product.`);
    }

    for (const scout of scouts) {
      if (authors.length) {
        scout.emits.push(authorGo);
        scout.wiring.push(`When the incoming work is ready and your Evidence comment is posted, apply \`${authorGo}\` to the issue — that starts ${authorNames}.`);
      }
    }

    for (const author of authors) {
      if (scouts.length || companions.length) {
        addTrigger(author, {
          id: 'author-wake', type: 'github-event', enabled: true,
          events: ['issues.labeled'], labelFilter: authorGo, from: 'any-except-self',
          emits: companions.length ? [escalate] : [],
          description: `Start/continue when \`${authorGo}\` is applied`,
          prompt: authorWakePrompt(stage.name, { authorGo, escalate: companions.length ? escalate : null }),
        });
      }
      if (author.produces.pr) {
        addTrigger(author, {
          id: 'rework-on-review', type: 'github-event', enabled: true,
          events: ['pull_request_review.submitted'], from: 'any-except-self',
          description: 'Rework the PR after a review',
          prompt: reworkPrompt(stage.name),
        });
      }
      if (companions.length) {
        author.emits.push(escalate);
        author.wiring.push(`If you are blocked, apply \`${escalate}\` to the issue and describe the blocker — the ${stage.name} Companion brokers it and re-applies \`${authorGo}\` once resolved.`);
      } else {
        note(stage.name, 'no-companion',
          `No Companion in "${stage.name}" — review, feedback-routing and escalation duties are merged into ${authorNames}; there is no \`${escalate}\` loop.`);
        author.wiring.push('This stage has no Companion: when humans comment on your issues or PRs, treat their feedback as work items and address it yourself. If you are blocked, describe the blocker in an issue comment and ask the humans directly.');
      }
      if (!scouts.length) {
        note(stage.name, 'no-scout',
          `No Scout in "${stage.name}" — the readiness/gap check is merged into ${authorNames} as step 1.`);
        author.wiring.push('This stage has no Scout: before you start, do the readiness check yourself — are the incoming requirements complete, consistent, actionable? If not, comment the concrete gaps on the issue and stop instead of guessing.');
      }
    }

    for (const companion of companions) {
      for (const author of authors.filter(a => a.produces.pr)) {
        companion.channels.push({ artifact: 'pr', from: author.id });
      }
      if (authors.length) {
        companion.emits.push(authorGo);
        addTrigger(companion, {
          id: 'escalate-wake', type: 'github-event', enabled: true,
          events: ['issues.labeled'], labelFilter: escalate, from: 'any-except-self',
          description: `Broker a ${stage.name} escalation`,
          prompt: escalateWakePrompt(stage.name, { authorGo, escalate }),
        });
        companion.wiring.push(`To send work back to ${authorNames} (rework from feedback, resolved escalation), re-apply \`${authorGo}\` to the issue.`);
        noteLabel(escalate);
      }
      addTrigger(companion, {
        id: 'human-feedback', type: 'github-event', enabled: true,
        events: ['issue_comment.created', 'pull_request_review.submitted', 'pull_request_review_comment.created', 'issues.edited'],
        from: 'humans',
        description: `Route human feedback in the ${stage.name} stage`,
        prompt: humanFeedbackPrompt(stage.name, { authorGo }),
      });
    }
    if ((scouts.length || companions.length) && authors.length) noteLabel(authorGo);
  }

  // 3. Stage chain: exit of the nearest previous producing stage → entry of
  //    each consuming stage, via a human-gated (by default) issue channel.
  const entryConsumers = (stage) =>
    stage.scouts.length ? stage.scouts : stage.authors.length ? stage.authors : stage.companions;
  const exitProducer = (stage) =>
    stage.companions.find(c => c.produces.issue) || stage.companions[0]
    || stage.authors[0]
    || stage.intakes.find(r => r.produces.issue)
    || null;

  let producing = null; // { stage, role }
  for (const stage of woven) {
    const consumers = entryConsumers(stage);
    if (consumers.length && producing) {
      const label = `${producing.stage.prefix}:approved`;
      const gate = gateEnabled(humanGates, producing.stage.name);
      const producer = producing.role;
      // The producer must actually open the hand-over issue. Companions/authors
      // gain the duty (+ producesIssue); intake roles already open issues.
      if (!producer.produces.issue) {
        producer.produces.issue = true;
        producer.wiring.push(`Stage exit: when the ${producing.stage.name} work product is approved and merged, open a hand-over issue for the **${stage.name}** stage (linking the source issue and the merged work product).`);
        if (producer.patternRole === 'author') {
          note(producing.stage.name, 'exit-via-author',
            `No issue-producing Companion in "${producing.stage.name}" — the stage exit (hand-over issue) is merged into **${producer.displayName}**.`);
        }
      } else if (producer.patternRole === 'intake') {
        producer.wiring.push(`The issues you open ARE the hand-over into the **${stage.name}** stage: finish refining an issue before it is released.`);
      } else {
        producer.wiring.push(`Stage exit: open a hand-over issue for the **${stage.name}** stage when the ${producing.stage.name} work is complete.`);
      }
      producer.wiring.push(gate
        ? `Ask a human to apply \`${label}\` on the hand-over issue — **only a human applies that label**, never you. That releases the ${stage.name} stage.`
        : `Apply \`${label}\` on the hand-over issue yourself once everything is in order — that releases the ${stage.name} stage (no human gate configured on this boundary).`);
      if (!gate) {
        note(producing.stage.name, 'gate-disabled',
          `Boundary "${producing.stage.name}" → "${stage.name}" has no human gate — ${producer.displayName} releases the next stage itself.`);
      }
      for (const consumer of consumers) {
        consumer.channels.push({ artifact: 'issue', from: producer.id, label, ...(gate ? { gate: 'human' } : {}) });
        consumer.wiring.push(`Work arrives via the hand-over issue from **${producer.displayName}** once ${gate ? 'a human applies' : 'it carries'} \`${label}\`.`);
      }
      noteLabel(label, gate);
    } else if (!consumers.length && stage.roles.length && !stage.intakes.length) {
      note(stage.name, 'passive-stage',
        `Stage "${stage.name}" only has standalone roles — it reacts to external events and is skipped by the hand-over chain.`);
    }
    const p = exitProducer(stage);
    if (p) producing = { stage, role: p };
  }

  // 4. Ensure + stagger weekly self-curation for per-invocation roles.
  let curationIdx = 0;
  for (const stage of woven) {
    for (const role of stage.roles) {
      if (role.sessionPolicy !== 'per-invocation') continue;
      const minute = (5 + curationIdx * 3) % 60;
      const hour = 3 + Math.floor((5 + curationIdx * 3) / 60);
      const cron = `${minute} ${hour} * * 1`;
      const existing = role.triggers.find(t => t.type === 'cron' && t.id === 'self-curation');
      if (existing) existing.cron = cron;
      else addTrigger(role, {
        id: 'self-curation', type: 'cron', enabled: true, cron,
        description: 'Weekly memory housekeeping',
        prompt: 'Weekly memory curation of memory/log.md: consolidate contradictions, generalise issue-specifics, merge duplicates, prune stale entries. If nothing to do: [PASS].',
      });
      curationIdx++;
    }
  }

  // 5. Collect intrinsic labels into the registry too (emits + label filters).
  for (const stage of woven) {
    for (const role of stage.roles) {
      for (const e of role.emits) noteLabel(e);
      for (const t of role.triggers) {
        for (const e of (t.emits || [])) noteLabel(e);
        if (t.labelFilter) noteLabel(t.labelFilter);
      }
    }
  }

  // 6. Assemble the bundle.
  const bundle = {
    processTemplateVersion: 1,
    name,
    level: 'template',
    stages: woven.map(s => s.name),
    roles: woven.flatMap(stage => stage.roles.map(role => ({
      id: role.id,
      displayName: role.displayName,
      role: 'team-member',
      sessionPolicy: role.sessionPolicy,
      stage: role.stage,
      systemPrompt: [role.basePrompt, weaverBlock(role.wiring)].filter(Boolean).join('\n\n'),
      ...(role.emits.length ? { emits: [...new Set(role.emits)] } : {}),
      ...(role.produces.pr || role.produces.issue
        ? { github: { ...(role.produces.pr ? { producesPr: true } : {}), ...(role.produces.issue ? { producesIssue: true } : {}) } }
        : {}),
      ...(role.channels.length ? { channels: role.channels } : {}),
      triggers: role.triggers,
    }))),
    gates: [],
    labels: [...labelRegistry.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([name_, humanGate]) => ({ name: name_, humanGate, brake: false })),
  };

  const v = validateProcessTemplate(bundle);
  if (!v.ok) throw new Error(`weaver produced an invalid bundle: ${v.error}`); // defensive — must never happen
  return { bundle, notes };
}

module.exports = { weaveProcess, WEAVER_MARK_START, WEAVER_MARK_END, stripWeaverBlock };
