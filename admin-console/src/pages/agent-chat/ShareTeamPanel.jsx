import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Trash2 } from 'lucide-react';

import { apiCall } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext';
import { useHelpSubject } from '../../context/HelperChatContext';
import { OVERLAY_TEAM_SHARE } from '../../context/page-help-view.js';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import {
  ROLE_ADMIN, ROLE_OPTIONS, ROLE_LABELS, ROLE_HINTS, READ_ONLY_NOTICE,
  canManageMembers, memberRows, shareCandidates, filterCandidates, candidateLabel,
  addControlState, removeState, roleChangeState, handoverRequirement,
  setRoleRequest, removeRequest, shareSubtitle, membershipWriteError,
} from './team-share-view.js';

// The Share panel of an Agent Team's context menu in the Agent Chat (#2082,
// #2041 P4 / AC8–AC10). Sharing is decentralised (D3): a Team Admin adds
// colleagues, sets whether each is a Team Admin or a Team Member, and removes
// them, without a System Admin and without the Access page.
//
// Every decision — who may be offered, whether a control is live, whether a
// removal needs a D4 successor, which HTTP shape each write takes — is the pure
// `team-share-view.js`; this file is the renderer (per the #651 convention).
//
// Two things worth knowing before editing:
//
//  * **The list is readable without rights, the controls are not.** `GET
//    /api/admin/memberships` is `visibleTeam`-filtered, so a Team Member sees
//    the list read-only (AC9/D9) — which is why `canManage` gates the controls
//    and never the fetch. The server re-enforces every write via
//    `canManageTeam`, so the trimming here is parity, not protection.
//  * **The picker reads the OPEN directory** (`GET /api/users/directory`, D2),
//    not `/api/admin/users`: the latter returns the whole user record including
//    the `systemAdmin` flag and the GitHub handle, which D2/D11 forbid showing.
//
// Mounted only while the panel is open (SidePanel renders null when closed), so
// the help subject comes and goes with it and needs no `active:` flag.
export default function ShareTeamPanel({ teamId, teamName, onError }) {
  useHelpSubject({ overlay: OVERLAY_TEAM_SHARE });
  const { user } = useAuth();

  const [memberships, setMemberships] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [addUserId, setAddUserId] = useState('');
  // Defaults to the least powerful role — ROLE_OPTIONS is ordered that way.
  const [addRole, setAddRole] = useState(ROLE_OPTIONS[0]);
  const [query, setQuery] = useState('');
  // The D4 hand-over: `{ userId, action, nextRole, candidates }` while the
  // panel is asking who takes over. The API takes the successor in the SAME
  // call, so this is one prompt and one request, never a demote-then-remove.
  const [handover, setHandover] = useState(null);
  const [successorId, setSuccessorId] = useState('');

  const canManage = canManageMembers(user, teamId);

  const load = useCallback(async () => {
    try {
      const [m, dir] = await Promise.all([
        apiCall('GET', `/api/admin/memberships?teamId=${encodeURIComponent(teamId)}`),
        apiCall('GET', '/api/users/directory'),
      ]);
      setMemberships(Array.isArray(m) ? m : []);
      setDirectory(Array.isArray(dir) ? dir : []);
      setLoaded(true);
    } catch (e) {
      setError(membershipWriteError(e, 'Could not read who has access to this team.'));
      setLoaded(true);
    }
  }, [teamId]);

  useEffect(() => { load(); }, [load]);

  // Every write re-reads the list rather than patching it locally: the store
  // may have applied a promotion alongside the change we asked for (the D4
  // hand-over lands in one write), so the response is not the whole truth.
  async function write(req) {
    setBusy(true);
    setError(null);
    try {
      await apiCall(req.method, req.url, req.body || undefined);
      setHandover(null);
      setSuccessorId('');
      await load();
      return true;
    } catch (e) {
      const msg = membershipWriteError(e);
      setError(msg);
      if (onError) onError(msg);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const rows = memberRows(memberships, directory, user?.userId || null);
  const candidates = shareCandidates(directory, rows);
  const shown = filterCandidates(candidates, query);
  const addState = addControlState({ candidates, selectedId: addUserId, busy, query });

  // A removal or a demotion of the last admin asks who takes over first; every
  // other change goes straight through.
  function requestChange({ userId, action, nextRole }) {
    const req = handoverRequirement({ rows, userId, action });
    if (req.kind === 'blocked') { setError(req.notice); return; }
    if (req.kind === 'successor') {
      setHandover({ userId, action, nextRole, candidates: req.candidates, notice: req.notice });
      setSuccessorId('');
      return;
    }
    commit({ userId, action, nextRole, successorUserId: '' });
  }

  function commit({ userId, action, nextRole, successorUserId }) {
    if (action === 'remove') {
      write(removeRequest({ teamId, userId, successorUserId }));
    } else {
      write(setRoleRequest({ teamId, userId, role: nextRole, successorUserId }));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)' }}>
        <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          Everyone listed here can open <strong>{teamName || teamId}</strong> in the
          Agent Chat and chat with its agents. A <strong>Team Admin</strong> can
          additionally change the team&apos;s agents and settings, and manage this list.
        </p>
        <PageHelpButton
          section={AGENT_CHAT_HELP_SECTIONS.shareTeam}
          label="How sharing an Agent Team works"
        />
      </div>

      <div>
        <h3 style={{
          margin: '0 0 var(--eb-space-2)', fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-muted)',
        }}>
          Has access — {shareSubtitle(rows)}
        </h3>
        {!loaded ? (
          <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
            Nobody has access yet.
          </p>
        ) : rows.map((r) => {
          const rm = removeState({ rows, userId: r.userId, canManage, busy });
          return (
            <div key={r.membershipId} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-2) 0', borderBottom: '1px solid var(--eb-border-subtle)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
                  {r.label}{r.you ? ' (you)' : ''}
                  {!r.known && (
                    <span style={{ marginLeft: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                      ({r.userId})
                    </span>
                  )}
                </div>
                {r.email && (
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{r.email}</div>
                )}
              </div>
              {canManage ? (
                <>
                  <select
                    value={r.role}
                    disabled={busy}
                    title={`${ROLE_LABELS[r.role]} — ${ROLE_HINTS[r.role]}`}
                    onChange={e => requestChange({
                      userId: r.userId,
                      action: e.target.value === ROLE_ADMIN ? 'promote' : 'demote',
                      nextRole: e.target.value,
                    })}
                    style={selectStyle}
                  >
                    {ROLE_OPTIONS.map(role => (
                      <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={rm.disabled}
                    title={rm.hint || (r.you ? 'Leave this team' : `Remove ${r.label} from this team`)}
                    onClick={() => requestChange({ userId: r.userId, action: 'remove', nextRole: null })}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '4px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
                      background: 'transparent', border: '1px solid var(--eb-border-default)',
                      borderRadius: 'var(--eb-radius-sm)',
                      color: rm.disabled ? 'var(--eb-text-muted)' : 'var(--eb-status-error)',
                      cursor: rm.disabled ? 'not-allowed' : 'pointer',
                      opacity: rm.disabled ? 0.6 : 1,
                    }}
                  >
                    <Trash2 size={12} /> {r.you ? 'Leave' : 'Remove'}
                  </button>
                </>
              ) : (
                <span
                  title={ROLE_HINTS[r.role]}
                  style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}
                >{ROLE_LABELS[r.role]}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* D4 — one prompt, one request: the successor is promoted in the same
          write that removes or demotes the last admin, so the team is never
          momentarily un-administrable. */}
      {handover && (
        <div style={{
          padding: 'var(--eb-space-3)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-surface)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
            {handover.notice}
          </p>
          <select
            value={successorId}
            onChange={e => setSuccessorId(e.target.value)}
            disabled={busy}
            style={{ ...selectStyle, width: '100%' }}
          >
            <option value="">Choose the next Team Admin…</option>
            {handover.candidates.map(c => (
              <option key={c.userId} value={c.userId}>
                {c.email ? `${c.label} — ${c.email}` : c.label}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <button
              type="button"
              disabled={busy || !successorId}
              onClick={() => commit({ ...handover, successorUserId: successorId })}
              style={{ ...primaryButtonStyle, opacity: (busy || !successorId) ? 0.5 : 1 }}
            >
              {handover.action === 'remove' ? 'Hand over and remove' : 'Hand over and change role'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setHandover(null); setSuccessorId(''); }}
              style={secondaryButtonStyle}
            >Cancel</button>
          </div>
        </div>
      )}

      {canManage ? (
        <div>
          <h3 style={{
            margin: '0 0 var(--eb-space-2)', fontSize: 'var(--eb-text-sm)',
            color: 'var(--eb-text-muted)',
          }}>
            Add a colleague
          </h3>
          {/* D2 — the picker searches the whole organisation: people are
              findable, the private thing is the team. */}
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setAddUserId(''); }}
            placeholder="Search by name or email…"
            disabled={busy || candidates.length === 0}
            style={{ ...selectStyle, width: '100%', marginBottom: 'var(--eb-space-2)' }}
          />
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <select
              value={addUserId}
              onChange={e => setAddUserId(e.target.value)}
              disabled={busy || shown.length === 0}
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              <option value="">{addState.placeholder}</option>
              {shown.map(u => (
                <option key={u.id} value={u.id}>{candidateLabel(u)}</option>
              ))}
            </select>
            <select
              value={addRole}
              onChange={e => setAddRole(e.target.value)}
              disabled={busy}
              title={`${ROLE_LABELS[addRole]} — ${ROLE_HINTS[addRole]}`}
              style={selectStyle}
            >
              {ROLE_OPTIONS.map(role => (
                <option key={role} value={role}>{ROLE_LABELS[role]}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={addState.disabled}
              onClick={async () => {
                const ok = await write(setRoleRequest({ teamId, userId: addUserId, role: addRole }));
                if (ok) { setAddUserId(''); setQuery(''); }
              }}
              style={{
                ...primaryButtonStyle,
                opacity: addState.disabled ? 0.5 : 1,
                cursor: addState.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <UserPlus size={14} /> Add
            </button>
          </div>
          {/* D3 — only existing accounts; say where a new person comes from. */}
          <p style={{
            margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)', lineHeight: 1.5,
          }}>
            {addState.notice || (
              <>
                <strong style={{ color: 'var(--eb-text-secondary)' }}>{ROLE_LABELS[ROLE_OPTIONS[1]]}</strong>
                {' '}— {ROLE_HINTS[ROLE_OPTIONS[1]]}.{' '}
                <strong style={{ color: 'var(--eb-text-secondary)' }}>{ROLE_LABELS[ROLE_OPTIONS[0]]}</strong>
                {' '}— {ROLE_HINTS[ROLE_OPTIONS[0]]}. Only people who already have an
                account can be added.
              </>
            )}
          </p>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
          {READ_ONLY_NOTICE}
        </p>
      )}

      {error && (
        <p style={{ margin: 0, color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{error}</p>
      )}
    </div>
  );
}

const selectStyle = {
  padding: '6px 8px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
  background: 'var(--eb-bg-input)', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
};

const primaryButtonStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '6px 12px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-sm)', cursor: 'pointer',
};

const secondaryButtonStyle = {
  padding: '6px 12px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
  background: 'transparent', color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
  cursor: 'pointer',
};
