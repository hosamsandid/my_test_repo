// Decisions behind the rail's "Add member…" dialog (#1958).
//
// Adding a member to a live team used to be a bare, body-less POST that always
// materialized — Matrix user, clone, container. The chat's workaround for "not
// ready yet" was to create the member and then PUT `{enabled: false}`, which
// produced a *paused* agent, not a stub: the expensive part had already run.
// (That workaround is gone as of #1959; this ticket supplies what it was
// standing in for.) The dialog now offers the same choice the team-create
// wizard has, so the deferral is real.
//
// Pure and dependency-free per the #651 convention: the copy and the request
// shape are unit-tested here, and the JSX that renders them is covered by the
// source-reading guard in `rail-lifecycle-wiring.test.js`.

/** Dialog chrome. Title carries the ellipsis convention of a menu entry that opens a dialog. */
export const ADD_MEMBER_TITLE = 'Add member';

/**
 * The "Materialize now" checkbox copy.
 *
 * It USED to be deliberately parallel to the team-create wizard's — singular
 * where that one was plural — on the grounds that the two mean the same thing at
 * different granularity. **#2053 broke that parallel on purpose**: the launch
 * step's checkbox now reads *Provision agents now*, because "Materialize" there
 * sat one step from a button that used the same word for the OTHER act (turning
 * a design into a team, now *Create team…*). This checkbox keeps the old word
 * because it is the member-level act, and Agent Chat's *Not materialized yet*
 * section and its *Materialize* entry — the surfaces a reader lands on from
 * here — were deliberately left alone (#2053 Non-goals). Do not "restore" the
 * parallel by renaming this one.
 */
export const MATERIALIZE_NOW_LABEL = 'Materialize now';
export const MATERIALIZE_NOW_HINT = 'Clones the repository and starts the agent immediately. '
  + 'Leave off to create it as a stub — configuration and triggers only, no clone and no '
  + 'container — listed under "Not materialized yet", where you can materialize it later.';

/**
 * Default state of the checkbox: ON. A member you are adding on purpose is
 * usually one you want working right away, and it keeps the pre-#1958 behaviour
 * as the thing that happens when you just press the button (AC1).
 */
export const MATERIALIZE_NOW_DEFAULT = true;

/**
 * The POST body for `/api/agents/:teamId/members`.
 *
 * `materialize` is always sent explicitly rather than omitted-when-true: the
 * backend default is materialize-now, so an explicit `true` is behaviour
 * preserving, and sending the key in both modes means the one request shape is
 * exercised either way. Same reasoning as `buildLaunchBody`'s `materializeMembers`.
 *
 * @param {boolean} o.materializeNow checkbox state
 * @returns {{materialize: boolean}}
 */
export function addMemberBody({ materializeNow = MATERIALIZE_NOW_DEFAULT } = {}) {
  return { materialize: materializeNow !== false };
}

/**
 * Primary-action label. Mirrors `launchSubmitLabel` — the deferred mode says so
 * on the button, because the two outcomes differ by minutes of cloning and the
 * checkbox may well be off the user's screen focus by the time they press it.
 */
export function addMemberConfirmLabel({ busy, materializeNow } = {}) {
  if (busy) return 'Adding…';
  return materializeNow !== false ? 'Add member' : 'Add member (stub)';
}

/**
 * Success notice for the rail toast.
 *
 * Reads the mode the SERVER reports, never the mode we asked for: a stub create
 * returns `materialized: false`, while the materializing branch returns no such
 * key at all. An absent flag is therefore read as the documented backend default
 * (materialize-now) rather than guessed from the request — a backend that
 * ignored the preference must not be reported as if it had honoured it.
 */
export function addMemberNotice(result) {
  const r = result || {};
  const who = r.id ? `'${r.id}'` : 'Member';
  if (r.materialized === false) {
    return `${who} created as a stub — no clone, no container. `
      + 'It is listed under "Not materialized yet"; materialize it when you are ready.';
  }
  return `${who} added and started.`;
}
