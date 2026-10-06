'use strict';

// Who a GitHub wake is delivered to when the listener is a pooled role (#2875).
//
// A pool instance (`poolInstance: true`, `<template>-i<item>`) inherits its
// role's `github-event` triggers, so a label wake that matched listeners by
// trigger alone woke every live instance of the role — including instances
// working on a different ticket (on 2026-10-06 `code-reviewer-i2859` reviewed
// PR #2820). An instance is never a direct wake listener on any delivery path:
// the wake goes to the role TEMPLATE, and `enqueuePending` → `planPoolDispatch`
// routes it onto the item's own instance (spawning one if needed). The
// instance that already holds the item keeps receiving its follow-ups the same
// way, through the item key (#2789).
//
// One helper, used by every path that turns a GitHub event into a wake: the
// poller's plan (`computePollPlan`), the internal label fast-path
// (`matchPollerListeners`, also used by the Flow Supervisor) and "Fire again"
// (`refireGithubEvent`). Pure and dependency-free.

// Whether an agent with this config may be woken directly by a GitHub event.
// A null config (a stub without a readable config) keeps today's behaviour.
function isDirectWakeListener(config) {
  return !(config && config.poolInstance === true);
}

// The agent a wake for `agentId` is enqueued on: a pool instance's role
// template, or the agent itself.
function wakeTargetAgentId(agentId, config) {
  if (config && config.poolInstance === true && typeof config.poolOf === 'string' && config.poolOf) {
    return config.poolOf;
  }
  return agentId;
}

module.exports = { isDirectWakeListener, wakeTargetAgentId };
