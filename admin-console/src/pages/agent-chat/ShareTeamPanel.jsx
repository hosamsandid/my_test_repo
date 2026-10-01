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

// The Sharing surface of an Agent Team (#2082, #2041 P4 / AC8–AC10). Sharing is
// decentralised (D3): a Team Admin adds colleagues, sets whether each is a Team
// Admin or a Team Member, and removes them, without a System Admin and without
// the Access page. It is the team's own "Sharing" configuration tab
// (`TEAM_CONFIG_TABS`) — for a caller who may only read the list it is framed
// on its own by `TeamSharingReadOnlySurface`.
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
// Mounted only while the Sharing tab is shown, so the help subject comes and
// goes with it and needs no `active:` flag.
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
    <div style={panelRoot}>
      {/* Intro. Keeps the exact opening sentence (the e2e journey anchors the
          whole panel on it) and the shareTeam help "?" (asserted by the help
          extraction test). */}
      <div style={introRow}>
        <p style={introText}>
          Everyone listed here can open <strong>{teamName || teamId}</strong> in the
          Agent Chat and chat with its agents. A <strong>Team Admin</strong> can
          additionally change the team&apos;s agents and settings, and manage this list.
        </p>
        <PageHelpButton
          section={AGENT_CHAT_HELP_SECTIONS.shareTeam}
          label="How sharing an Agent Team works"
        />
      </div>

      {/* Has access — the membership list, as one bordered card of rows. */}
      <section style={sectionStyle}>
        <h3 style={sectionHeading}>
          Has access
          <span style={sectionCount}>{shareSubtitle(rows)}</span>
        </h3>
        <div style={listCard}>
          {!loaded ? (
            <div style={emptyRow}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={emptyRow}>Nobody has access yet.</div>
          ) : rows.map((r, i) => {
            const rm = removeState({ rows, userId: r.userId, canManage, busy });
            const isLast = i === rows.length - 1;
            return (
              <div
                key={r.membershipId}
                style={{ ...memberRowStyle, borderBottom: isLast ? 'none' : ROW_DIVIDER }}
              >
                <div style={avatarStyle(r.you)} aria-hidden="true">{initials(r.label)}</div>
                {/* Name block: the name line is the leaf div the e2e `memberRow`
                    locator anchors on; the row is exactly two levels up. */}
                <div style={namesBlock}>
                  <div style={nameLine}>
                    {r.label}{r.you ? ' (you)' : ''}
                    {!r.known && <span style={idHint}>({r.userId})</span>}
                  </div>
                  {r.email && <div style={emailLine}>{r.email}</div>}
                </div>
                {canManage ? (
                  <div style={rowControls}>
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
                      style={removeButtonStyle(rm.disabled)}
                    >
                      <Trash2 size={13} /> {r.you ? 'Leave' : 'Remove'}
                    </button>
                  </div>
                ) : (
                  <span style={roleBadge(r.role)}>{ROLE_LABELS[r.role]}</span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* D4 — one prompt, one request: the successor is promoted in the same
          write that removes or demotes the last admin, so the team is never
          momentarily un-administrable. */}
      {handover && (
        <div style={calloutStyle}>
          <p style={calloutText}>{handover.notice}</p>
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
        <section style={sectionStyle}>
          <h3 style={sectionHeading}>Add a colleague</h3>
          <div style={addCard}>
            {/* D2 — the picker searches the whole organisation: people are
                findable, the private thing is the team. The search input is
                immediately followed by the control row (the e2e `addCluster`
                locator depends on that sibling order). */}
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setAddUserId(''); }}
              placeholder="Search by name or email…"
              disabled={busy || candidates.length === 0}
              style={searchInputStyle}
            />
            <div style={addControls}>
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
            <p style={legendText}>
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
        </section>
      ) : (
        <p style={readOnlyNoticeStyle}>{READ_ONLY_NOTICE}</p>
      )}

      {error && <p style={errorText}>{error}</p>}
    </div>
  );
}

// Two-letter monogram from a display name — first + last initial, or the first
// two letters of a single-word name. Purely decorative (aria-hidden), so it
// never needs to be the whole name.
function initials(label) {
  const parts = String(label || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const panelRoot = {
  // Matches the team form body's own readable cap (#2264, AgentEditForm's
  // maxWidth: 720) so the Sharing tab lines up with every other tab in the
  // manager view — and, because this is the only cap in the read-only
  // `TeamSharingReadOnlySurface`, keeps that surface from stretching too.
  display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5, 20px)',
  width: '100%', maxWidth: 720,
};

const introRow = {
  display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
};

const introText = {
  margin: 0, flex: 1, fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)', lineHeight: 1.6,
};

const sectionStyle = {
  display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
};

const sectionHeading = {
  margin: 0, display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-2)',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const sectionCount = {
  fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-normal)',
  color: 'var(--eb-text-muted)',
};

