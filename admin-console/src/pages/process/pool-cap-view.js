// Pure view helpers for a pooled role's live instance count against its
// "Max parallel instances" cap (#2760 AC5). Shared by the Agent Chat rail's
// "Instances (n)" group (AgentList.jsx via agent-list-model.js) and the role's
// Scaling section (ScalingSection.jsx), so both surfaces say the same thing.
// Dependency-free so it unit-tests under `node --test` (#651).
//
// The orchestrator never stops running instances when the cap is lowered — it
// only refuses to START a new one until the count is below the cap
// (`planPoolDispatch`'s `>= maxInstances`). An over-cap count is therefore a
// real, visible state (cap lowered, or instances left from before #2760), and
// the tooltip says what it means rather than looking like an error.
//
// #2789: an instance kept alive only because its pull request is still open
// ("waiting") is outside the cap. `count` is the ACTIVE instances only; the
// waiting ones are named apart ("2 / 3 active · 4 waiting").

function validCap(cap) {
  return Number.isInteger(cap) && cap >= 1 ? cap : null;
}

function waitingNote(w) {
  return ` · ${w} waiting on a PR — kept alive for review feedback, not counted against the limit`;
}

/**
 * `{ text, over, title }` for `count` active instances under `cap` (null/blank
 * = no per-role cap), plus `waiting` instances kept alive for an open PR
 * (#2789, outside the cap). `text` is "5 / 3" with a cap, the bare count
 * without one; with waiting instances "2 / 3 active · 4 waiting".
 */
export function poolCapView(count, cap, waiting = 0) {
  const n = Number.isInteger(count) && count >= 0 ? count : 0;
  const w = Number.isInteger(waiting) && waiting > 0 ? waiting : 0;
  const c = validCap(cap);
  const suffix = w ? ` · ${w} waiting` : '';
  const note = w ? waitingNote(w) : '';
  if (c == null) {
    return {
      text: `${n}${w ? ' active' : ''}${suffix}`,
      over: false,
      title: `${n} ${w ? 'active' : 'live'} instance${n === 1 ? '' : 's'} — no per-role cap (the team's ticket limit governs)${note}`,
    };
  }
  const over = n > c;
  return {
    text: `${n} / ${c}${w ? ' active' : ''}${suffix}`,
    over,
    title: (over
      ? `${n} ${w ? 'active' : 'live'} instances — over the limit of ${c}. Running instances are not stopped; ` +
        `no new instance starts until the count is below ${c}.`
      : `${n} of at most ${c} parallel instances`) + note,
  };
}

/**
 * The pool-control read for a team member whose SAVED config is pooled, or
 * `null` (nothing to show — fetch nothing). Takes the member's own config row.
 */
export function poolControlUrl(member) {
  if (!member || member.role !== 'team-member' || !member.parentTeamId) return null;
  if (!member.pool || member.pool.enabled !== true) return null;
  return `/api/teams/${encodeURIComponent(member.parentTeamId)}/pool-control`;
}

/**
 * The live count + saved cap for one pooled role out of a
 * `GET /api/teams/:teamId/pool-control` response (its `roles[]` rows carry
 * `agentId`, `maxInstances` and `liveInstanceCount` — the latter includes
 * instances still provisioning, the same set the cap counts, and leaves out
 * instances waiting on an open PR, reported as `waitingInstanceCount`, #2789).
 * `null` when the response is missing or does not list the role (not pooled
 * yet, or not saved).
 */
export function livePoolCount(poolControl, memberId) {
  const roles = poolControl && Array.isArray(poolControl.roles) ? poolControl.roles : [];
  const row = roles.find((r) => r && r.agentId === memberId);
  if (!row || !Number.isInteger(row.liveInstanceCount)) return null;
  const waiting = Number.isInteger(row.waitingInstanceCount) && row.waitingInstanceCount > 0 ? row.waitingInstanceCount : 0;
  return { count: row.liveInstanceCount, cap: validCap(row.maxInstances), waiting };
}
