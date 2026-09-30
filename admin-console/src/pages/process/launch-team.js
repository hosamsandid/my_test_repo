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

// The team-id rule, byte-identical to the server's TEAM_ID_RE (api.js) so the
// client can never bless a value the API then refuses with an opaque 400
// (#1934 AC2). Hyphens are legal *inside* the slug — the id is composed into
// member ids as `<teamId>-<roleId>` — but not at either end.
export const TEAM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const TEAM_ID_MAX = 40;

// The label-suffix rule, byte-identical to the server's SUFFIX_RE
// (admin-console/api/label-suffix.js). The suffix is appended to GitHub label
// tokens (`ready-for-review` → `ready-for-review-team-1`), so single inner
// hyphens are fine — but a leading/trailing/doubled hyphen would produce
// `ready--x` / `ready-x-` (#1934 AC4).
export const SUFFIX_RE = /^(?=.{1,8}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SUFFIX_MAX = 8;

// One wording per rule, used by the field hints (AC9) and the error messages
// alike, so a hint can never describe something the validation doesn't enforce.
export const TEAM_ID_HINT = 'Lowercase letters, digits and inner dashes, 1–40 chars (must start and end with a letter or digit).';
export const SUFFIX_HINT = 'Up to 8 lowercase letters, digits and single inner dashes — e.g. k3f9, team-1, pre-prod.';
export const TEAM_ID_ERROR = `Team id: ${TEAM_ID_HINT}`;
export const SUFFIX_ERROR = `Label suffix: ${SUFFIX_HINT}`;

// #2179: a platform with no registered model provider cannot bind ANY new
// team to a working one — team creation would proceed and 500 on first run.
// Mirrors the server-side message (admin-console/api/team-provider-check.js)
// so the client-blocked reason and the 400 a caller would otherwise get read
// the same.
export const NO_PROVIDER_ERROR = 'No model provider is set up yet — ask a Team or System Administrator to add one before creating a team.';

// Slug rules shared by both entry points (was duplicated in MaterializeDialog,
// TeamSetup and LaunchStep's own `slugifyLocal`, all collapsed onto this one —
// #1934): lowercase, dashes for runs of non-[a-z0-9], no leading/trailing
// dash, max 40 chars. The 40-char cap is applied BEFORE the trailing-dash strip
// so truncating a long name can never re-introduce a trailing dash the server
// would then reject (#1934 AC3).
export function slugify(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, TEAM_ID_MAX)
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// Keystroke-level sanitiser for the team-id field. Deliberately gentler than
// `slugify`: it drops what can never be legal (uppercase, illegal characters,
// a leading dash) but KEEPS a trailing dash, because while you are typing
// `acme-web` the dash is legitimately the last character (#1934 AC1). The
// trailing dash is normalised away on blur (`normalizeTeamId`) and, as a
// backstop, rejected by `validateLaunch`.
export function sanitizeTeamIdInput(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, TEAM_ID_MAX);
}

// Settle a mid-edit team id into a submittable one (on blur): same cap-then-trim
// order as `slugify`, so it is idempotent and never yields a trailing dash.
export function normalizeTeamId(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, TEAM_ID_MAX)
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// Keystroke-level sanitiser for the label-suffix field: keeps the characters the
// rule allows (including the dash) and lets validation explain a misplaced one
// inline, rather than silently swallowing the keystroke (#1934 AC4/AC5).
export function sanitizeLabelSuffixInput(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '')
    .slice(0, SUFFIX_MAX);
}

// Per-field messages for immediate inline feedback while editing. Both return
// null for a value that is fine (an empty one included — emptiness is reported
// by `validateLaunch` at submit, not nagged at while the field is still blank).
// Judged on the SETTLED value, not the raw one: a dash that merely happens to
// be the last character typed is removed on blur, so nagging about it mid-word
// would be exactly the behaviour #1934 AC1 asks us to stop. What survives is
// the honest case — a value that cannot become a valid id at all (`---`).
export function teamIdError(teamId) {
  const v = String(teamId == null ? '' : teamId);
  if (!v || TEAM_ID_RE.test(normalizeTeamId(v))) return null;
  return TEAM_ID_ERROR;
}

