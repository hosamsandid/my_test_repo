/**
 * AgentLifecycleDialogs.jsx — the confirmation dialogs that guard the
 * destructive/stateful lifecycle actions, and the delete-dialog message body.
 *
 * Moved verbatim out of Agents.jsx for #1928 (epic #1925 Phase 1), which
 * re-surfaces the same actions in Agent Chat's left rail. The ticket requires
 * the confirmation flows to be *shared, not duplicated* (AC4): a chat-initiated
 * disable and an Agents-page disable now open the same component, so the
 * drain-vs-hard-stop wording, the busy/active-trigger lead and the
 * knowledge-purge note in the team-delete message cannot drift between the two
 * surfaces.
 *
 * The three drain-vs-hard-stop dialogs are hand-rolled fixed-overlay modals
 * rather than the shared `ConfirmDialog` because each needs *three* actions
 * (Cancel / drain / hard stop), which `ConfirmDialog`'s two-button contract
 * cannot express. The remaining three (`ResetToStubDialog`, `TeamEnableDialog`,
 * `TeamActionResultDialog`) are thin wrappers *over* `ConfirmDialog` — they were
 * inline JSX at the Agents page's call site, which is exactly the shape that
 * drifts once a second surface renders "the same" confirm, so the body and the
 * button copy live here now. `renderDeleteMessage` is the ReactNode body the
 * callers pass as `ConfirmDialog`'s `message`.
 *
 * Nothing about them changed in the move.
 */
import React from 'react';

import ConfirmDialog from '../../components/ConfirmDialog';

export function DisableWarningDialog({ open, agent, busy, activeTriggers, onDrain, onAbort, onCancel }) {
  if (!open) return null;
  const name = agent?.displayName ?? agent?.id ?? 'this agent';
  const triggerCount = Array.isArray(activeTriggers) ? activeTriggers.length : 0;

  const parts = [];
  if (busy) parts.push('a session is currently running');
  if (triggerCount > 0) parts.push(`${triggerCount} active trigger${triggerCount !== 1 ? 's' : ''}`);

  return (
    <div role="dialog" aria-modal="true" aria-label="Disable agent" style={{
      position: 'fixed', inset: 0, background: 'oklch(0 0 0 / 0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-5)', maxWidth: 480,
        width: '90%', boxShadow: 'var(--eb-shadow-xl)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)' }}>
          <span style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2, fontSize: 20 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              Disable "{name}"
            </h3>
            <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
              {parts.length > 0
                ? `This agent has ${parts.join(' and ')}. Choose how to proceed:`
                : 'This agent has active state. Choose how to proceed:'}
            </p>
            <ul style={{ margin: 'var(--eb-space-2) 0 0', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
              <li><strong>Let run</strong> — disable immediately; the current execution finishes naturally. No new triggers will start.</li>
              <li><strong>Hard stop</strong> — kill the process now. Any in-progress work is aborted.</li>
            </ul>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-4)' }}>
          <button onClick={onCancel} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)',
            color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Cancel</button>
          <button onClick={onDrain} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Let run</button>
          <button onClick={onAbort} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-status-error)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Hard stop</button>
        </div>
      </div>
    </div>
  );
}

export function TeamDisableDialog({ open, team, members, error, busy, onDrain, onAbort, onCancel }) {
  if (!open) return null;
  const name = team?.displayName ?? team?.id ?? 'this team';
  const toDisable = members.filter(m => m.enabled);
  const busyCount = toDisable.filter(m => m.busy || (m.activeTriggers?.length ?? 0) > 0).length;

  return (
    <div role="dialog" aria-modal="true" aria-label="Disable team" style={{
      position: 'fixed', inset: 0, background: 'oklch(0 0 0 / 0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-5)', maxWidth: 520,
        width: '90%', boxShadow: 'var(--eb-shadow-xl)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)' }}>
          <span style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2, fontSize: 20 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              Disable team "{name}"
            </h3>
            <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
              {toDisable.length === 0
                ? 'Every member is already disabled — this only marks the team itself as disabled.'
                : `${toDisable.length} member${toDisable.length !== 1 ? 's' : ''} will be disabled${busyCount > 0 ? ` (${busyCount} currently busy or with active triggers)` : ''}. Choose how to proceed:`}
            </p>
            {toDisable.length > 0 && (
              <ul style={{ margin: 'var(--eb-space-2) 0 0', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', maxHeight: 200, overflowY: 'auto' }}>
                {toDisable.map(m => (
                  <li key={m.id}>
                    {m.displayName}
                    {(m.busy || (m.activeTriggers?.length ?? 0) > 0) && (
                      <span style={{ color: 'var(--eb-status-warning)' }}> — {m.busy ? 'busy' : `${m.activeTriggers.length} active trigger(s)`}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {members.some(m => !m.enabled) && (
              <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                {members.filter(m => !m.enabled).length} member(s) already disabled are left untouched.
              </p>
            )}
            {error && (
              <p style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginTop: 'var(--eb-space-2)' }}>{error}</p>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-4)' }}>
          <button onClick={onCancel} disabled={busy} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)',
            color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
          }}>Cancel</button>
          <button onClick={onDrain} disabled={busy} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
          }}>Let running work finish</button>
          <button onClick={onAbort} disabled={busy} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-status-error)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
          }}>Hard stop</button>
        </div>
      </div>
    </div>
  );
}

