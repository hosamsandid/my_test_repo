// Shared skill-rollout counting + status wording (#774).
//
// ONE counting basis for skill activation, used by BOTH the Knowledge-page
// status pill (rolloutStatus, below) and the post-activate flash
// (summarizeActivation in knowledge-activation-view.js, which delegates its
// numbers here) — so the two can never again disagree: the reported problem was
// a "4/4" flash next to a "4/6" badge for the same situation, because the badge
// counted seed manifests against *all* member configs (incl. stubs + override
// members) while the flash counted only the fan-out members.
//
// The single basis: the denominator is the set of members that *should* receive
// the skill — materialized (non-stub) AND non-override. Stubs and override
// members are counted separately and *annotated* in the health sentence, never
// folded into the failure count or the denominator.
//
// Side-effect-free so it can be unit-tested with node:test, mirroring the
// knowledge-activation-view.js / pending-queue-view.js pattern.

export const ROLLOUT_CLASS = {
  INSTALLED: 'installed', // the skill is in this member's workspace
  PENDING: 'pending',     // granted but not yet synced into the workspace
  OVERRIDE: 'override',   // member keeps its own skill list (excluded)
  STUB: 'stub',           // member has no workspace yet (not materialized)
  INACTIVE: 'inactive',   // not granted to this member
  FAILED: 'failed',       // a sync was attempted and errored
};

// Graph overlay member state (api.js augmentSkillActivation) → rollout class.
export function classifyMemberState(state) {
  switch (String(state || '').trim()) {
    case 'active': return ROLLOUT_CLASS.INSTALLED;
    case 'pending': return ROLLOUT_CLASS.PENDING;
    case 'excluded-override': return ROLLOUT_CLASS.OVERRIDE;
    case 'stub': return ROLLOUT_CLASS.STUB;
    default: return ROLLOUT_CLASS.INACTIVE;
  }
}

// Per-member sync RESULT (activate / deactivate / "Sync now" fan-out) → rollout
// class. The status strings the orchestrator emits (_syncSkillIntoWorkspace /
// setTeamSkillActive): a real sync succeeded/was neutral, or errored.
const SUCCESS_RE = /^(seeded|removed|synced|active)$/i;
const STUB_RE = /^stub$/i;
const OVERRIDE_RE = /^(skipped-override|skip|excluded|excluded-override)$/i;
export function classifyMemberStatus(m) {
  const st = String((m && m.status) || '').trim();
  if (SUCCESS_RE.test(st)) return ROLLOUT_CLASS.INSTALLED;
  if (STUB_RE.test(st)) return ROLLOUT_CLASS.STUB;
  if (OVERRIDE_RE.test(st)) return ROLLOUT_CLASS.OVERRIDE;
  return ROLLOUT_CLASS.FAILED;
}

// The single counting basis. `classes` is a list of ROLLOUT_CLASS values
// (from either classifyMemberState or classifyMemberStatus). `target` is the
// denominator everywhere: the members a rollout should actually reach.
export function tallyRollout(classes) {
  const cs = Array.isArray(classes) ? classes : [];
  const n = (k) => cs.filter(c => c === k).length;
  const installed = n(ROLLOUT_CLASS.INSTALLED);
  const pending = n(ROLLOUT_CLASS.PENDING);
  const failed = n(ROLLOUT_CLASS.FAILED);
  const overrides = n(ROLLOUT_CLASS.OVERRIDE);
  const stubs = n(ROLLOUT_CLASS.STUB);
  const inactive = n(ROLLOUT_CLASS.INACTIVE);
  // Members a rollout should actually reach: materialized, non-override — i.e.
  // everything except stubs and override members.
  const target = installed + pending + failed;
  return { installed, pending, failed, overrides, stubs, inactive, target, total: cs.length };
}

function pluralAgents(n) { return `${n} agent${n === 1 ? '' : 's'}`; }

// Override + stub members are annotated, never counted as failures (#774 §3).
function annotations(counts) {
  const out = [];
  if (counts.overrides) {
    out.push(`${pluralAgents(counts.overrides)} keep${counts.overrides === 1 ? 's' : ''} its own skill list`);
  }
  if (counts.stubs) {
    out.push(`${counts.stubs} not materialized yet`);
  }
  return out;
}

// The health sentence for an *active* skill (#774 §3 wording map). Examples:
//   "Installed on all 10 agents"
//   "Installing — 8 of 10, 2 pending"
//   "Installed on all 9 agents · 1 agent keeps its own skill list"
//   "⚠ Source file missing — can’t be installed"
export function healthSentence(counts, activation) {
  if (activation && activation.sourceMissing) return '⚠ Source file missing — can’t be installed';
  const annot = annotations(counts);
  let base;
  if (counts.target === 0) {
    base = annot.length ? 'Not installed on any agent yet' : 'In use — no agents to install onto yet';
  } else if (counts.installed >= counts.target) {
    base = `Installed on all ${pluralAgents(counts.target)}`;
  } else {
    const pend = counts.pending || (counts.target - counts.installed);
    base = `Installing — ${counts.installed} of ${counts.target}, ${pend} pending`;
  }
  return annot.length ? `${base} · ${annot.join(' · ')}` : base;
}

// Tone drives the pill/sentence colour: 'success' | 'warning' | 'error' | 'muted'.
export function healthTone(counts, activation) {
  if (activation && activation.sourceMissing) return 'error';
  if (counts.target === 0) return 'muted';
  return counts.installed >= counts.target ? 'success' : 'warning';
}

// Human-readable status for a skill node's activation overlay: one pill
// (Ready | In use) + a health sentence (#774 AC4). Returns null when there is
// no activation info to show.
export function rolloutStatus(activation) {
  if (!activation) return null;
  if (!activation.active) {
    return {
      pill: 'Ready',
      tone: 'muted',
      sentence: 'In the team library — not in use yet.',
      counts: tallyRollout([]),
    };
  }
  const counts = tallyRollout((activation.members || []).map(m => classifyMemberState(m.state)));
  return {
    pill: 'In use',
    tone: healthTone(counts, activation),
    sentence: healthSentence(counts, activation),
    counts,
  };
}
