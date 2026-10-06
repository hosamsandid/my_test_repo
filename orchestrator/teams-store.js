'use strict';

// ============================================================
// Teams data model (#299)
// ============================================================
//
// A **Team** here is the *human* collaboration & visibility scope — the
// tenant. It is deliberately distinct from the existing `role: "team"` agent
// construct (the "Agent Team" / squad that works a repo); the two only share a
// word. Every agent construct, Working Environment and credential is owned by
// exactly one Team via a `teamId` field stamped onto its record.
//
// This module is the single source of truth for the three persistent
// collections that back the model:
//
//   /workspace/teams/index.json        [{ id, name, description, createdAt, updatedAt }]
//   /workspace/users/index.json        [{ id, subject, email, displayName, systemAdmin, githubHandle, matrixUserId, createdAt, updatedAt }]
//   /workspace/memberships/index.json  [{ id, userId, teamId, role, createdAt }]
//
// Roles:
//   - System Admin  — global, modeled as `user.systemAdmin === true` (NOT a membership)
//   - Team Admin    — per-team, membership.role === "team-admin"
//   - Team Member   — per-team, membership.role === "team-member"
//
// A human may hold different per-team roles in different teams. Membership is
// at most one record per (userId, teamId) — re-asserting it updates the role.
//
// The module is a pure factory (`createTeamsStore({ root })`) with no global
// state so it can be unit-tested against a temp directory. Writes are atomic
// (write-temp + rename). Auth, list-endpoint filtering and UI are explicitly
// out of scope here (separate issues) — this is the data model only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const succession = require('./team-admin-succession');
const { isHumanMatrixUserId } = require('./human-matrix-identity');

const DEFAULT_TEAM_ID = 'default';
const DEFAULT_TEAM_NAME = 'Default Team';

const MEMBERSHIP_ROLES = Object.freeze(['team-admin', 'team-member']);

// A team id is an operator-facing slug, same rules as Working Environment ids.
const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The last System Admin may neither be deleted nor demoted (#2059 AC7, #2041
// AC18). Before #2059 the env credential was an always-available fallback, so
// removing the only global administrator was survivable; now that the console
// authenticates against user records alone, it would lock every human out of
// user management with no way back in short of editing the store on the host.
// The store owns the rule — the Users page mirrors these exact sentences on its
// disabled controls (`admin-console/src/pages/users-view.js`) and renders them
// verbatim if a request is made anyway.
const LAST_SYSTEM_ADMIN_DELETE_REASON =
  'The last System Admin cannot be deleted — promote another user to System Admin first';
const LAST_SYSTEM_ADMIN_DEMOTE_REASON =
  'The last System Admin cannot be demoted — promote another user to System Admin first';

// Is `id` the ONLY System Admin in `users`? A stack with zero System Admins has
// no last one to protect, so this is false there — the guard never blocks an
// action on a record that was not holding the estate up.
function isLastSystemAdmin(users, id) {
  const admins = (Array.isArray(users) ? users : []).filter(u => u && u.systemAdmin === true);
  return admins.length === 1 && admins[0].id === id;
}

// A user's optional email (#2695 finding 88). Before this the store kept any
// string, so "not-an-email" was accepted and stored — the console's button
// submits by onClick, which bypasses the browser's native `type=email` check.
// Deliberately a plausibility check (one `@`, no whitespace, a dot in the
// domain), not RFC 5322: the field is contact metadata, never an identity —
// the `subject` is. The Users page mirrors this rule and sentence
// (`admin-console/src/pages/users-view.js`); its test proves they agree.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_EMAIL_REASON = 'Email must be a valid address, e.g. jane.doe@corp.com';

function isValidEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim());
}

// The stored form of an optional email: '' when blank, the trimmed value when
// plausible, a 400 otherwise.
function normalizeEmail(v) {
  if (!isNonEmptyString(v)) return '';
  if (!isValidEmail(v)) throw badRequest(INVALID_EMAIL_REASON, 'invalid-email');
  return v.trim();
}

