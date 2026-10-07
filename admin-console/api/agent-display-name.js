'use strict';

// Display-name validation for `PUT /api/agents/:id` (#2679). The settings form
// marks "Display Name" as required, but the route used to persist whatever it
// was sent — three spaces saved fine and the agent turned nameless in the rail,
// the chat header and the composer placeholder. Agents, teams and team members
// all save through that one route, so the guard lives here once.

/**
 * Normalize a display name from a request body.
 * @param {*} value  the raw `displayName` (undefined = field not sent)
 * @returns {{ value?: string, error?: string }}  `value` is the trimmed name;
 *   both keys are absent when the field was not sent (leave it untouched).
 */
function normalizeDisplayName(value) {
  if (value === undefined) return {};
  if (typeof value !== 'string') return { error: 'displayName must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { error: 'displayName must not be empty' };
  return { value: trimmed };
}

module.exports = { normalizeDisplayName };
