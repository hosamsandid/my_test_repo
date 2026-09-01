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
//   /workspace/users/index.json        [{ id, subject, email, displayName, systemAdmin, githubHandle, createdAt, updatedAt }]
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

const DEFAULT_TEAM_ID = 'default';
const DEFAULT_TEAM_NAME = 'Default Team';

const MEMBERSHIP_ROLES = Object.freeze(['team-admin', 'team-member']);

// A team id is an operator-facing slug, same rules as Working Environment ids.
const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

function createTeamsStore({ root } = {}) {
  if (!isNonEmptyString(root)) {
    throw new Error('createTeamsStore: { root } is required');
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

  function createUser({ subject, email, displayName, systemAdmin, githubHandle, chatFontSize } = {}) {
    if (!isNonEmptyString(subject)) {
      throw badRequest('user subject is required');
    }
    if (getUserBySubject(subject)) {
      throw conflict(`User with subject '${subject}' already exists`);
    }
    const users = listUsers();
    const user = {
      id: crypto.randomUUID(),
      subject: subject.trim(),
      email: isNonEmptyString(email) ? email.trim() : '',
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
      user.email = isNonEmptyString(patch.email) ? patch.email.trim() : '';
    }
    if (patch.displayName !== undefined) {
      if (!isNonEmptyString(patch.displayName)) throw badRequest('displayName cannot be empty');
      user.displayName = patch.displayName.trim();
    }
    if (patch.systemAdmin !== undefined) {
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
    user.updatedAt = nowIso();
    users[idx] = user;
    writeArray(USERS_INDEX, users);
    return user;
  }

  // Deletes a user and cascades their memberships.
  function deleteUser(id) {
    const users = listUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) throw notFound(`User '${id}' not found`);
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

  // Upsert: at most one membership per (userId, teamId). Re-asserting updates
  // the role in place rather than creating a duplicate.
  function setMembership({ userId, teamId, role } = {}) {
    if (!isNonEmptyString(userId)) throw badRequest('userId is required');
    if (!isNonEmptyString(teamId)) throw badRequest('teamId is required');
    if (!MEMBERSHIP_ROLES.includes(role)) {
      throw badRequest(`role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`);
    }
    if (!getUser(userId)) throw notFound(`User '${userId}' not found`);
    if (!getTeam(teamId)) throw notFound(`Team '${teamId}' not found`);

    const memberships = readArray(MEMBERSHIPS_INDEX);
    const existing = memberships.find(m => m.userId === userId && m.teamId === teamId);
    if (existing) {
      existing.role = role;
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

  function removeMembership({ userId, teamId } = {}) {
    const memberships = readArray(MEMBERSHIPS_INDEX);
    const remaining = memberships.filter(m => !(m.userId === userId && m.teamId === teamId));
    if (remaining.length === memberships.length) {
      throw notFound(`No membership for user '${userId}' in team '${teamId}'`);
    }
    writeArray(MEMBERSHIPS_INDEX, remaining);
    return { userId, teamId, deleted: true };
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
    return createUser({ subject, email, displayName, systemAdmin: true });
  }

  return {
    DEFAULT_TEAM_ID,
    MEMBERSHIP_ROLES,
    listTeams, getTeam, createTeam, updateTeam, deleteTeam,
    listUsers, getUser, getUserBySubject, createUser, updateUser, deleteUser,
    setUserPassword, clearUserPassword, verifyUserCredentials, sanitizeUser,
    listMemberships, setMembership, removeMembership,
    ensureDefaultTeam, ensureSystemAdmin,
  };
}

// ---- typed errors ---------------------------------------------------------
// `statusHint` lets the HTTP layer map store errors to status codes without
// string-matching messages.

function tagged(message, statusHint) {
  const err = new Error(message);
  err.statusHint = statusHint;
  return err;
}
function badRequest(m) { return tagged(m, 400); }
function notFound(m) { return tagged(m, 404); }
function conflict(m) { return tagged(m, 409); }

module.exports = {
  createTeamsStore,
  normalizeGithubHandle,
  coerceGithubHandle,
  coerceChatFontSize,
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_DEFAULT,
  DEFAULT_TEAM_ID,
  DEFAULT_TEAM_NAME,
  MEMBERSHIP_ROLES,
  TEAM_ID_RE,
};