function nowIso() {
  return new Date().toISOString();
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// GitHub handle (#1385). Optional per-user field so a parent tracker ticket can
// be assigned to the human who requested the work (the platform otherwise has
// no GitHub username for an AEE subject). Kept byte-compatible with the pure
// frontend module `admin-console/src/pages/teams-github-handle.js` — the two
// live in disjoint images so they cannot share code, but the rules must agree.

// Strip a leading "@" and surrounding whitespace; empty/whitespace-only → ''.
function normalizeGithubHandle(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^@/, '').trim();
}

// Validate + normalize a GitHub handle. Returns the normalized handle, '' to
// clear it, or throws badRequest on a malformed value. GitHub username rules:
// 1–39 chars, letters/digits/hyphens, may not start or end with a hyphen. The
// regex has no nested quantifiers (linear — no polynomial-ReDoS surface).
function coerceGithubHandle(raw) {
  const h = normalizeGithubHandle(raw);
  if (!h) return '';
  if (h.length > 39) throw badRequest('githubHandle must be 39 characters or fewer');
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(h)) {
    throw badRequest('githubHandle may only contain letters, digits, and hyphens, and may not start or end with a hyphen');
  }
  return h;
}

// Per-user Agent-Chat transcript font size (#1437). A discoverable +/- control
// lets each user tune the chat font on their own profile; the value is stored
// server-side on the user record so it follows the user across browsers,
// devices and screen resolutions and never leaks into another user's view.
const CHAT_FONT_SIZE_MIN = 10;
const CHAT_FONT_SIZE_MAX = 18;
const CHAT_FONT_SIZE_DEFAULT = 12;

// Validate a chat font size. Returns an integer in [MIN,MAX], or `undefined`
// when the value is absent/blank (leave the field unset — the session default
// of 12px applies). Throws badRequest on a non-integer or out-of-range value.
function coerceChatFontSize(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n)) {
    throw badRequest('chatFontSize must be an integer');
  }
  if (n < CHAT_FONT_SIZE_MIN || n > CHAT_FONT_SIZE_MAX) {
    throw badRequest(`chatFontSize must be between ${CHAT_FONT_SIZE_MIN} and ${CHAT_FONT_SIZE_MAX}`);
  }
  return n;
}

// Per-user opt-in for the "an agent you messaged is back" browser notification
// (#2397). Off by default; persisted only when explicitly enabled so an unset
// record keeps the feature off (mirrors chatFontSize's "unset = default"). A
// blank/absent value leaves it unset; anything else must be a real boolean.
function coerceChatNotifyOnBack(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'boolean') {
    throw badRequest('chatNotifyOnBack must be a boolean');
  }
  return raw;
}

// Per-user Agent-Chat rail team selection (#2740). Stored as the entries the
// user has *hidden* (`team:<id>` keys plus `singles` for the Individual agents
// block), not the ones shown, so a team that becomes visible later is shown by
// default. A pure view preference: it never widens what the user may see.
// Blank/absent clears it (everything shown); anything else must be
// `{ hidden: string[] }`. Duplicates are folded and the list is bounded so a
// runaway client cannot bloat the user record.
const CHAT_LIST_FILTER_MAX_KEYS = 2000;
const CHAT_LIST_FILTER_MAX_KEY_LENGTH = 512;

// The same `{ hidden: string[] }` shape backs the Flows rail filter
// (`flowsListFilter`, #2859: `team:<id>` / `draft:<id>` keys), so one coercer
// serves both; `field` only names the preference in the error text.
function coerceListFilter(raw, field) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.hidden)) {
    throw badRequest(`${field} must be an object with a hidden array`);
  }
  // Bound the raw array before touching its entries: request bodies are not
  // size-capped on the orchestrator, so the cap must hold ahead of the loop.
  if (raw.hidden.length > CHAT_LIST_FILTER_MAX_KEYS) {
    throw badRequest(`${field}.hidden may hold at most ${CHAT_LIST_FILTER_MAX_KEYS} entries`);
  }
  const hidden = new Set();
  for (const key of raw.hidden) {
    if (typeof key !== 'string' || !key || key.length > CHAT_LIST_FILTER_MAX_KEY_LENGTH) {
      throw badRequest(`${field}.hidden entries must be non-empty strings of at most ${CHAT_LIST_FILTER_MAX_KEY_LENGTH} characters`);
    }
    hidden.add(key);
  }
  return { hidden: [...hidden] };
}

