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

/**
 * The notice a Team Admin sees after adding or deleting a personal credential
 * (AC4/AC5). `teams` comes from GET /api/me/baseline-teams — the Agent Teams
 * whose current Team Admin is the caller, as the runtime now resolves them.
 * @param {{ kind: 'github'|'ssh', action: 'added'|'deleted', teams: object[] }} args
 * @returns {string|null}  null when the change moves no team
 */
export function personalCredentialChangeNotice({ kind, action, teams } = {}) {
  const list = Array.isArray(teams) ? teams : [];
  const lower = kind === 'ssh' ? 'SSH key' : 'GitHub token';
  const when = "It takes effect at the agents' next start.";
  if (action === 'added') {
    const using = list.filter((t) => t?.[kind]?.source === 'personal' && t[kind].owner?.isYou);
    if (using.length === 0) return null;
    const names = using.map((t) => t.displayName || t.agentId).join(', ');
    return `Your personal ${lower} is now used by ${using.length === 1 ? 'your team' : `${using.length} of your teams`} `
      + `(${names}) for automatic work and in-container GitHub actions, instead of the team's own ${lower}. ${when}`;
  }
  if (action === 'deleted') {
    if (list.length === 0) return null;
    const parts = list.map((t) => {
      const v = t?.[kind] || {};
      const text = (FALLBACK_TEXT[v.source] || FALLBACK_TEXT.none)(lower, v.teamCredential || v.credential);
      return `${t.displayName || t.agentId} ${text}`;
    });
    return `Your personal ${lower} is no longer used for your teams: ${parts.join('; ')}. ${when}`;
  }
  return null;
}

/**
 * Fetch the caller's baseline teams and build the AC4/AC5 notice. Best-effort:
 * a failed lookup yields no notice rather than an error — the credential change
 * itself already succeeded.
 * @param {(url: string) => Promise<object>} fetchJson
 */
export async function loadPersonalCredentialChangeNotice(fetchJson, { kind, action } = {}) {
  try {
    const r = await fetchJson('/api/me/baseline-teams');
    return personalCredentialChangeNotice({ kind, action, teams: r?.teams });
  } catch {
    return null;
  }
}