export function DeactivateWarningDialog({ open, agent, busy, activeTriggers, onDrain, onHardStop, onCancel }) {
  if (!open) return null;
  const name = agent?.displayName ?? agent?.id ?? 'this agent';
  const triggerCount = Array.isArray(activeTriggers) ? activeTriggers.length : 0;

  const parts = [];
  if (busy) parts.push('a session is currently running');
  if (triggerCount > 0) parts.push(`${triggerCount} active trigger${triggerCount !== 1 ? 's' : ''}`);

  return (
    <div role="dialog" aria-modal="true" aria-label="Reset agent to stub" style={{
      position: 'fixed', inset: 0, background: 'oklch(0 0 0 / 0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-5)', maxWidth: 500,
        width: '90%', boxShadow: 'var(--eb-shadow-xl)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)' }}>
          <span style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2, fontSize: 20 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              Reset "{name}" to stub
            </h3>
            <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
              {parts.length > 0
                ? `This agent has ${parts.join(' and ')}. Choose how to proceed:`
                : 'This agent has active state. Choose how to proceed:'}
            </p>
            <ul style={{ margin: 'var(--eb-space-2) 0 0', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
              <li><strong>Let run</strong> — disable triggers now so no new executions start; the current execution finishes naturally. Come back to reset once the agent is idle.</li>
              <li><strong>Hard stop</strong> — kill the process immediately, then wipe the workspace.</li>
            </ul>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-4)' }}>
          <button onClick={onCancel} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)',
            color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Cancel</button>
          <button onClick={onDrain} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Let run</button>
          <button onClick={onHardStop} style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-status-error)',
            color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
          }}>Hard stop + reset</button>
        </div>
      </div>
    </div>
  );
}

/**
 * The reset-to-stub confirm (AC4). Reset is not a pause — it wipes the
 * workspace — so the copy has to name what is lost and point at Disable, and it
 * may never be reachable in one click from either surface.
 */
