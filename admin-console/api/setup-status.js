'use strict';

/* Pure helper for GET /api/setup/status.
 *
 * The first-run Setup Wizard configures only the three infrastructure
 * credentials — the Model Provider (required), plus the optional SSH key and
 * GitHub token. It no longer creates a Working Environment or a First Agent
 * (those happen later, in Team Setup). Keep this step set in lockstep with
 * STEPS in admin-console/src/pages/SetupWizard.jsx, labels included: the wizard
 * step is titled "Model Provider" (the endpoint used to mislabel it "LLM
 * Endpoint"). Extracted so the step set + completion maths are unit-testable
 * without an Express harness.
 */

/**
 * @param {{ llmCount: number, sshCount: number, ghCount: number }} counts
 * @returns {{ isComplete: boolean, steps: Array<{id,label,done,required}>, completionPercent: number }}
 */
function buildSetupStatus({ llmCount = 0, sshCount = 0, ghCount = 0 } = {}) {
  const steps = [
    { id: 'llm',      label: 'Model Provider', done: llmCount > 0, required: true },
    { id: 'ssh-key',  label: 'SSH Key',        done: sshCount > 0, required: false },
    { id: 'gh-token', label: 'GitHub Token',   done: ghCount > 0,  required: false },
  ];
  const isComplete = steps.filter(s => s.required).every(s => s.done);
  const doneCount  = steps.filter(s => s.done).length;
  const completionPercent = Math.round((doneCount / steps.length) * 100);
  return { isComplete, steps, completionPercent };
}

module.exports = { buildSetupStatus };
