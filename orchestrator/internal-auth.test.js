"use strict";

// Unit tests for the :4002 internal-auth decision core (#1456, GOV-PLATFORM-2).
//
// The load-bearing properties, in the order they matter:
//   1. an unconfigured stack is byte-identically permissive (no silent lockout)
//   2. an anonymous caller is refused — this is the whole point of the ticket
//   3. an agent token reaches ONLY the agent-facing allowlist
//   4. an agent token cannot act on ANOTHER agent's :id
//   5. an agent cannot forge, replay-across-secret or escalate to control-plane
//   6. observe/warn produce the SAME verdict enforce would, without acting on it

const test = require("node:test");
const assert = require("node:assert/strict");

const ia = require("./internal-auth");

const CP_TOKEN = "control-plane-secret-value";
const CONFIG = ia.resolveInternalAuthConfig({
  INTERNAL_API_TOKEN: CP_TOKEN,
  INTERNAL_AUTH_MODE: "enforce",
});
const AGENT_TOKEN = ia.mintAgentToken("team-x-developer", CONFIG.agentTokenSecret);

function decide(method, url, headers = {}, config = CONFIG) {
  return ia.decideInternalAuth({ method, url, headers, config });
}
function asAgent(token = AGENT_TOKEN) {
  return { authorization: `Bearer ${token}` };
}
function asConsole() {
  return { authorization: `Bearer ${CP_TOKEN}` };
}

// ── 1. Configuration + the boot refusal ─────────────────────────────────────

test("mode defaults to observe, and only the three ladder rungs are accepted", () => {
  assert.equal(ia.parseAuthMode(undefined), "observe");
  assert.equal(ia.parseAuthMode(""), "observe");
  assert.equal(ia.parseAuthMode("ENFORCE"), "enforce");
  assert.equal(ia.parseAuthMode("warn"), "warn");
  // A typo must not silently become the strictest OR the weakest surprise —
  // it lands on the documented default.
  assert.equal(ia.parseAuthMode("enfroce"), "observe");
});

test("the agent signing secret is DERIVED from the control-plane token, one knob", () => {
  const a = ia.resolveInternalAuthConfig({ INTERNAL_API_TOKEN: "x" });
  const b = ia.resolveInternalAuthConfig({ INTERNAL_API_TOKEN: "x" });
  assert.equal(a.agentTokenSecret, b.agentTokenSecret, "derivation must be deterministic");
  assert.ok(a.agentTokenSecret.length > 0);
  // …and it is NOT the control-plane token itself: an agent holding a token
  // derived from the secret must not be one step from the console's credential.
  assert.notEqual(a.agentTokenSecret, "x");
  const other = ia.resolveInternalAuthConfig({ INTERNAL_API_TOKEN: "y" });
  assert.notEqual(a.agentTokenSecret, other.agentTokenSecret);
});

test("an explicit agent secret overrides the derivation", () => {
  const cfg = ia.resolveInternalAuthConfig({
    INTERNAL_API_TOKEN: "x", INTERNAL_AGENT_TOKEN_SECRET: "explicit",
  });
  assert.equal(cfg.agentTokenSecret, "explicit");
});

test("enforce without a token is refused at BOOT, not at the first request", () => {
  const bad = ia.resolveInternalAuthConfig({ INTERNAL_AUTH_MODE: "enforce" });
  assert.match(ia.bootRefusal(bad), /INTERNAL_API_TOKEN/);
  // observe without a token is the normal pre-adoption state and must be fine.
  assert.equal(ia.bootRefusal(ia.resolveInternalAuthConfig({})), null);
  assert.equal(ia.bootRefusal(CONFIG), null);
});

// ── 2. An unconfigured stack is unchanged ───────────────────────────────────

test("with nothing configured every caller is allowed and tagged as such", () => {
  const cfg = ia.resolveInternalAuthConfig({});
  for (const [method, url] of [["GET", "/internal/agents/processes"], ["DELETE", "/internal/agents/a"]]) {
    const d = decide(method, url, {}, cfg);
    assert.equal(d.allowed, true);
    assert.equal(d.denied, false);
    assert.equal(d.callerKind, "unconfigured");
  }
});

test("an unconfigured stack mints no agent token", () => {
  const cfg = ia.resolveInternalAuthConfig({});
  assert.equal(ia.mintAgentToken("a", cfg.agentTokenSecret), null);
});

// ── 3. Anonymous is refused ─────────────────────────────────────────────────

