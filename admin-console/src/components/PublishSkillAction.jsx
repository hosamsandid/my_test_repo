import React, { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { PUBLISH_PATHS, publishSteps, stepVerb } from '../pages/skill-publish-view.js';

/**
 * Publish an agent's edited skill up to the team pool and/or the global pool
 * (#2180) — wired to the existing `POST /api/skills/transfer` tier-transfer
 * engine (agent→team "lifted", agent→global "promoted"). Shared by the Skills
 * page's `source:'agent'` row and the Knowledge page's private-skills panel so
 * the two surfaces cannot drift (design decision 4 of the linked issue): a
 * change to the publish flow is made once, here.
 *
 * The operator picks one of two paths (design decision 1 — both are offered):
 *   - "Publish to global": one direct agent→global transfer.
 *   - "Publish via team pool": lift to the team pool, then promote that copy
 *     to global — two sequential transfers.
 * Either path reuses the tier-transfer engine's own 409-on-collision contract:
 * a destination that already carries a skill by this name surfaces the
 * existing overwrite-confirmation pattern (design decision 2) before
 * replacing it in place.
 *
 * Props:
 *   name      skill name
 *   agentId   the agent whose workspace copy is the publish source
 *   teamId    the agent's own team pool (the "via team pool" path's landing
 *             spot, and the source of the following global promote)
 *   onPublished(result)  called after a step's terminal success/failure
 */
export default function PublishSkillAction({ name, agentId, teamId, onPublished }) {
  const [pathId, setPathId] = useState(null);   // which path is running, or null when idle
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pendingStep, setPendingStep] = useState(null); // the step awaiting an overwrite confirm
  const [done, setDone] = useState(null); // 'direct' | 'staged' — the path that finished

  async function runStep(step, steps, idx) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/skills/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(step),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && data.exists) {
          setPendingStep({ step, steps, idx });
          setBusy(false);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const next = idx + 1;
      if (next < steps.length) {
        setStepIndex(next);
        await runStep(steps[next], steps, next);
        return;
      }
      setDone(pathId);
      setBusy(false);
      onPublished?.(data);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  function start(id) {
    setPathId(id);
    setStepIndex(0);
    setDone(null);
    setError(null);
    const steps = publishSteps(id, { name, agentId, teamId });
    runStep(steps[0], steps, 0);
  }

  function confirmOverwrite() {
    if (!pendingStep) return;
    const { step, steps, idx } = pendingStep;
    setPendingStep(null);
    runStep({ ...step, onCollision: 'overwrite' }, steps, idx);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PUBLISH_PATHS.map((p) => (
          <button
            key={p.id}
            onClick={() => start(p.id)}
            disabled={busy}
            title={p.hint}
            style={btnStyle(busy)}
          >
            {busy && pathId === p.id ? `${stepVerb(publishSteps(pathId, { name, agentId, teamId })[stepIndex])}…` : p.label}
          </button>
        ))}
      </div>
      {done && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success, #2a8)' }}>Published ✓</div>}
      {error && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>{error}</div>}
      <ConfirmDialog
        open={!!pendingStep}
        title="Skill already exists at destination"
        variant="danger"
        message={`A skill named "${name}" already exists at the destination. Overwrite it with this agent's version? This replaces the entire destination skill directory.`}
        confirmLabel={busy ? 'Overwriting…' : 'Overwrite'}
        onConfirm={confirmOverwrite}
        onCancel={() => setPendingStep(null)}
      />
    </div>
  );
}

function btnStyle(disabled) {
  return {
    fontSize: 'var(--eb-text-xs)',
    padding: '3px 10px',
    borderRadius: 'var(--eb-radius-md)',
    border: '1px solid var(--eb-border-default)',
    background: 'var(--eb-bg-surface)',
    color: disabled ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
