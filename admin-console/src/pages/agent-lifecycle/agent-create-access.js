/**
 * agent-create-access.js — may this caller create or import an agent? (#1956 AC6)
 *
 * The server gate is `canManageAgent(scope, { teamId })` (`api/scope.js`): a
 * full-visibility admin, or the Team Admin of the *destination* team. The
 * destination is chosen inside the form / the import dialog, so the honest
 * question a page-action button can answer before either is open is the weaker
 * one: is there any team this caller could create into at all? Someone who is
 * neither an admin nor a Team Admin anywhere has none, and every attempt would
 * come back 403 — so the button is disabled with the reason rather than left
 * live to fail at the server.
 *
 * Deliberately *disabled with a hint*, not hidden (unlike `Teams.jsx`, which
 * renders `null`): the header slot is the only place these two actions exist
 * now, and an empty header answers "where did New Agent go?" with silence.
 *
 * Pure and React-free (#651) so both the verdict and its wording are unit
 * tested. The UI trims the control; the API still enforces.
 */

const NO_SESSION_HINT = 'Sign in to create or import agents.';
const NOT_TEAM_ADMIN_HINT =
  'Only a Team Admin can create or import agents — ask an administrator of one of your teams.';

/**
 * @param {{admin?:boolean, teams?:{teamId:string, role:string}[]}|null} user
 *        the `useAuth()` user descriptor (#584)
 * @returns {{allowed:boolean, hint:string|null}} `hint` is the disabled reason,
 *          null when allowed — so a caller can pass it straight to `title`.
 */
export function describeAgentCreateAccess(user) {
  if (!user) return { allowed: false, hint: NO_SESSION_HINT };
  // `admin` is the env admin OR a System Admin — full visibility, so every
  // destination team is manageable.
  if (user.admin === true) return { allowed: true, hint: null };
  const isTeamAdmin = (user.teams || []).some(t => t && t.role === 'team-admin');
  if (isTeamAdmin) return { allowed: true, hint: null };
  return { allowed: false, hint: NOT_TEAM_ADMIN_HINT };
}