test("no Authorization header → 401 on every route, agent-facing or not", () => {
  for (const [method, url] of [
    ["GET", "/internal/maintenance-mode"],
    ["POST", "/internal/agents/team-x-developer/status"],
    ["DELETE", "/internal/agents/team-x-developer"],
    ["POST", "/internal/admin/users"],
  ]) {
    const d = decide(method, url);
    assert.equal(d.allowed, false, `${method} ${url}`);
    assert.equal(d.status, 401);
    assert.equal(d.reason, "no-valid-internal-token");
  }
});

test("a garbage or wrong bearer is anonymous, not a caller", () => {
  for (const value of ["Bearer nonsense", "Bearer ", "Basic abc", "", "Bearer aeeagt1.x.y"]) {
    const d = decide("GET", "/internal/maintenance-mode", { authorization: value });
    assert.equal(d.callerKind, "anonymous", `header ${JSON.stringify(value)}`);
  }
});

// ── 4. The control-plane token holds the whole surface ──────────────────────

test("the control-plane token reaches every route, including the destructive ones", () => {
  for (const [method, url] of [
    ["DELETE", "/internal/agents/team-x-developer"],
    ["POST", "/internal/admin/users"],
    ["POST", "/internal/agents/other-agent/enable"],
    ["GET", "/internal/maintenance-mode"],
  ]) {
    const d = decide(method, url, asConsole());
    assert.equal(d.allowed, true, `${method} ${url}`);
    assert.equal(d.callerKind, "console-proxy");
  }
});

test("POST /internal/admin/users/verify — the login backend — stays reachable for the console", () => {
  // auth.js calls this BEFORE any console session exists. It is a
  // service-to-service call, so the control-plane token covers it; if this ever
  // regresses, nobody can log in.
  const d = decide("POST", "/internal/admin/users/verify", asConsole());
  assert.equal(d.allowed, true);
});

// ── 5. The agent allowlist ──────────────────────────────────────────────────

test("an agent reaches its own telemetry, knowledge, triggers, ticket and git routes", () => {
  const own = [
    ["POST", "/internal/agents/team-x-developer/status"],
    ["POST", "/internal/agents/team-x-developer/running-sessions"],
    ["POST", "/internal/agents/team-x-developer/session-events"],
    ["POST", "/internal/agents/team-x-developer/session-pointer"],
    ["POST", "/internal/agents/team-x-developer/usage"],
    ["GET", "/internal/agents/team-x-developer/usage/summary"],
    ["POST", "/internal/agents/team-x-developer/knowledge/push"],
    ["POST", "/internal/agents/team-x-developer/knowledge/retrieval"],
    ["POST", "/internal/agents/team-x-developer/knowledge/nominate"],
    ["GET", "/internal/agents/team-x-developer/config"],
    ["GET", "/internal/agents/team-x-developer/dm-room"],
    ["GET", "/internal/agents/team-x-developer/triggers"],
    ["PUT", "/internal/agents/team-x-developer/triggers"],
    ["POST", "/internal/agents/team-x-developer/triggers/t1/consumed"],
    ["GET", "/internal/agents/team-x-developer/pending-drain"],
    ["GET", "/internal/agents/team-x-developer/pending-drain-one"],
    ["GET", "/internal/agents/team-x-developer/team-roster"],
    ["GET", "/internal/agents/team-x-developer/ticket"],
    ["POST", "/internal/agents/team-x-developer/ticket"],
    ["DELETE", "/internal/agents/team-x-developer/ticket"],
    ["POST", "/internal/agents/team-x-developer/ticket/children"],
    ["POST", "/internal/agents/team-x-developer/git/push"],
    ["POST", "/internal/agents/team-x-developer/git/pr"],
  ];
  for (const [method, url] of own) {
    const d = decide(method, url, asAgent());
    assert.equal(d.allowed, true, `${method} ${url} should be allowed`);
    assert.equal(d.callerKind, "agent");
  }
});

test("an agent reaches the id-less routes that carry their own integrity check", () => {
  for (const [method, url] of [
    ["POST", "/internal/flow-emit"],
    ["POST", "/internal/wake-agent"],
    ["GET", "/internal/loop-verify/verdict?token=abc"],
    ["POST", "/internal/loop-verify/verdict"],
    ["GET", "/internal/maintenance-mode"],
  ]) {
    assert.equal(decide(method, url, asAgent()).allowed, true, `${method} ${url}`);
  }
});

