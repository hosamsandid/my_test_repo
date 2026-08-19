// Shared "Launch" decision core (#1668, epic #1661 Phase E).
//
// There are two front doors that turn a designed team into running agents: the
// Team-Setup wizard's submit and the Flows-canvas "Materialize as team" dialog.
// They collect the same inputs and hit the same team-materialization backend
// (POST /api/teams / /api/teams/stream) but used to carry two independent
// implementations — a consistency liability. This module is the single source of
// truth for the launch decisions both surfaces share (body building, validation,
// environment repo shape, button label, NDJSON stream handling), so the two can
// never drift apart (AC5: same result for equivalent inputs). It is deliberately
// React-free and fs-free so it runs under `node --test` (#651 convention); the
// shared JSX (`LaunchStep`) is a thin renderer over it.

// Slug rules shared by both entry points (was duplicated in MaterializeDialog +
// TeamSetup): lowercase, dashes for runs of non-[a-z0-9], no leading/trailing
// dash, max 40 chars.
export function slugify(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 40);
}

// A Working Environment carries a `repositories: [...]` array; legacy single
// `repository` values are migrated to a one-element array on read by the API.
// Return every repo that has a url so callers can show all of them (#1551).
export function reposForEnv(env) {
  if (Array.isArray(env?.repositories)) return env.repositories.filter(r => r && r.url);
  if (env?.repository && env.repository.url) return [env.repository];
  return [];
}

// A selected environment with no repository is repo-less (#1623) — a team can
// still materialize onto it (agents chat + use skills, no GitHub hand-offs).
// Both launch surfaces treat it as selectable (AC6).
export function isRepoLessEnv(env) {
  return !!env && reposForEnv(env).length === 0;
}

// Final, entry-point-agnostic validation of the launch inputs. Deliberately does
// NOT require a repository — a repo-less environment is a valid launch target
// (AC6). Returns the first error string, or null when the inputs are launchable.
export function validateLaunch({ teamId, teamName, environmentId, labelSuffix } = {}) {
  if (!/^[a-z0-9-]{1,40}$/.test(String(teamId || ''))) {
    return 'Team id must be a lowercase slug [a-z0-9-], 1–40 chars.';
  }
  if (!String(teamName || '').trim()) return 'Team name required.';
  if (!environmentId) return 'Pick a working environment.';
  if (labelSuffix && !/^[a-z0-9]{1,8}$/.test(labelSuffix)) {
    return 'Label suffix must be 1–8 lowercase base36 chars [a-z0-9].';
  }
  return null;
}

// The canonical POST body for /api/teams (and /api/teams/stream). `extra` carries
// entry-point-specific pass-through fields (the wizard's readyLabel/dispatchLabel/
// maxParallel/skills/knowledgeConfig or a legacy repository fallback); the shared
// keys always win so the two surfaces produce the same body for equivalent inputs
// (AC5). `materializeNow` is sent explicitly on both paths — the backend default
// is materialize-now (`materializeMembers !== false`), which the wizard has always
// relied on, so an explicit `true` is behaviour-preserving.
export function buildLaunchBody({
  teamId,
  teamName,
  environmentId,
  mode = 'create',
  labelSuffix,
  materializeNow,
  processTemplate,
  extra = {},
} = {}) {
  const name = String(teamName || '').trim();
  const body = { ...(extra || {}) };
  body.teamId = teamId;
  body.teamName = name;
  body.mode = mode;
  body.materializeMembers = materializeNow !== false;
  if (environmentId) body.environmentId = environmentId;
  if (labelSuffix) body.labelSuffix = labelSuffix;
  else delete body.labelSuffix;
  // Bind the bundle name to the team name at submit time (the wizard picks the
  // process before the team is named, #428) so both surfaces agree.
  if (processTemplate) body.processTemplate = { ...processTemplate, name: name || processTemplate.name };
  return body;
}

// Primary-action label shared by both surfaces. Extend (proactive) wins; then the
// materialize-now toggle picks between an immediate create and a stub create.
export function launchSubmitLabel({ saving, extend, materializeNow } = {}) {
  if (extend) return saving ? 'Extending…' : 'Extend team';
  if (saving) return 'Creating…';
  return materializeNow !== false ? 'Create team' : 'Create team (stubs)';
}

// Split a decoded NDJSON buffer into complete parsed events + the trailing
// partial line. Blank lines are skipped; unparseable lines are collected in
// `errors` (callers log-and-continue). Pure so the stream handling both surfaces
// use is unit-testable.
export function splitNdjson(buffer) {
  const events = [];
  const errors = [];
  let buf = String(buffer == null ? '' : buffer);
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { events.push(JSON.parse(line)); }
    catch (e) { errors.push({ line, error: e }); }
  }
  return { events, rest: buf, errors };
}

// POST the launch body to the streaming endpoint and dispatch each NDJSON event
// to `onEvent`. Shared by the wizard and the Materialize dialog so both get the
// identical plan/step/collision/complete/warning/error handling and progress
// feedback (AC8). `fetchImpl` is injectable for tests. Throws on a network
// failure or a non-ok response with no streamable body (caller surfaces it).
export async function runLaunchStream({ body, onEvent, url = '/api/teams/stream', fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('runLaunchStream: no fetch implementation available');
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && !res.body) {
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    // Mirror apiCall's shape so describeMaterializeError can prefer the
    // structured server message over a generic status line.
    if (data.error) err.serverMessage = data.error;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { events, rest } = splitNdjson(buf);
    buf = rest;
    for (const ev of events) onEvent(ev);
  }
  // Flush any trailing partial line (defensive — the server closes with a
  // newline, but a dropped connection mid-line shouldn't crash the caller).
  const tail = buf.trim();
  if (tail) {
    try { onEvent(JSON.parse(tail)); } catch { /* ignore */ }
  }
}
