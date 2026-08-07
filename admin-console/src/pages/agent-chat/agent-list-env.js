/**
 * Pure Working-Environment resolution for the Agent Chat left rail (#1451).
 *
 * Every row used to carry its own `<Server /> <environmentName>` line. Inside a
 * team group that is the same string on every row — an Agent Team is
 * materialised against one shared Working Environment — so a 13-member team
 * repeated the env name 13 times and roughly doubled the height of the list.
 *
 * The fix hoists the env to the group header and suppresses it on the rows that
 * inherit it. Uniformity is a property of how teams are created today, NOT an
 * invariant of the data model (`environmentId` is per agent), so a deviating
 * member must keep its own line — there it is signal, not noise.
 *
 * All logic lives here (dependency-free) so it lands in the `admin-console-src`
 * CI job under `node --test`; the JSX list stays uncovered per the #651
 * convention (mirrors agent-list-dnd.js / message-draft.js).
 */

/**
 * The Working Environment a group's rows share, or `null` when there is nothing
 * worth hoisting.
 *
 * Considers the group header row (the team / orchestrator agent, when visible)
 * plus its children. Returns the *most common* non-empty environment name,
 * provided it is shared by at least two rows and no other name is equally
 * common. That keeps the two fallbacks honest:
 *  - a lone row (or a group whose rows all differ) → `null`, every row keeps
 *    its own line exactly as before;
 *  - a tie (e.g. 2 rows on env A, 2 on env B) → `null`, since picking either
 *    one as "the group's" env would be arbitrary.
 *
 * @param {{header?: object|null, children?: object[]}} group
 * @returns {string|null}
 */
export function groupEnvironmentName(group) {
  const rows = [group?.header, ...(group?.children || [])].filter(Boolean);

  const counts = new Map();
  for (const row of rows) {
    const name = row?.environmentName;
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  let best = null;
  let bestCount = 0;
  let tied = false;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }

  if (tied || bestCount < 2) return null;
  return best;
}

/**
 * The environment name a single row should render, given the environment
 * already shown on its group header (`null` for ungrouped rows — a single agent
 * has no header to hoist to, so it always shows its own).
 *
 * @param {object} agent
 * @param {string|null} [groupEnv]
 * @returns {string|null}
 */
export function rowEnvironmentName(agent, groupEnv = null) {
  const name = agent?.environmentName;
  if (!name) return null;
  return name === groupEnv ? null : name;
}
