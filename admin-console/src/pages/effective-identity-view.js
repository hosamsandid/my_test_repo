// Pure view helpers for the effective GitHub identity of a team (#2560).
// React-free so they unit-test with `node --test`.
//
// Input is the redacted shape `admin-console/api/effective-github-identity.js`
// returns per credential kind: `{ kind, kindLabel, source, problem, owner,
// credential, teamCredential }` — `source` being the tier the runtime actually
// resolved (personal / team / global / none). Nothing here decides a tier;
// the orchestrator's spawn-time resolver already did.

function credLabel(c) {
  if (!c) return '';
  return c.name && c.name !== c.id ? `${c.name} (${c.id})` : c.id;
}

/**
 * One line group for the Team Settings "Effective GitHub identity" box.
 * @returns {{ headline: string, detail: string, teamNote: string|null, problem: string|null, tone: 'ok'|'info'|'warning' }}
 */
export function describeEffectiveCredential(view) {
  const v = view || {};
  const kind = v.kindLabel || 'Credential';
  const lower = kind; // 'GitHub token' / 'SSH key' — proper nouns, never lowercased
  let headline;
  let detail;
  let tone = 'ok';
  if (v.source === 'personal') {
    const who = v.owner?.isYou ? 'you' : (v.owner?.label || 'the Team Admin');
    headline = v.owner?.isYou
      ? `Your personal ${lower}${v.credential ? ` — ${credLabel(v.credential)}` : ''}`
      : `Team Admin's personal ${lower} — ${v.owner?.label || 'the Team Admin'}`;
    detail = `Automatic runs and the agents' own gh/git calls act on GitHub as ${who}.`;
    tone = 'info';
  } else if (v.source === 'team') {
    headline = `Team ${lower} — ${credLabel(v.credential || v.teamCredential)}`;
    detail = 'Configured for this team below; no Team Admin personal credential overrides it.';
  } else if (v.source === 'global') {
    headline = `Global service ${lower}`;
    detail = `No team ${lower} is configured, so a platform-wide service credential is used.`;
  } else {
    headline = 'None configured';
    detail = `No ${lower} at any tier — neither the Team Admin's personal one, a team one, nor a global service one.`;
    tone = 'warning';
  }

  const teamNote = v.teamCredential?.overridden
    ? `Team ${lower} ${credLabel(v.teamCredential)}: not in use (overridden by the Team Admin's personal ${lower}).`
    : null;

  const problem = v.problem === 'orphaned'
    ? `The Team Admin's personal ${lower} belongs to ${v.owner?.label || 'a deleted user'}, who is no longer a user — it is skipped. Finish the offboarding: delete it and revoke it at GitHub.`
    : null;
  if (problem) tone = 'warning';

  return { headline, detail, teamNote, problem, tone };
}

const FALLBACK_TEXT = {
  personal: (lower) => `still uses another personal ${lower} of yours`,
  team: (lower, t) => `falls back to the team ${lower} ${credLabel(t)}`,
  global: (lower) => 'falls back to a global service credential',
  none: (lower) => `has no ${lower} at all any more`,
};

// What happened to the owner's running agents after a personal-credential
// change (#2655). The console respawns them only when the change moved the
// credential they resolve (POST … returns `ownerAgentsRestarted`); a delete
// never respawns, so it takes effect at the next start.
function restartSentence(restarted) {
  return restarted
    ? 'Your running agents were restarted to pick it up — a loop or trigger run in progress was cut off.'
    : "It takes effect at the agents' next start.";
}

/**
 * The notice a Team Admin sees after adding or deleting a personal credential
 * (AC4/AC5). `teams` comes from GET /api/me/baseline-teams — the Agent Teams
 * whose current Team Admin is the caller, as the runtime now resolves them.
 * `credentialId` is the added credential: only one personal credential per kind
 * is used (the first one added), so "now used" is said only when the teams
 * resolve to THIS one (#2655). `restarted` is the create response's
 * `ownerAgentsRestarted`.
 * @param {{ kind: 'github'|'ssh', action: 'added'|'deleted', teams: object[], credentialId?: string, restarted?: boolean }} args
 * @returns {string|null}  null when the change moves no team
 */