const listCard = {
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  background: 'var(--eb-bg-surface)',
  overflow: 'hidden',
};

// `--eb-border-subtle` / `--eb-bg-input` are used across the app but not
// actually defined in the token sheet, so they resolve to nothing (an
// invisible divider, a bg-less input). Give them concrete fallbacks here so
// this surface renders the same in every theme.
const SUBTLE_BORDER = 'var(--eb-border-default)';
const ROW_DIVIDER = `1px solid ${SUBTLE_BORDER}`;

const memberRowStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
  padding: 'var(--eb-space-3) var(--eb-space-4)',
};

const emptyRow = {
  padding: 'var(--eb-space-4)', fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-muted)',
};

function avatarStyle(you) {
  return {
    flexShrink: 0, width: 34, height: 34, borderRadius: 'var(--eb-radius-full)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)',
    letterSpacing: '0.02em',
    background: you ? 'var(--eb-accent-primary)' : 'var(--eb-accent-muted)',
    color: you ? 'var(--eb-text-inverted)' : 'var(--eb-accent-primary)',
  };
}

const namesBlock = {
  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1,
};

const nameLine = {
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

const emailLine = {
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

const idHint = {
  marginLeft: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
  fontWeight: 'var(--eb-font-normal)',
};

const rowControls = {
  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexShrink: 0,
};

// The role of a member the viewer may not change — a quiet pill rather than a
// disabled dropdown, so read-only reads as read-only and not as "broken".
function roleBadge(role) {
  const admin = role === ROLE_ADMIN;
  return {
    flexShrink: 0, padding: '3px 10px', borderRadius: 'var(--eb-radius-full)',
    fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
    background: admin ? 'var(--eb-accent-muted)' : 'var(--eb-bg-elevated)',
    color: admin ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
    border: `1px solid ${SUBTLE_BORDER}`,
  };
}

const addCard = {
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  background: 'var(--eb-bg-surface)',
  padding: 'var(--eb-space-4)',
  display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
};

const addControls = { display: 'flex', gap: 'var(--eb-space-2)' };

const legendText = {
  margin: 0, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
  lineHeight: 1.5,
};

const readOnlyNoticeStyle = {
  margin: 0, padding: 'var(--eb-space-3) var(--eb-space-4)',
  border: `1px solid ${SUBTLE_BORDER}`,
  borderRadius: 'var(--eb-radius-md)',
  background: 'var(--eb-bg-elevated)',
  fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', lineHeight: 1.5,
};

const calloutStyle = {
  padding: 'var(--eb-space-4)',
  border: '1px solid var(--eb-status-warning)',
  borderRadius: 'var(--eb-radius-lg)',
  background: 'var(--eb-status-warning-bg)',
  display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
};

const calloutText = {
  margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
  lineHeight: 1.5,
};

const errorText = {
  margin: 0, color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
};

const selectStyle = {
  padding: '7px 10px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  cursor: 'pointer',
};

const searchInputStyle = {
  ...selectStyle, width: '100%', cursor: 'text',
};

const primaryButtonStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
  fontWeight: 'var(--eb-font-medium)',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const secondaryButtonStyle = {
  padding: '7px 14px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
  background: 'transparent', color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  cursor: 'pointer',
};

function removeButtonStyle(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 10px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
    background: 'transparent',
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)',
    color: disabled ? 'var(--eb-text-muted)' : 'var(--eb-status-error)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    whiteSpace: 'nowrap',
  };
}