test("the loop-verify hand-off is the ONE route an agent may aim at a sibling", () => {
  // #933 posts the verify request into ANOTHER agent's queue. Narrowing this to
  // `own` would break every loop with a verify.agentId gate — it is a deliberate
  // exception, pinned here so it cannot be tightened by accident either.
  const d = decide("POST", "/internal/agents/some-reviewer/enqueue-pending", asAgent());
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "agent-allowlist:peer");
  // …and it is the only one. Any other cross-agent write must be refused.
  const peers = ia.AGENT_ROUTES.filter((r) => r.scope === "peer");
  assert.equal(peers.length, 1, "exactly one peer-scoped route");
  assert.match(peers[0].pattern.source, /enqueue-pending/);
});

test("an agent is refused on ANOTHER agent's id, on every own-scoped route", () => {
  const ownRoutes = ia.AGENT_ROUTES.filter((r) => r.scope === "own");
  assert.ok(ownRoutes.length >= 20, "sanity: the own-scoped set is not empty");
  for (const route of ownRoutes) {
    // Rebuild a concrete path for the rule from its own pattern source, so a
    // route added later is covered without touching this test.
    let seen = 0;
    const url = route.pattern.source
      .replace(/^\^/, "").replace(/\$$/, "")
      .replace(/\\\//g, "/")
      // First capture group is always the agent id; any further one (only
      // `triggers/:tid/consumed` has one) is filled with a harmless value.
      .replace(/\(\[\^\/\]\+\)/g, () => (seen++ === 0 ? "victim-agent" : "x"));
    const d = decide(route.method, url, asAgent());
    assert.equal(d.allowed, false, `${route.method} ${url} must not be cross-agent`);
    assert.equal(d.reason, "cross-agent-id");
    assert.equal(d.status, 403);
  }
});

test("an agent is refused on the control-plane surface", () => {
  for (const [method, url] of [
    ["DELETE", "/internal/agents/team-x-developer"],       // delete SELF is still not agent-facing
    ["POST", "/internal/agents/team-x-developer/enable"],
    ["POST", "/internal/agents/team-x-developer/disable"],
    ["POST", "/internal/agents/team-x-developer/respawn"],
    ["POST", "/internal/admin/users"],
    ["GET", "/internal/admin/teams"],
    ["POST", "/internal/agents/team-x-developer/plugins/activate"],
    ["POST", "/internal/agents/team-x-developer/skills/activate"],
    ["POST", "/internal/teams/team-x/prompt"],
    ["GET", "/internal/plugins"],
    ["POST", "/internal/agents/import"],
    ["GET", "/internal/agents/processes"],
    ["POST", "/internal/knowledge/autonomy"],
  ]) {
    const d = decide(method, url, asAgent());
    assert.equal(d.allowed, false, `${method} ${url} must not be agent-facing`);
    assert.equal(d.reason, "route-not-agent-facing");
  }
});

test("the allowlist is method-specific — a read-only route is not a write door", () => {
  assert.equal(decide("GET", "/internal/agents/team-x-developer/config", asAgent()).allowed, true);
  assert.equal(decide("PUT", "/internal/agents/team-x-developer/config", asAgent()).allowed, false);
  assert.equal(decide("GET", "/internal/agents/team-x-developer/status", asAgent()).allowed, false);
});

// ── 6. Token integrity ──────────────────────────────────────────────────────

test("a minted token round-trips and is deterministic (free rotation on respawn)", () => {
  const a = ia.mintAgentToken("agent-1", CONFIG.agentTokenSecret);
  const b = ia.mintAgentToken("agent-1", CONFIG.agentTokenSecret);
  assert.equal(a, b, "a respawn must re-mint the identical token");
  assert.equal(ia.verifyAgentToken(a, CONFIG.agentTokenSecret), "agent-1");
});

test("a token minted under a different secret is rejected — the rotation lever", () => {
  const other = ia.resolveInternalAuthConfig({ INTERNAL_API_TOKEN: "rotated" });
  const stale = ia.mintAgentToken("agent-1", CONFIG.agentTokenSecret);
  assert.equal(ia.verifyAgentToken(stale, other.agentTokenSecret), null);
});

test("the id half cannot be swapped without the signature — no impersonation", () => {
  const token = ia.mintAgentToken("agent-1", CONFIG.agentTokenSecret);
  const [prefix, , sig] = token.split(".");
  const forged = `${prefix}.${Buffer.from("agent-2", "utf8").toString("base64url")}.${sig}`;
  assert.equal(ia.verifyAgentToken(forged, CONFIG.agentTokenSecret), null);
});

test("a malformed token never throws — it is just not a caller", () => {
  for (const bad of [null, "", "a", "a.b", "a.b.c.d", "aeeagt1..sig", "wrongprefix.aQ.sig", 42, {}]) {
    assert.equal(ia.verifyAgentToken(bad, CONFIG.agentTokenSecret), null, String(bad));
  }
});

test("an agent token is not accepted as the control-plane token, and vice versa", () => {
  assert.equal(decide("POST", "/internal/admin/users", asAgent()).callerKind, "agent");
  // The console's own token is not an agent token, so it never lands in the
  // agent branch and never gets narrowed by the allowlist.
  assert.equal(ia.verifyAgentToken(CP_TOKEN, CONFIG.agentTokenSecret), null);
});

// ── 7. Path normalisation ───────────────────────────────────────────────────

test("a query string does not change the route decision", () => {
  assert.equal(decide("GET", "/internal/agents/team-x-developer/usage/summary?days=7", asAgent()).allowed, true);
  assert.equal(decide("GET", "/internal/agents/victim/usage/summary?days=7", asAgent()).allowed, false);
});

test("percent-encoding cannot smuggle a foreign id past the own-id check", () => {
  // The agent id is compared AFTER decoding, so the encoded and plain forms
  // agree — an encoded own id passes, an encoded foreign id still fails.
  const encodedSelf = "/internal/agents/team-x-developer/status";
  assert.equal(decide("POST", encodedSelf, asAgent()).allowed, true);
  const encodedOther = `/internal/agents/${encodeURIComponent("victim agent")}/status`;
  assert.equal(decide("POST", encodedOther, asAgent()).allowed, false);
});

test("an undecodable path is refused rather than treated as unmatched-but-fine", () => {
  const d = decide("POST", "/internal/agents/%E0%A4%A/status", asAgent());
  assert.equal(d.allowed, false);
});

// ── 8. The ladder ───────────────────────────────────────────────────────────

test("observe and warn reach the SAME verdict as enforce but do not act on it", () => {
  for (const mode of ["observe", "warn"]) {
    const cfg = ia.resolveInternalAuthConfig({ INTERNAL_API_TOKEN: CP_TOKEN, INTERNAL_AUTH_MODE: mode });
    const token = ia.mintAgentToken("team-x-developer", cfg.agentTokenSecret);
    const d = decide("DELETE", "/internal/agents/victim", { authorization: `Bearer ${token}` }, cfg);
    assert.equal(d.allowed, false, `${mode}: the verdict is the same`);
    assert.equal(d.denied, false, `${mode}: but nothing is rejected`);
    assert.equal(d.reason, "route-not-agent-facing");
    // …and the enforce run on the identical input denies, which is what makes
    // the observe census a truthful preview.
    const enforced = decide("DELETE", "/internal/agents/victim", { authorization: `Bearer ${token}` });
    assert.equal(enforced.denied, true);
  }
});

test("the census line names the caller, the route and the reason", () => {
  const d = decide("DELETE", "/internal/agents/victim", asAgent());
  const line = ia.describeDecision(d, { method: "DELETE" });
  assert.match(line, /caller=agent\(team-x-developer\)/);
  assert.match(line, /DELETE \/internal\/agents\/victim/);
  assert.match(line, /reason=route-not-agent-facing/);
  assert.match(line, /verdict=deny/);
  // An observe-mode line has to be distinguishable from a real denial, or the
  // census reads as an outage.
  const observeCfg = ia.resolveInternalAuthConfig({ INTERNAL_API_TOKEN: CP_TOKEN });
  const token = ia.mintAgentToken("team-x-developer", observeCfg.agentTokenSecret);
  const obs = decide("DELETE", "/internal/agents/victim", { authorization: `Bearer ${token}` }, observeCfg);
  assert.match(ia.describeDecision(obs, { method: "DELETE" }), /verdict=would-deny/);
});

// ── 9. Non-vacuity ──────────────────────────────────────────────────────────

test("the allowlist is not accidentally empty or accidentally universal", () => {
  assert.ok(ia.AGENT_ROUTES.length >= 25, "the allowlist has real entries");
  // No entry may be an unanchored or open-ended pattern — one `/internal/.*`
  // would silently hand an agent the whole surface and every test above would
  // still pass except this one.
  for (const route of ia.AGENT_ROUTES) {
    const src = route.pattern.source;
    assert.ok(src.startsWith("^\\/internal\\/"), `anchored at /internal/: ${src}`);
    assert.ok(src.endsWith("$"), `anchored at the end: ${src}`);
    assert.ok(!src.includes(".*"), `no wildcard segment: ${src}`);
    assert.ok(["own", "any", "peer"].includes(route.scope), `known scope: ${route.scope}`);
  }
});