export function personalCredentialChangeNotice({ kind, action, teams, credentialId, restarted } = {}) {
  const list = Array.isArray(teams) ? teams : [];
  const lower = kind === 'ssh' ? 'SSH key' : 'GitHub token';
  const nameList = (ts) => ts.map((t) => t.displayName || t.agentId).join(', ');
  if (action === 'added') {
    const personal = list.filter((t) => t?.[kind]?.source === 'personal' && t[kind].owner?.isYou);
    const isThis = (t) => !credentialId || t[kind].credential?.id === String(credentialId);
    const using = personal.filter(isThis);
    if (using.length === 0) {
      const other = personal.find((t) => !isThis(t));
      if (!other) return null;
      return `Your new personal ${lower} is not in use: ${nameList(personal)} keep${personal.length === 1 ? 's' : ''} using `
        + `your personal ${lower} ${credLabel(other[kind].credential)}. Only one personal ${lower} is used — the one you added first; `
        + 'delete that one to switch. No agent was restarted.';
    }
    return `Your personal ${lower} is now used by ${using.length === 1 ? 'your team' : `${using.length} of your teams`} `
      + `(${nameList(using)}) for automatic work and in-container GitHub actions, instead of the team's own ${lower}. ${restartSentence(restarted)}`;
  }
  if (action === 'deleted') {
    if (list.length === 0) return null;
    const parts = list.map((t) => {
      const v = t?.[kind] || {};
      const text = (FALLBACK_TEXT[v.source] || FALLBACK_TEXT.none)(lower, v.teamCredential || v.credential);
      return `${t.displayName || t.agentId} ${text}`;
    });
    return `Your personal ${lower} is no longer used for your teams: ${parts.join('; ')}. ${restartSentence(false)}`;
  }
  return null;
}

/**
 * "Used by" cell for a personal row (#2655): a personal credential is never
 * referenced by an environment, so the environment count ("None") said nothing
 * about whether the runtime uses it. GET returns `activePersonal` per personal row.
 * @returns {{ label: string, title: string, active: boolean }|null}  null for a non-personal row
 */
export function personalUsageCell(row, kind) {
  if (!row || row.scope !== 'personal' || typeof row.activePersonal !== 'boolean') return null;
  const lower = kind === 'ssh' ? 'SSH key' : 'GitHub token';
  return row.activePersonal
    ? { label: 'Active (personal)', active: true,
        title: `Your personal ${lower} in use: for your chat-turn pushes and, where you are Team Admin, your teams' automatic work.` }
    : { label: 'Not in use', active: false,
        title: `Only one personal ${lower} is used — the one you added first. Delete that one to switch to this one.` };
}

/**
 * Restart warning for the create dialog (#2655). Only the first personal
 * credential of a kind restarts the owner's running agents; a further one is
 * not used and restarts nothing. Null for a team/system credential (creating
 * one restarts nothing until an environment points at it).
 */
export function personalCreateRestartNote({ kind, scope, hasActivePersonal } = {}) {
  if (scope !== 'personal') return null;
  const lower = kind === 'ssh' ? 'SSH key' : 'GitHub token';
  return hasActivePersonal
    ? `You already have a personal ${lower} in use. Only the first one is used, so this one stays inactive and no agent is restarted.`
    : `Saving restarts your running agents so they pick it up — a loop or trigger run in progress is cut off.`;
}

/**
 * Restart warning on the Replace value / Replace key panel (#2655): a team or
 * system credential restarts the agents of every environment referencing it;
 * a personal one restarts the owner's agents — and only if it is the active one.
 */
export function replaceRestartNote(row, kind) {
  const lower = kind === 'ssh' ? 'key' : 'token';
  const fresh = kind === 'ssh' ? 'the new key' : 'the new value';
  if (row?.scope === 'personal') {
    return row.activePersonal === false
      ? `Keeps the same id, name and ownership. This personal ${lower} is not in use, so no agent is restarted.`
      : `Keeps the same id, name and ownership. Your running agents are restarted so they pick up ${fresh} — a running loop or trigger is cut off, so replace at a quiet moment.`;
  }
  return `Keeps the same id, name and ownership. Every environment that references this ${lower} has its running agents restarted so they pick up ${fresh} — a running loop or trigger is cut off, so replace at a quiet moment.`;
}

/**
 * Fetch the caller's baseline teams and build the AC4/AC5 notice. Best-effort:
 * a failed lookup yields no notice rather than an error — the credential change
 * itself already succeeded.
 * @param {(url: string) => Promise<object>} fetchJson
 */
export async function loadPersonalCredentialChangeNotice(fetchJson, { kind, action, credentialId, restarted } = {}) {
  try {
    const r = await fetchJson('/api/me/baseline-teams');
    return personalCredentialChangeNotice({ kind, action, teams: r?.teams, credentialId, restarted });
  } catch {
    return null;
  }
}