export function labelSuffixError(labelSuffix) {
  const v = String(labelSuffix == null ? '' : labelSuffix);
  if (!v || SUFFIX_RE.test(v)) return null;
  return SUFFIX_ERROR;
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
// (AC6) — and, since #2168 A2, does NOT require an environment at all: leaving
// `environmentId` empty falls through to `POST /api/teams`'s own repo-less
// auto-create path (env id = team id), which is what makes "no UI path forces
// naming or picking an environment" hold for every launch surface, not just the
// wizard. Returns the first error string, or null when the inputs are launchable.
// `hasProvider` defaults to `true` (not blocking) so a caller that doesn't
// yet know the provider-registry state — or an older test fixture — is
// unaffected; only an explicit `false` (the platform-has-zero-providers case)
// blocks the launch (#2179).
export function validateLaunch({ teamId, teamName, labelSuffix, hasProvider = true } = {}) {
  if (!TEAM_ID_RE.test(String(teamId || ''))) return TEAM_ID_ERROR;
  if (!String(teamName || '').trim()) return 'Team name required.';
  if (labelSuffix && !SUFFIX_RE.test(labelSuffix)) return SUFFIX_ERROR;
  if (!hasProvider) return NO_PROVIDER_ERROR;
  return null;
}

// The SINGLE source for whether the primary Launch button is disabled and WHY
// (#2157 AC4). Before this, `LaunchStep` computed its own `envBlocking` boolean
// (`has('environment') && !values.environmentId`) independently of
// `validateLaunch`'s explanation — so the disabled state and the reason a
// caller might show could disagree, and the button gave a silent, unexplained
// dead click on the no-environment path (#2157).
//
// Settles the team id FIRST (`normalizeTeamId`, the same step `submit()` takes
// before validating) rather than calling `validateLaunch(values)` directly on
// the raw value — the trap #2157 calls out explicitly: `TEAM_ID_RE` rejects a
// value with a trailing dash, which is legal WHILE TYPING (the id field keeps a
// trailing dash until blur, #1934 AC1). Without settling first, the reported
// reason would flap between "team id" and "pick a working environment" on
// every dash keystroke, even though the disabled boolean stayed true
// throughout — settling removes that flicker in the SHOWN reason, not just the
// boolean. Returns `null` when the inputs are launchable.
export function launchBlockReason(values) {
  return validateLaunch({ ...values, teamId: normalizeTeamId(values?.teamId) });
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
  acknowledgeNoToken,
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
  // #2323: only ever set by the reference-only opt-out re-submit (strict true),
  // so a repo-backed env with no GitHub token can be launched deliberately.
  if (acknowledgeNoToken === true) body.acknowledgeNoToken = true;
  else delete body.acknowledgeNoToken;
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

// Headline for the result card of a completed launch. A stub launch
// (`materialized: false`, the mode the streaming endpoint now honours — #1955)
// has to read differently: no repository was cloned and no agent is running yet,
// so calling the team "ready" would repeat exactly the lie the ignored checkbox
// used to tell. The server reports the mode it actually ran in; a payload from
// before #1955 carries no `materialized` key, and an absent flag is read as the
// backend default (materialize-now) rather than guessed as a stub.
export function launchResultMessage(result) {
  const r = result || {};
  const name = r.teamName;
  if (r.message) return `Team ${name}: ${r.message}`;
  const n = r.created?.length || 0;
  if (r.materialized === false) {
    return `Team ${name} created — ${n} agent(s) as stubs. Enable a member to materialize it.`;
  }
  return `Team ${name} ready — ${n} agent(s) created.`;
}

// The failure card of a streamed launch (#2658). `message` is the server's error
// text, `steps` the progress list (null when the server refused before sending
// its plan). The rollback sentence is only true when a step actually ran — a
// refusal before the plan created nothing, so claiming "every resource created
// during this attempt was rolled back" would be noise. The one API-worded
// refusal a UI user can reach (extend with a team id that does not exist yet) is
// translated into the dialog's own terms.
export function launchFailure({ message, steps } = {}) {
  const msg = String(message || '');
  const m = msg.match(/^Cannot extend: team '([^']*)' does not exist yet\./);
  const text = m
    ? `There is no team '${m[1]}' to add agents to yet — untick “Add to an existing team” to create it instead.`
    : msg;
  const ran = Array.isArray(steps) && steps.some(s => s && s.status && s.status !== 'pending');
  return { message: text, rolledBack: ran };
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
  // A non-OK response is always a pre-stream failure the server answered as a
  // buffered JSON error ({ error, code }) — validation, a collision, or #2323's
  // github_token_required. It is NOT a stream, even though `res.body` is a
  // (non-null) ReadableStream for any response carrying a body: reading it as
  // NDJSON would silently swallow the error (the wizard would just hang). So key
  // off `!res.ok` alone and surface the structured error to the caller.
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    // Mirror apiCall's shape so describeMaterializeError can prefer the
    // structured server message over a generic status line — and so a caller
    // can branch on a structured `code` (e.g. #2323's github_token_required, to
    // offer the reference-only opt-out) rather than string-matching the message.
    if (data.error) err.serverMessage = data.error;
    if (data.code) err.code = data.code;
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

// Where the Create-team confirmation's completion action lands (#2521): Agent
// Chat, on the team's FIRST agent — the member created from `bundle.roles[0]`.
// The id mirrors the server's `planMembers` (api.js): a bundle role always
// materializes as a single `<teamId>-<roleId>` member (the processTemplate path
// never sets a count), so the target is known without waiting on the roster.
// The router state asks Agent Chat to reveal the row (expand its group/stub
// section, scroll to it) and to wait for it if the background roster refresh
// has not picked the new team up yet. A bundle with no usable first role falls
// back to the team itself (`/chats/<teamId>` — its configuration surface,
// #2235); no team id at all falls back to plain `/chats`.
export function agentChatTargetFor(bundle, teamId) {
  const team = typeof teamId === 'string' ? teamId.trim() : '';
  if (!team) return { path: '/chats', state: null };
  const firstRole = Array.isArray(bundle?.roles) ? bundle.roles[0] : null;
  const roleId = typeof firstRole?.id === 'string' ? firstRole.id.trim() : '';
  const agentId = roleId ? `${team}-${roleId}` : team;
  return {
    path: `/chats/${encodeURIComponent(agentId)}`,
    state: { revealAgentId: agentId },
  };
}