export function ResetToStubDialog({ open, agent, onConfirm, onCancel }) {
  return (
    <ConfirmDialog
      open={open}
      title="Reset agent to stub?"
      message={
        `Reset "${agent?.displayName ?? agent?.id}" to its stub state? ` +
        `This stops the agent process and wipes the workspace. ` +
        `The stub config is kept so the agent can be reactivated later — but session history, ` +
        `cloned repositories, and any in-workspace state will be lost. ` +
        `To pause without losing anything, cancel and use the Disable toggle instead.`
      }
      variant="danger"
      confirmLabel="Reset to stub"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/**
 * The team *enable* fan-out confirm. It names the members the team disabled
 * automatically, because those are exactly the ones coming back — a member that
 * was already off on its own stays off, and the operator has to be able to see
 * that before confirming.
 */
export function TeamEnableDialog({ open, team, members, error, busy, onConfirm, onCancel }) {
  return (
    <ConfirmDialog
      open={open}
      title={`Enable team "${team?.displayName ?? ''}"?`}
      message={(
        <div>
          <p style={{ marginTop: 0 }}>
            This brings back every member this team disabled automatically. Members that were disabled on their own before the team was disabled stay off.
          </p>
          <ul style={{ margin: '0 0 var(--eb-space-2)', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)' }}>
            {(members || []).filter(m => m.disabledByTeam).map(m => (
              <li key={m.id}>{m.displayName}</li>
            ))}
          </ul>
          {error && (
            <p style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{error}</p>
          )}
        </div>
      )}
      variant="info"
      confirmLabel="Enable team"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/**
 * The partial-failure report for a team fan-out (AC2): the members the
 * enable/disable could not reach, each with the server's reason. Alert-only —
 * there is nothing to confirm, and silently swallowing a half-applied fan-out is
 * the failure mode this dialog exists to prevent.
 */
export function TeamActionResultDialog({ result, onClose }) {
  return (
    <ConfirmDialog
      open={!!result}
      variant="danger"
      alertOnly
      title={result?.action === 'disable' ? 'Some members failed to disable' : 'Some members failed to enable'}
      message={result && (
        <div>
          <p style={{ marginTop: 0 }}>
            {result.failedMembers.length} member(s) could not be {result.action === 'disable' ? 'disabled' : 'enabled'}:
          </p>
          <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)' }}>
            {result.failedMembers.map(m => (
              <li key={m.id}><strong>{m.displayName}</strong> — {m.error}</li>
            ))}
          </ul>
        </div>
      )}
      onConfirm={onClose}
      onCancel={onClose}
    />
  );
}

export function renderDeleteMessage(target) {
  if (!target) return '';

  // A team is the only cascading parent since #1964 — the orchestrator arm of
  // this branch went with the role, so the cascade wording can no longer be
  // reached by something that fans out to nothing.
  if (target.role === 'team') {
    const children = Array.isArray(target.children) ? target.children : [];
    const childNoun = 'member';
    const childNounPlural = 'members';
    const parentNoun = 'team';

    // Deleting a team purges its locally cached / curated knowledge on this
    // stack (#532) — the honest counterpart to actually purging the data on the
    // backend. Knowledge shared via the team's repository is NOT touched (that
    // is the sanctioned sharing channel), so the note must say so explicitly.
    const knowledgeNote = (
      <p style={{ margin: 'var(--eb-space-3) 0 0', color: 'var(--eb-text-primary)' }}>
        <strong>This team's locally cached and curated knowledge will be permanently removed</strong> —
        its local Knowledge Base copy, promotion suggestions, archive, review decisions and team skill pool.
        Knowledge shared via the team's repository is <strong>not affected</strong>.
      </p>
    );

    if (children.length === 0) {
      return (
        <>
          <p style={{ margin: 0 }}>
            Delete this {parentNoun}? It currently has no {childNounPlural} attached.
            The workspace, configuration and chat account will be removed permanently.
          </p>
          {knowledgeNote}
        </>
      );
    }

    return (
      <>
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)',
          border: '1px solid var(--eb-status-error)',
          borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-text-primary)',
          fontWeight: 'var(--eb-font-semibold)',
          fontSize: 'var(--eb-text-sm)',
        }}>
          ⚠ This will permanently delete the {parentNoun} <strong>and all {children.length} {children.length === 1 ? childNoun : childNounPlural}</strong> below.
          Workspaces, session histories and chat accounts for every listed agent will be removed. This cannot be undone.
        </div>
        <p style={{ margin: 'var(--eb-space-3) 0 var(--eb-space-1)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
          {childNounPlural[0].toUpperCase() + childNounPlural.slice(1)} that will be deleted:
        </p>
        <ul style={{
          margin: 0,
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          maxHeight: 220,
          overflowY: 'auto',
          background: 'var(--eb-bg-app)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          listStyle: 'none',
          fontFamily: 'var(--eb-font-mono)',
          fontSize: 'var(--eb-text-xs)',
        }}>
          {children.map((c) => (
            // Stacked layout: id on top, displayName underneath. Side-by-side
            // didn't survive long ids + long titles — the row blew the dialog
            // open even with min-width:0 on the parent because both spans
            // wanted full width. Stacking is robust regardless of length and
            // keeps the visual hierarchy (mono id, muted title).
            <li key={c.id} style={{
              padding: '4px 0',
              display: 'flex', flexDirection: 'column', gap: 1,
              borderBottom: '1px solid var(--eb-border-subtle, transparent)',
            }}>
              <span style={{ color: 'var(--eb-text-primary)', wordBreak: 'break-all' }}>
                {c.id}
              </span>
              {c.displayName && c.displayName !== c.id && (
                <span style={{
                  color: 'var(--eb-text-muted)',
                  fontFamily: 'var(--eb-font-sans, inherit)',
                  fontSize: '11px',
                  wordBreak: 'break-word',
                }}>
                  {c.displayName}
                </span>
              )}
            </li>
          ))}
        </ul>
        {knowledgeNote}
      </>
    );
  }

  return `Delete agent "${target.displayName ?? target.id}"? This removes the workspace and all associated data.`;
}