function coerceChatListFilter(raw) {
  return coerceListFilter(raw, 'chatListFilter');
}

function coerceFlowsListFilter(raw) {
  return coerceListFilter(raw, 'flowsListFilter');
}

// A membership's `teamId` may name an **Agent Team** as well as a legacy access
// scope (#2077 D1; self-service creation, #2081). This module owns
// teams/users/memberships and has no agent access, so the second half of that
// question is injected: `agentTeamExists(id)` answers "is there a `role: 'team'`
// agent with this id". Defaults to a closed `() => false`, so a caller that
// wires nothing keeps exactly the pre-#2081 behaviour (`teams/index.json` only)
// rather than silently accepting any string.
function createTeamsStore({ root, agentTeamExists } = {}) {
  if (!isNonEmptyString(root)) {
    throw new Error('createTeamsStore: { root } is required');
  }
  const knownAgentTeam = typeof agentTeamExists === 'function' ? agentTeamExists : () => false;
  function teamExists(id) {
    if (getTeam(id)) return true;
    try {
      return knownAgentTeam(id) === true;
    } catch {
      return false; // an unreadable agent config is "no team", never "any team"
    }
  }

  const TEAMS_INDEX = path.join(root, 'teams', 'index.json');
  const USERS_INDEX = path.join(root, 'users', 'index.json');
  const MEMBERSHIPS_INDEX = path.join(root, 'memberships', 'index.json');

  // ---- low-level IO -------------------------------------------------------

  function readArray(file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function writeArray(file, arr) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, file);
  }

  // ---- teams --------------------------------------------------------------

  function listTeams() {
    return readArray(TEAMS_INDEX);
  }

  function getTeam(id) {
    return listTeams().find(t => t.id === id) || null;
  }

  function createTeam({ id, name, description } = {}) {
    if (!isNonEmptyString(id) || !TEAM_ID_RE.test(id)) {
      throw badRequest('team id is required (a-z, 0-9, -; must start alphanumeric)');
    }
    if (!isNonEmptyString(name)) {
      throw badRequest('team name is required');
    }
    const teams = listTeams();
    if (teams.some(t => t.id === id)) {
      throw conflict(`Team '${id}' already exists`);
    }
    const team = {
      id,
      name: name.trim(),
      description: isNonEmptyString(description) ? description.trim() : '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    teams.push(team);
    writeArray(TEAMS_INDEX, teams);
    return team;
  }

  function updateTeam(id, patch = {}) {
    const teams = listTeams();
    const idx = teams.findIndex(t => t.id === id);
    if (idx === -1) throw notFound(`Team '${id}' not found`);
    const team = teams[idx];
    if (patch.name !== undefined) {
      if (!isNonEmptyString(patch.name)) throw badRequest('team name cannot be empty');
      team.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      team.description = isNonEmptyString(patch.description) ? patch.description.trim() : '';
    }
    team.updatedAt = nowIso();
    teams[idx] = team;
    writeArray(TEAMS_INDEX, teams);
    return team;
  }

  // Deletes a team and cascades its memberships. Refuses to delete the default
  // team. Resource-ownership guarding (does any agent/env/credential still
  // belong to this team?) lives in the caller, which knows about those
  // collections — the store only owns teams/users/memberships.
  function deleteTeam(id) {
    if (id === DEFAULT_TEAM_ID) {
      throw conflict('The default team cannot be deleted');
    }
    const teams = listTeams();
    const idx = teams.findIndex(t => t.id === id);
    if (idx === -1) throw notFound(`Team '${id}' not found`);
    teams.splice(idx, 1);
    writeArray(TEAMS_INDEX, teams);
    // cascade memberships
    const memberships = readArray(MEMBERSHIPS_INDEX);
    const remaining = memberships.filter(m => m.teamId !== id);
    if (remaining.length !== memberships.length) {
      writeArray(MEMBERSHIPS_INDEX, remaining);
    }
    return { id, deleted: true };
  }

  // ---- users --------------------------------------------------------------

  function listUsers() {
    return readArray(USERS_INDEX);
  }

  function getUser(id) {
    return listUsers().find(u => u.id === id) || null;
  }

  // The `subject` is the stable identifier from the (future) IdP — e.g. the
  // OIDC subject claim or the corporate email. It is unique per user so that
  // SSO login can map a corporate identity onto exactly one account.
  function getUserBySubject(subject) {
    if (!isNonEmptyString(subject)) return null;
    const s = subject.trim().toLowerCase();
    return listUsers().find(u => (u.subject || '').toLowerCase() === s) || null;
  }

  function createUser({ subject, email, displayName, systemAdmin, githubHandle, chatFontSize, chatNotifyOnBack } = {}) {
    if (!isNonEmptyString(subject)) {
      throw badRequest('user subject is required');
    }
    if (getUserBySubject(subject)) {
      throw conflict(`User with subject '${subject}' already exists`);
    }
    const normalizedEmail = normalizeEmail(email);
    const users = listUsers();
    const user = {
      id: crypto.randomUUID(),
      subject: subject.trim(),
      email: normalizedEmail,
      displayName: isNonEmptyString(displayName) ? displayName.trim() : subject.trim(),
      systemAdmin: systemAdmin === true,
      githubHandle: coerceGithubHandle(githubHandle),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    // Optional per-user chat font size — persisted only when explicitly set, so
    // an unset record keeps the 12px session default (#1437).
    const cfs = coerceChatFontSize(chatFontSize);
    if (cfs !== undefined) user.chatFontSize = cfs;
    // Optional per-user browser-notification opt-in — persisted only when
    // explicitly enabled, so an unset record keeps the feature off (#2397).
    const cnb = coerceChatNotifyOnBack(chatNotifyOnBack);
    if (cnb === true) user.chatNotifyOnBack = true;
    users.push(user);
    writeArray(USERS_INDEX, users);
    return user;
  }

  function updateUser(id, patch = {}) {
    const users = listUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) throw notFound(`User '${id}' not found`);
    const user = users[idx];
    if (patch.email !== undefined) {
      user.email = normalizeEmail(patch.email);
    }
    if (patch.displayName !== undefined) {
      if (!isNonEmptyString(patch.displayName)) throw badRequest('displayName cannot be empty');
      user.displayName = patch.displayName.trim();
    }
    if (patch.systemAdmin !== undefined) {
      if (patch.systemAdmin !== true && isLastSystemAdmin(users, id)) {
        throw conflict(LAST_SYSTEM_ADMIN_DEMOTE_REASON);
      }
      user.systemAdmin = patch.systemAdmin === true;
    }
    if (patch.githubHandle !== undefined) {
      user.githubHandle = coerceGithubHandle(patch.githubHandle);
    }
    if (patch.chatFontSize !== undefined) {
      const cfs = coerceChatFontSize(patch.chatFontSize);
      // A blank/absent value clears the override back to the 12px default.
      if (cfs === undefined) delete user.chatFontSize;
      else user.chatFontSize = cfs;
    }
    if (patch.chatNotifyOnBack !== undefined) {
      const cnb = coerceChatNotifyOnBack(patch.chatNotifyOnBack);
      // Off is the default, so a false/blank value clears the field entirely
      // rather than storing an explicit `false` (#2397).
      if (cnb === true) user.chatNotifyOnBack = true;
      else delete user.chatNotifyOnBack;
    }
    if (patch.chatListFilter !== undefined) {
      const clf = coerceChatListFilter(patch.chatListFilter);
      // A blank value clears the selection back to "everything shown" (#2740).
      if (clf === undefined) delete user.chatListFilter;
      else user.chatListFilter = clf;
    }
    if (patch.flowsListFilter !== undefined) {
      const flf = coerceFlowsListFilter(patch.flowsListFilter);
      // Blank clears the Flows rail selection back to "everything shown" (#2859).
      if (flf === undefined) delete user.flowsListFilter;
      else user.flowsListFilter = flf;
    }
    user.updatedAt = nowIso();
    users[idx] = user;
    writeArray(USERS_INDEX, users);
    return user;
  }

  // Deletes a user and cascades their memberships.
  //
  // Refused while the user is the last team-admin of any team (#2081 AC5,
  // D4): the cascade below would otherwise silently leave those teams
  // un-administrable, and unlike a removal there is no successor to name —
  // offboarding deletes a person, and guessing who inherits their teams is
  // exactly what D4 forbids. The check runs FIRST so a refusal costs nothing;
  // the caller's own pre-delete steps (agent pausing, personal-credential and
  // Matrix teardown) are destructive and must not run for a delete that cannot
  // proceed.
  function deleteUser(id) {
    const users = listUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) throw notFound(`User '${id}' not found`);
    if (isLastSystemAdmin(users, id)) throw conflict(LAST_SYSTEM_ADMIN_DELETE_REASON);
    {
      const plan = succession.planUserDeletion({
        memberships: readArray(MEMBERSHIPS_INDEX), userId: id,
      });
      if (!plan.ok) throw conflict(plan.message, plan.code);
    }
    users.splice(idx, 1);
    writeArray(USERS_INDEX, users);
    const memberships = readArray(MEMBERSHIPS_INDEX);
    const remaining = memberships.filter(m => m.userId !== id);
    if (remaining.length !== memberships.length) {
      writeArray(MEMBERSHIPS_INDEX, remaining);
    }
    return { id, deleted: true };
  }

  // ---- memberships --------------------------------------------------------

  function listMemberships({ userId, teamId } = {}) {
    let list = readArray(MEMBERSHIPS_INDEX);
    if (userId) list = list.filter(m => m.userId === userId);
    if (teamId) list = list.filter(m => m.teamId === teamId);
    return list;
  }

  // Raise `promote.userId` to team-admin in `list`, in place. The successor's
  // membership is guaranteed to exist — `planAdminHandover` refused otherwise —
  // so this only ever flips a role, never creates a grant.
  function applyPromotion(list, promote) {
    if (!promote) return;
    const target = list.find(m => m.userId === promote.userId && m.teamId === promote.teamId);
    if (target) target.role = succession.ROLE_ADMIN;
  }

  // Upsert: at most one membership per (userId, teamId). Re-asserting updates
  // the role in place rather than creating a duplicate.
  //
  // `successorUserId` is the D4 hand-over (#2081): demoting the LAST team-admin
  // of a team is refused unless a successor already in the team is named, and
  // when one is, the promotion and the demotion land in a SINGLE `writeArray` —
  // a promote-then-demote pair could leave the team with two admins, or none, if
  // the process died between the two writes.
  function setMembership({ userId, teamId, role, successorUserId } = {}) {
    if (!isNonEmptyString(userId)) throw badRequest('userId is required');
    if (!isNonEmptyString(teamId)) throw badRequest('teamId is required');
    if (!MEMBERSHIP_ROLES.includes(role)) {
      throw badRequest(`role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`);
    }
    if (!getUser(userId)) throw notFound(`User '${userId}' not found`);
    if (!teamExists(teamId)) throw notFound(`Team '${teamId}' not found`);

    const memberships = readArray(MEMBERSHIPS_INDEX);
    const existing = memberships.find(m => m.userId === userId && m.teamId === teamId);

    // Only a DEMOTION can strip a team of its last admin. Promoting somebody,
    // or re-asserting the role they already hold, never can — so the rule is
    // not consulted there and a plain "add a member" call is unaffected.
    let promote = null;
    if (existing && role !== succession.ROLE_ADMIN) {
      const plan = succession.planAdminHandover({
        memberships, userId, teamId, successorUserId,
      });
      if (!plan.ok) throw conflict(plan.message, plan.code);
      promote = plan.promote;
    }

    if (existing) {
      existing.role = role;
      applyPromotion(memberships, promote);
      writeArray(MEMBERSHIPS_INDEX, memberships);
      return existing;
    }
    const membership = {
      id: crypto.randomUUID(),
      userId,
      teamId,
      role,
      createdAt: nowIso(),
    };
    memberships.push(membership);
    writeArray(MEMBERSHIPS_INDEX, memberships);
    return membership;
  }

  // ---- local passwords (#374, interim before SSO #307) -------------------
  // A user may carry an optional scrypt password hash so they can log in
  // before enterprise SSO lands. The hash is stored on the record and is
  // NEVER returned by the API (sanitizeUser strips it at the boundary).

  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
  }

  function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    let salt, expected, actual;
    try {
      salt = Buffer.from(parts[1], 'hex');
      expected = Buffer.from(parts[2], 'hex');
      actual = crypto.scryptSync(String(password), salt, expected.length);
    } catch {
      return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  // Strip the password hash (and any future secret) before a record leaves the
  // process. Apply at every API response that carries a user. The raw hash is
  // replaced by a boolean `hasPassword` so a client (the Users page, #1844) can
  // reflect whether a local login password is set — reflecting the set/clear
  // affordance's current state — without ever seeing the secret itself.
  function sanitizeUser(u) {
    if (!u || typeof u !== 'object') return u;
    const { passwordHash, ...rest } = u;
    rest.hasPassword = !!passwordHash;
    return rest;
  }

  function setUserPassword(id, password) {
    if (!isNonEmptyString(password)) throw badRequest('password is required');
    const users = listUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) throw notFound(`User '${id}' not found`);
    users[idx].passwordHash = hashPassword(password);
    users[idx].updatedAt = nowIso();
    writeArray(USERS_INDEX, users);
    return sanitizeUser(users[idx]);
  }

  function clearUserPassword(id) {
    const users = listUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) throw notFound(`User '${id}' not found`);
    delete users[idx].passwordHash;
    users[idx].updatedAt = nowIso();
    writeArray(USERS_INDEX, users);
    return sanitizeUser(users[idx]);
  }

  // ---- Matrix identity pointer (#1458) ------------------------------------
  //
  // Records WHICH Matrix account belongs to this human — `@u-<hash>:local`,
  // derived from their subject by `human-matrix-identity.js`. This is a public
  // identifier (every member of a shared room sees it), so unlike the password
  // hash it is safe to keep on the record and to serialise.
  //
  // The matching **access token** deliberately does NOT live here: it is a
  // secret, and `users/index.json` has many direct readers that bypass
  // `sanitizeUser()`. It lives in `human-matrix-store.js` instead
  // (`users/matrix/<userId>.json`, mode 0600).
  function setUserMatrixIdentity(id, matrixUserId) {
    if (!isNonEmptyString(matrixUserId)) throw badRequest('matrixUserId is required');
    const users = listUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) throw notFound(`User '${id}' not found`);
    // Only a personal identity may be a person's pointer (#2721 AC7). The
    // shared admin account and agent accounts are service identities; stamping
    // one on a record would make that user the "author" of every message the
    // service account sends — their credentials and cost centre included.
    if (!isHumanMatrixUserId(matrixUserId.trim())) {
      throw badRequest('matrixUserId must be a personal Matrix identity (@u-<hash>:<server>)');
    }
    users[idx].matrixUserId = matrixUserId.trim();
    users[idx].updatedAt = nowIso();
    writeArray(USERS_INDEX, users);
    return sanitizeUser(users[idx]);
  }

  // Startup repair for AC7 (#2721): drop any `matrixUserId` that is not a
  // personal identity — e.g. a bootstrap admin that was pointed at the shared
  // admin account. The record then reads as "no identity yet" and the
  // provisioning backfill gives it a personal one. Returns the cleared ids.
  function clearNonPersonalMatrixIdentities() {
    const users = listUsers();
    const cleared = [];
    for (const u of users) {
      if (u && u.matrixUserId !== undefined && !isHumanMatrixUserId(u.matrixUserId)) {
        delete u.matrixUserId;
        u.updatedAt = nowIso();
        cleared.push(u.id);
      }
    }
    if (cleared.length > 0) writeArray(USERS_INDEX, users);
    return cleared;
  }

  // Verify a login: match by subject, then check the scrypt hash. Returns the
  // sanitized user on success, or null (unknown subject / no password / wrong
  // password are all indistinguishable to the caller).
  function verifyUserCredentials(username, password) {
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) return null;
    const user = getUserBySubject(username);
    if (!user || !user.passwordHash) return null;
    if (!verifyPassword(password, user.passwordHash)) return null;
    return sanitizeUser(user);
  }

  // Remove one membership. Subject to the same D4 hand-over as a demotion
  // (#2081): removing the LAST team-admin of a team is refused unless a
  // successor already in the team is named, and the promotion rides the same
  // single write as the removal.
  function removeMembership({ userId, teamId, successorUserId } = {}) {
    const memberships = readArray(MEMBERSHIPS_INDEX);
    const remaining = memberships.filter(m => !(m.userId === userId && m.teamId === teamId));
    if (remaining.length === memberships.length) {
      throw notFound(`No membership for user '${userId}' in team '${teamId}'`);
    }
    const plan = succession.planAdminHandover({ memberships, userId, teamId, successorUserId });
    if (!plan.ok) throw conflict(plan.message, plan.code);
    applyPromotion(remaining, plan.promote);
    writeArray(MEMBERSHIPS_INDEX, remaining);
    return { userId, teamId, deleted: true };
  }

  // Drop every membership naming `teamId`, unconditionally. This is the cascade
  // `deleteTeam` performs inline, exposed for the caller that deletes the OTHER
  // kind of team: an **Agent Team** lives as an agent config, so the orchestrator
  // deletes it and this module never hears about it (#2081).
  //
  // Deliberately NOT `removeMembership` in a loop: that path enforces the D4
  // last-admin rule, which exists to stop a team becoming un-administrable — a
  // team that no longer exists cannot be, and the rule would refuse the very
  // clean-up that keeps the index consistent. Returns how many were removed.
  function removeTeamMemberships(teamId) {
    if (!isNonEmptyString(teamId)) return 0;
    const memberships = readArray(MEMBERSHIPS_INDEX);
    const remaining = memberships.filter(m => m.teamId !== teamId);
    const removed = memberships.length - remaining.length;
    if (removed > 0) writeArray(MEMBERSHIPS_INDEX, remaining);
    return removed;
  }

  // ---- bootstrap ----------------------------------------------------------

  // Idempotent: guarantees the default team exists. Every resource that lacks
  // an explicit owner falls back to this team, so it must always be present.
  function ensureDefaultTeam() {
    const existing = getTeam(DEFAULT_TEAM_ID);
    if (existing) return existing;
    const teams = listTeams();
    const team = {
      id: DEFAULT_TEAM_ID,
      name: DEFAULT_TEAM_NAME,
      description: 'Auto-created default team. All resources without an explicit owner belong here.',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    teams.push(team);
    writeArray(TEAMS_INDEX, teams);
    return team;
  }

  // Idempotent: ensures a global System Admin exists for the given subject,
  // creating the user (or promoting an existing one) if necessary. Used to
  // seed an initial operator from environment config so a fresh stack isn't
  // left with zero admins. Returns null when no subject is supplied.
  function ensureSystemAdmin({ subject, email, displayName } = {}) {
    if (!isNonEmptyString(subject)) return null;
    const existing = getUserBySubject(subject);
    if (existing) {
      if (!existing.systemAdmin) return updateUser(existing.id, { systemAdmin: true });
      return existing;
    }
    // A malformed configured seed email must not block seeding the operator
    // (#2695): the address is optional metadata, so it is dropped, not thrown.
    return createUser({ subject, email: isValidEmail(email) ? email : '', displayName, systemAdmin: true });
  }

  // Seeds the very FIRST System Admin from the deployment's configured initial
  // user (#2059, concept #2041 D13). The configured credential is a **seed, not
  // a login**: it is consumed once, on a stack that has zero user records, to
  // create a real user record — and never consulted again. Hence the
  // `listUsers().length > 0` gate rather than `ensureSystemAdmin`'s
  // promote-on-every-boot behaviour: once any record exists, this pass is inert,
  // so re-pointing the variable at a different subject can never mint a second
  // administrator or re-grant one that was deliberately demoted. Recovering a
  // lost identity is a host-level action on `/workspace/users/index.json`, which
  // is the documented break-glass (docs/governance-concept.md GOV-ACCESS-7).
  //
  // A `password` is optional: an SSO stack seeds a subject with none and the
  // person authenticates through the identity-aware proxy. Note that a record
  // WITHOUT a password can never sign in with one (`verifyUserCredentials`
  // requires `passwordHash`), which is exactly the intent there.
  //
  // Returns the sanitized seeded record, or null when nothing was seeded (no
  // subject configured, or the stack already has users).
  function seedInitialSystemAdmin({ subject, password, email, displayName } = {}) {
    if (!isNonEmptyString(subject)) return null;
    if (listUsers().length > 0) return null;
    const user = ensureSystemAdmin({ subject, email, displayName });
    if (!user) return null;
    if (isNonEmptyString(password)) setUserPassword(user.id, password);
    return sanitizeUser(getUser(user.id));
  }

  // Append (user → team) memberships in bulk, for the #2077 D6 migration.
  //
  // Deliberately NOT `setMembership` in a loop, for three reasons:
  //
  //  1. `setMembership` validates `teamId` against `teams/index.json` (:311),
  //     and the whole point of the collapse is that the referent is now an
  //     **Agent Team** id, which this module cannot see (it has no agent
  //     access). The caller has already resolved the target ids from the agent
  //     configs, so this method takes them as given.
  //  2. One write instead of N. A per-entry upsert would rewrite the whole
  //     array N times, and a crash halfway would leave a partial fan-out.
  //  3. It must never CHANGE an existing record. The migration adds reach; a
  //     pre-existing `(userId, teamId)` pair is skipped rather than having its
  //     role overwritten, so a hand-made grant is never silently rewritten.
  //
  // Returns the records actually appended (`[]` on a second run — AC6).
  function appendMemberships(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const memberships = readArray(MEMBERSHIPS_INDEX);
    const seen = new Set(memberships.map(m => `${m && m.userId} ${m && m.teamId}`));
    const added = [];
    for (const e of entries) {
      if (!e || !isNonEmptyString(e.userId) || !isNonEmptyString(e.teamId)) continue;
      if (!MEMBERSHIP_ROLES.includes(e.role)) continue;
      const key = `${e.userId} ${e.teamId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const record = {
        id: crypto.randomUUID(),
        userId: e.userId,
        teamId: e.teamId,
        role: e.role,
        createdAt: nowIso(),
      };
      // Provenance for the collapse (#2077, §8.2): which access scope this
      // grant was derived from. Nothing reads it — it is what makes a migrated
      // membership auditable and distinguishable from one a human made.
      if (isNonEmptyString(e.fromScopeId)) record.fromScopeId = e.fromScopeId;
      memberships.push(record);
      added.push(record);
    }
    if (added.length > 0) writeArray(MEMBERSHIPS_INDEX, memberships);
    return added;
  }

  return {
    DEFAULT_TEAM_ID,
    MEMBERSHIP_ROLES,
    listTeams, getTeam, createTeam, updateTeam, deleteTeam,
    listUsers, getUser, getUserBySubject, createUser, updateUser, deleteUser,
    setUserPassword, clearUserPassword, verifyUserCredentials, sanitizeUser,
    setUserMatrixIdentity,
    clearNonPersonalMatrixIdentities,
    listMemberships, setMembership, removeMembership, removeTeamMemberships, appendMemberships,
    ensureDefaultTeam, ensureSystemAdmin, seedInitialSystemAdmin,
  };
}

// ---- typed errors ---------------------------------------------------------
// `statusHint` lets the HTTP layer map store errors to status codes without
// string-matching messages.

// `code` is optional and carries a stable machine-readable reason next to the
// human message — the D4 refusals need one so a client can tell "name a
// successor" apart from "that successor is not a member" without matching text.
function tagged(message, statusHint, code) {
  const err = new Error(message);
  err.statusHint = statusHint;
  if (code) err.code = code;
  return err;
}
function badRequest(m, code) { return tagged(m, 400, code); }
function notFound(m, code) { return tagged(m, 404, code); }
function conflict(m, code) { return tagged(m, 409, code); }

module.exports = {
  createTeamsStore,
  normalizeGithubHandle,
  coerceGithubHandle,
  coerceChatFontSize,
  coerceChatNotifyOnBack,
  coerceChatListFilter,
  coerceFlowsListFilter,
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_DEFAULT,
  DEFAULT_TEAM_ID,
  DEFAULT_TEAM_NAME,
  MEMBERSHIP_ROLES,
  TEAM_ID_RE,
  isLastSystemAdmin,
  LAST_SYSTEM_ADMIN_DELETE_REASON,
  LAST_SYSTEM_ADMIN_DEMOTE_REASON,
  isValidEmail,
  INVALID_EMAIL_REASON,
};
